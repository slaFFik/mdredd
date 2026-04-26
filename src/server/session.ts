import { join } from 'node:path';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { atomicWriteJson, ensureDir, isNotFound, pathExists, readJsonIfExists } from './fsUtil.js';
import { SESSION_FILE, GITIGNORE_FILE, LOCK_FILE } from '@shared/constants.js';
import {
  makeDefaultSession,
  type ColumnConfig,
  type SessionFile,
  SessionFileSchema,
} from '@shared/schemas/session.js';
import type { RunConfig } from '@shared/schemas/run.js';
import type { TranscriptFile } from '@shared/schemas/run.js';
import { NormalizedEventSchema, type NormalizedEvent } from '@shared/schemas/events.js';
import type { JudgeFile } from '@shared/schemas/judge.js';
import { log } from './log.js';

export interface SessionSnapshot {
  session: SessionFile;
  runs: Record<string, RunBundle>;      // keyed by runFolder (not column id)
}

export interface RunBundle {
  config: RunConfig;
  transcript: TranscriptFile | null;    // may be absent for in-flight (preparing) at boot
  judge: JudgeFile | null;
  outputs: Array<{ path: string; bytes: number }>;
}

export class SessionStore {
  private readonly storageRoot: string;
  private session: SessionFile;

  constructor(storageRoot: string, session: SessionFile) {
    this.storageRoot = storageRoot;
    this.session = session;
  }

  static async load(storageRoot: string, cwd: string): Promise<SessionStore> {
    await ensureDir(storageRoot);
    const sessionPath = join(storageRoot, SESSION_FILE);
    const raw = await readJsonIfExists<unknown>(sessionPath);
    let session: SessionFile;
    if (raw) {
      const parsed = SessionFileSchema.safeParse(raw);
      if (parsed.success) {
        session = parsed.data;
        // Migrate cwd if user moved the project; non-fatal.
        if (session.cwd !== cwd) session.cwd = cwd;
      } else {
        log.warn('session.parse-failed-resetting', {
          issues: parsed.error.issues.map((i) => i.path.join('.') + ': ' + i.message),
        });
        session = makeDefaultSession(cwd);
      }
    } else {
      session = makeDefaultSession(cwd);
    }
    const store = new SessionStore(storageRoot, session);
    await store.persist();
    return store;
  }

  get snapshot(): SessionFile {
    return JSON.parse(JSON.stringify(this.session)) as SessionFile;
  }

  async mutate(fn: (s: SessionFile) => void): Promise<SessionFile> {
    fn(this.session);
    await this.persist();
    return this.snapshot;
  }

  async setColumnField<K extends keyof ColumnConfig>(
    columnId: string,
    key: K,
    value: ColumnConfig[K],
  ): Promise<void> {
    const col = this.session.columns.find((c) => c.id === columnId);
    if (!col) throw new Error(`unknown column id: ${columnId}`);
    col[key] = value;
    await this.persist();
  }

  async assembleSnapshot(): Promise<SessionSnapshot> {
    const runs: Record<string, RunBundle> = {};
    if (await pathExists(this.storageRoot)) {
      const entries = await readdir(this.storageRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const bundle = await this.readRunBundle(entry.name);
        if (bundle) runs[entry.name] = bundle;
      }
    }
    return { session: this.snapshot, runs };
  }

  async readRunBundle(runFolder: string): Promise<RunBundle | null> {
    const runDir = join(this.storageRoot, runFolder);
    const config = await readJsonIfExists<RunConfig>(join(runDir, 'config.json'));
    if (!config) return null;
    // Prefer the finalized transcript.json. For in-flight runs (or harness
    // crash recovery) it doesn't exist yet — replay the append-only
    // transcript.ndjson prefix so /api/state still surfaces evidence so far
    // (issue #10).
    let transcript = await readJsonIfExists<TranscriptFile>(join(runDir, 'transcript.json'));
    if (!transcript) {
      transcript = await readPartialTranscript(runDir, config);
    }
    const judge = await readJsonIfExists<JudgeFile>(join(runDir, 'judge.json'));
    const outputs = await this.listOutputs(join(runDir, 'outputs'));
    return { config, transcript, judge, outputs };
  }

  private async listOutputs(dir: string): Promise<Array<{ path: string; bytes: number }>> {
    if (!(await pathExists(dir))) return [];
    const out: Array<{ path: string; bytes: number }> = [];
    const walk = async (cur: string, prefix: string): Promise<void> => {
      const entries = await readdir(cur, { withFileTypes: true });
      for (const e of entries) {
        const full = join(cur, e.name);
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) {
          await walk(full, rel);
        } else if (e.isFile()) {
          const { stat } = await import('node:fs/promises');
          const s = await stat(full);
          out.push({ path: rel, bytes: s.size });
        }
      }
    };
    try {
      await walk(dir, '');
    } catch (err) {
      log.warn('session.outputs-walk-failed', { error: (err as Error).message });
    }
    return out;
  }

  async startNew(): Promise<void> {
    const entries = await readdir(this.storageRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === GITIGNORE_FILE || entry.name === LOCK_FILE) continue;
      await rm(join(this.storageRoot, entry.name), { recursive: true, force: true });
    }
    this.session = makeDefaultSession(this.session.cwd);
    await this.persist();
  }

  private async persist(): Promise<void> {
    await atomicWriteJson(join(this.storageRoot, SESSION_FILE), this.session);
  }
}

// Suppress unused import — writeFile is reserved for potential future atomic-patch paths.
void writeFile;

/**
 * Reconstruct a partial TranscriptFile from the append-only `transcript.ndjson`
 * log. Used for in-flight runs (and crash recovery) before runner.finalize()
 * has written the canonical transcript.json. Best-effort: malformed lines are
 * skipped so a torn final write can't black-hole the whole prefix.
 */
async function readPartialTranscript(
  runDir: string,
  config: RunConfig,
): Promise<TranscriptFile | null> {
  let raw: string;
  try {
    raw = await readFile(join(runDir, 'transcript.ndjson'), 'utf8');
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  const events: NormalizedEvent[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // tolerate a torn last line (process killed mid-write)
      continue;
    }
    // Schema-validate so a future event-shape change or a corrupted line
    // can't poison the whole transcript view; bad lines are dropped.
    const result = NormalizedEventSchema.safeParse(parsed);
    if (result.success) events.push(result.data);
  }
  return {
    runFolder: config.runFolder,
    events,
    status: config.status,
    startedAt: config.startedAt,
    endedAt: config.endedAt,
    turnCount: config.turnCount,
    wallClockMs: config.wallClockMs,
    truncationReason: config.truncationReason,
  };
}

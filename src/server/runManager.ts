import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Runner } from './runner.js';
import { buildSandbox } from './sandbox.js';
import { deriveSlug, listRunFolderNames } from './slug.js';
import { runJudge } from './judge.js';
import { SessionStore } from './session.js';
import { log } from './log.js';
import { readFile, readdir, rm } from 'node:fs/promises';
import { atomicWriteJson, isNotFound, readJsonIfExists } from './fsUtil.js';
import type { RunConfig, TranscriptFile } from '@shared/schemas/run.js';
import type { NormalizedEvent, ServerSseEvent } from '@shared/schemas/events.js';
import type { Mode, RunStatus } from '@shared/schemas/types.js';
import type { ColumnConfig } from '@shared/schemas/session.js';
import {
  DEFAULT_TURN_CAP,
  DEFAULT_WALLCLOCK_CAP_MS,
  RUN_CONFIG_FILE,
  RUN_TRANSCRIPT_FILE,
  RUN_VARIANT_FILE,
  defaultEffortForModel,
} from '@shared/constants.js';

const SEQ_FILE = '.seq';
const RING_BUFFER_LIMIT = 2_000;
// Lower-bound the gap between .seq writes. With Claude streaming many
// `run.partial` events per second, an unthrottled atomicWriteJson loop
// (tmp-file + rename per write) would chew real disk; 250ms keeps post-crash
// gap small without dominating I/O during bursty turns.
const SEQ_PERSIST_MIN_INTERVAL_MS = 250;

export interface RunManagerOptions {
  claudeBin: string;
  cwd: string;
  storageRoot: string;
  session: SessionStore;
}

export interface SseSubscriber {
  onEvent(event: ServerSseEvent): void;
  onClose(): void;
  lastEventId: number;
}

export class RunManager extends EventEmitter {
  private readonly opts: RunManagerOptions;
  private readonly active = new Map<string, Runner>(); // columnId → runner
  private readonly ring: ServerSseEvent[] = [];
  private readonly subscribers = new Set<SseSubscriber>();
  private seq = 0;
  private seqDirty = false;
  private seqWriting = false;
  private seqLastWriteAt = 0;
  private seqDeferredTimer: NodeJS.Timeout | null = null;

  constructor(opts: RunManagerOptions) {
    super();
    this.opts = opts;
  }

  async init(): Promise<void> {
    const persisted = await readJsonIfExists<{ seq: number }>(
      join(this.opts.storageRoot, SEQ_FILE),
    );
    // .seq used to be persisted only every 25 events; the in-memory seq is
    // now flushed (debounced) on every emit, but a hard kill between the
    // last write and the next emit could still leave a small gap. Advance
    // past the whole ring buffer on restart so post-crash seqs cannot
    // collide with Last-Event-ID values clients still hold — otherwise the
    // SSE resume-from-ring filter (`e.seq > sub.lastEventId`) would skip
    // legitimately new events. Issue #10.
    this.seq = (persisted?.seq ?? 0) + RING_BUFFER_LIMIT;
    await this.reapStaleRuns();
  }

  /**
   * Rewrite any run still marked `preparing`/`streaming` on disk (i.e. the
   * harness died mid-run on a previous boot) as `errored`, so the UI doesn't
   * display a forever-running spinner. The ndjson prefix stays on disk so
   * the user can still see what evidence had been captured. Issue #10.
   */
  private async reapStaleRuns(): Promise<void> {
    let entries;
    try {
      entries = await readdir(this.opts.storageRoot, { withFileTypes: true });
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const runDir = join(this.opts.storageRoot, entry.name);
      const config = await readJsonIfExists<RunConfig>(join(runDir, RUN_CONFIG_FILE));
      if (!config) continue;
      if (config.status !== 'preparing' && config.status !== 'streaming') continue;
      config.status = 'errored';
      config.errorMessage = config.errorMessage ?? 'harness exited mid-run';
      config.endedAt = config.endedAt ?? new Date().toISOString();
      try {
        await atomicWriteJson(join(runDir, RUN_CONFIG_FILE), config);
        log.info('runManager.reap-stale-run', { runFolder: entry.name });
      } catch (err) {
        log.warn('runManager.reap-stale-run-failed', {
          runFolder: entry.name,
          error: (err as Error).message,
        });
      }
    }
  }

  hasActive(): boolean {
    return this.active.size > 0;
  }

  activeCount(): number {
    return this.active.size;
  }

  isColumnActive(columnId: string): boolean {
    return this.active.has(columnId);
  }

  getActiveStatus(columnId: string): RunStatus | 'idle' {
    const r = this.active.get(columnId);
    if (!r) return 'idle';
    return 'streaming';
  }

  /**
   * Terminate every active runner and wait for finalize() (transcript write +
   * 'ended' emit) to complete. Bounded by `timeoutMs` so a stuck child cannot
   * block server shutdown indefinitely. Returns whether the timeout fired.
   *
   * Each runner already SIGKILLs its child after a 2s grace, so a 5s outer
   * timeout is generous; the timeout exists for pathological cases (filesystem
   * stalls during transcript write, etc.).
   */
  async stopAll(timeoutMs: number = 5000): Promise<{ stopped: number; timedOut: boolean }> {
    const runners = Array.from(this.active.values());
    if (runners.length === 0) {
      await this.flushSeqNow();
      return { stopped: 0, timedOut: false };
    }
    log.info('runManager.stopAll', { count: runners.length, timeoutMs });
    const drain = Promise.all(
      runners.map(async (r) => {
        try {
          await r.stop();
          await r.wait();
        } catch (err) {
          log.warn('runManager.stopAll-runner-failed', { error: (err as Error).message });
        }
      }),
    );
    let timedOut = false;
    await Promise.race([
      drain.then(() => undefined),
      new Promise<void>((resolve) => {
        setTimeout(() => {
          timedOut = true;
          resolve();
        }, timeoutMs);
      }),
    ]);
    // Flush latest seq to disk before the process exits, so a client that
    // reconnects against the next harness boot lines up cleanly.
    await this.flushSeqNow();
    return { stopped: runners.length, timedOut };
  }

  subscribe(sub: SseSubscriber): () => void {
    this.subscribers.add(sub);
    // Replay any events with seq > sub.lastEventId that are still in the ring buffer.
    if (sub.lastEventId > 0) {
      for (const e of this.ring) {
        if (e.seq > sub.lastEventId) sub.onEvent(e);
      }
    }
    return () => {
      this.subscribers.delete(sub);
      sub.onClose();
    };
  }

  private emitSse(event: Omit<ServerSseEvent, 'seq'>): ServerSseEvent {
    this.seq += 1;
    const full = { ...event, seq: this.seq } as ServerSseEvent;
    this.ring.push(full);
    if (this.ring.length > RING_BUFFER_LIMIT)
      this.ring.splice(0, this.ring.length - RING_BUFFER_LIMIT);
    for (const sub of this.subscribers) {
      try {
        sub.onEvent(full);
      } catch (err) {
        log.warn('runManager.sub-emit-error', { error: (err as Error).message });
      }
    }
    this.schedulePersistSeq();
    return full;
  }

  /**
   * Persist seq with two layers of coalescing:
   *  - at most one atomic write in flight (single-flight),
   *  - a SEQ_PERSIST_MIN_INTERVAL_MS floor between successive writes so a
   *    `run.partial` storm doesn't translate to one tmp-file+rename per
   *    delta.
   * On `seqDirty` arriving while throttled, a single deferred timer is
   * scheduled to flush after the floor elapses; further dirty marks coalesce
   * into that pending flush. Bounds post-crash gap to ~250ms of events.
   */
  private schedulePersistSeq(): void {
    this.seqDirty = true;
    if (this.seqWriting) return;
    const now = Date.now();
    const sinceLast = now - this.seqLastWriteAt;
    if (sinceLast < SEQ_PERSIST_MIN_INTERVAL_MS) {
      if (this.seqDeferredTimer === null) {
        this.seqDeferredTimer = setTimeout(() => {
          this.seqDeferredTimer = null;
          this.startSeqWrite();
        }, SEQ_PERSIST_MIN_INTERVAL_MS - sinceLast);
        this.seqDeferredTimer.unref();
      }
      return;
    }
    this.startSeqWrite();
  }

  private startSeqWrite(): void {
    if (this.seqWriting || !this.seqDirty) return;
    this.seqWriting = true;
    void this.flushSeq();
  }

  private async flushSeq(): Promise<void> {
    while (this.seqDirty) {
      this.seqDirty = false;
      const current = this.seq;
      try {
        await atomicWriteJson(join(this.opts.storageRoot, SEQ_FILE), { seq: current });
        this.seqLastWriteAt = Date.now();
      } catch (err) {
        log.warn('runManager.seq-persist-failed', { error: (err as Error).message });
      }
    }
    this.seqWriting = false;
    // If more events came in mid-write while throttled, reschedule.
    if (this.seqDirty) this.schedulePersistSeq();
  }

  /**
   * Force-flush any pending seq write. Called on graceful shutdown so the
   * latest seq value lands on disk before the process exits.
   */
  async flushSeqNow(): Promise<void> {
    if (this.seqDeferredTimer !== null) {
      clearTimeout(this.seqDeferredTimer);
      this.seqDeferredTimer = null;
    }
    if (!this.seqDirty && !this.seqWriting) return;
    if (this.seqWriting) {
      // Wait for the in-flight write to drain; flushSeq's loop will pick up
      // any remaining seqDirty marks before resolving.
      while (this.seqWriting) {
        await new Promise((r) => setTimeout(r, 5));
      }
      return;
    }
    this.seqWriting = true;
    await this.flushSeq();
  }

  emitHeartbeat(): void {
    this.emitSse({ t: 'server.heartbeat' } as Omit<ServerSseEvent, 'seq'>);
  }

  async startColumn(columnId: string): Promise<RunConfig> {
    if (this.active.has(columnId)) {
      throw new RunManagerError(
        'column-already-running',
        `column ${columnId} is already running`,
        409,
      );
    }
    const sessionSnap = this.opts.session.snapshot;
    const colIdx = sessionSnap.columns.findIndex((c) => c.id === columnId);
    const col = sessionSnap.columns[colIdx];
    if (!col) throw new RunManagerError('column-not-found', `unknown column ${columnId}`, 404);

    validateColumnReady(col);

    if (sessionSnap.columns.some((c) => c.currentRunFolder && this.active.has(c.id))) {
      // The plan locks editing while any column is non-terminal; this guard covers the API surface.
    }

    const existingFolders = await listRunFolderNames(this.opts.storageRoot);
    const slug = deriveSlug(
      {
        explicitName: col.variantName,
        variantContent: col.variantContent,
        columnIndex: colIdx + 1,
      },
      existingFolders,
    );

    const sandbox = await buildSandbox({
      cwd: this.opts.cwd,
      storageRoot: this.opts.storageRoot,
      runFolder: slug.folderName,
      variantType: col.variantType,
      skillOrAgentName: col.skillOrAgentName,
      variantContent: col.variantContent,
      mode: sessionSnap.mode,
    });

    const initialConfig: RunConfig = {
      runFolder: slug.folderName,
      columnId,
      variantName: col.variantName || slug.slugBase,
      variantType: col.variantType,
      skillOrAgentName: col.skillOrAgentName,
      variantContentSha256: sha256(col.variantContent),
      promptSha256: sha256(col.prompt),
      prompt: col.prompt,
      model: col.model,
      // Fall back to the model's default effort for legacy session.json files
      // (written before this field existed) so a Run never goes out without
      // an effort the UI showed as selected.
      effort: col.effort ?? defaultEffortForModel(col.model),
      mode: sessionSnap.mode,
      status: 'preparing',
      startedAt: new Date().toISOString(),
      endedAt: null,
      turnCount: 0,
      wallClockMs: 0,
      truncationReason: null,
      exitCode: null,
      signal: null,
      errorMessage: null,
      toolAllowlist: [],
      caps: { turns: DEFAULT_TURN_CAP, wallClockMs: DEFAULT_WALLCLOCK_CAP_MS },
    };

    const runner = new Runner({
      claudeBin: this.opts.claudeBin,
      projectDir: sandbox.projectDir,
      runDir: sandbox.runDir,
      outputsDir: sandbox.outputsDir,
      prompt: col.prompt,
      model: col.model,
      effort: col.effort ?? defaultEffortForModel(col.model),
      mode: sessionSnap.mode as Mode,
      userScopeEnabled: sessionSnap.userScopeEnabled,
      initialConfig,
    });

    this.active.set(columnId, runner);
    const previousRunFolder = col.currentRunFolder;
    await this.opts.session.setColumnField(columnId, 'currentRunFolder', slug.folderName);
    if (previousRunFolder && previousRunFolder !== slug.folderName) {
      // Re-running a column replaces its only displayed run; nuke the prior
      // folder so we don't accumulate orphans the UI can never reach. Best
      // effort — a permission failure logs but does not abort the new run.
      const dir = join(this.opts.storageRoot, previousRunFolder);
      try {
        await rm(dir, { recursive: true, force: true });
      } catch (err) {
        log.warn('runManager.previous-folder-cleanup-failed', {
          runFolder: previousRunFolder,
          error: (err as Error).message,
        });
      }
    }

    this.emitSse({
      t: 'run.started',
      col: columnId,
      runFolder: slug.folderName,
    } as Omit<ServerSseEvent, 'seq'>);
    this.emitSse({
      t: 'column.statusChanged',
      col: columnId,
      status: 'preparing',
      runFolder: slug.folderName,
    } as Omit<ServerSseEvent, 'seq'>);

    runner.on('normalized', (e: NormalizedEvent) => {
      this.normalizedToSse(columnId, e);
    });
    runner.on('statusChanged', (status) => {
      this.emitSse({
        t: 'column.statusChanged',
        col: columnId,
        status,
        runFolder: slug.folderName,
      } as Omit<ServerSseEvent, 'seq'>);
    });
    runner.on('outputs', (files) => {
      this.emitSse({
        t: 'run.outputs',
        col: columnId,
        files,
      } as Omit<ServerSseEvent, 'seq'>);
    });
    runner.on('ended', (cfg) => {
      this.active.delete(columnId);
      this.emitSse({
        t: 'run.ended',
        col: columnId,
        status: cfg.status,
        reason: cfg.truncationReason ?? cfg.errorMessage ?? undefined,
      } as Omit<ServerSseEvent, 'seq'>);
      if (sessionSnap.judgeEnabled && (cfg.status === 'completed' || cfg.status === 'truncated')) {
        // Zero turns means the model never streamed (e.g. `claude -p` returning
        // "Unknown command: /foo" with num_turns=0). Firing the judge would bill
        // tokens to score an empty transcript and surface a misleading score.
        if (cfg.turnCount > 0) {
          void this.fireJudge(columnId, cfg, slug.folderName);
        } else {
          log.info('runManager.judge-skipped-zero-turns', {
            columnId,
            runFolder: slug.folderName,
            status: cfg.status,
          });
        }
      }
    });

    await runner.start();
    return runner['input'].initialConfig;
  }

  async stopColumn(columnId: string): Promise<void> {
    const runner = this.active.get(columnId);
    if (!runner)
      throw new RunManagerError('column-not-running', `column ${columnId} is not running`, 409);
    await runner.stop();
  }

  private normalizedToSse(columnId: string, e: NormalizedEvent): void {
    switch (e.t) {
      case 'turn':
        this.emitSse({ t: 'run.turn', col: columnId, turn: e.turn } as Omit<ServerSseEvent, 'seq'>);
        return;
      case 'partial':
        this.emitSse({ t: 'run.partial', col: columnId, chunk: e.chunk, kind: e.kind } as Omit<
          ServerSseEvent,
          'seq'
        >);
        return;
      case 'message':
        this.emitSse({ t: 'run.message', col: columnId, role: e.role, content: e.content } as Omit<
          ServerSseEvent,
          'seq'
        >);
        return;
      case 'toolUse':
        this.emitSse({
          t: 'run.toolUse',
          col: columnId,
          tool: e.tool,
          argsSummary: e.argsSummary,
        } as Omit<ServerSseEvent, 'seq'>);
        return;
      case 'toolResult':
        this.emitSse({
          t: 'run.toolResult',
          col: columnId,
          tool: e.tool,
          resultSummary: e.resultSummary,
          isError: e.isError,
        } as Omit<ServerSseEvent, 'seq'>);
        return;
      case 'permissionDenied':
        this.emitSse({
          t: 'run.permissionDenied',
          col: columnId,
          tool: e.tool,
          path: e.path,
        } as Omit<ServerSseEvent, 'seq'>);
        return;
    }
  }

  private async fireJudge(columnId: string, cfg: RunConfig, runFolder: string): Promise<void> {
    this.emitSse({ t: 'judge.started', col: columnId, runFolder } as Omit<ServerSseEvent, 'seq'>);
    const runDir = join(this.opts.storageRoot, runFolder);
    const transcript = await readJsonIfExists<TranscriptFile>(join(runDir, RUN_TRANSCRIPT_FILE));
    if (!transcript) {
      this.emitSse({
        t: 'judge.errored',
        col: columnId,
        runFolder,
        error: `${RUN_TRANSCRIPT_FILE} missing`,
      } as Omit<ServerSseEvent, 'seq'>);
      return;
    }
    const variantPath = join(runDir, RUN_VARIANT_FILE);
    const variantContent = await readFile(variantPath, 'utf8').catch(() => '');
    const bundle = await this.opts.session.readRunBundle(runFolder);
    const outputs = bundle?.outputs ?? [];
    try {
      const judgeFile = await runJudge({
        claudeBin: this.opts.claudeBin,
        runDir,
        runConfig: cfg,
        transcript,
        variantContent,
        outputs,
        judgeModel: this.opts.session.snapshot.judgeModel,
      });
      if (judgeFile.status === 'ok') {
        this.emitSse({
          t: 'judge.updated',
          col: columnId,
          payload: judgeFile,
        } as Omit<ServerSseEvent, 'seq'>);
      } else {
        this.emitSse({
          t: 'judge.errored',
          col: columnId,
          runFolder,
          error: judgeFile.error ?? 'unknown error',
        } as Omit<ServerSseEvent, 'seq'>);
      }
    } catch (err) {
      this.emitSse({
        t: 'judge.errored',
        col: columnId,
        runFolder,
        error: (err as Error).message,
      } as Omit<ServerSseEvent, 'seq'>);
    }
  }
}

export class RunManagerError extends Error {
  code: string;
  httpStatus: number;
  constructor(code: string, message: string, httpStatus = 400) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function validateColumnReady(col: ColumnConfig): void {
  if (!col.prompt.trim()) {
    throw new RunManagerError('prompt-empty', 'Prompt is empty', 400);
  }
  if (col.variantType !== 'CLAUDE.md' && !col.skillOrAgentName) {
    throw new RunManagerError(
      'skill-agent-name-missing',
      `${col.variantType} variants need a name`,
      400,
    );
  }
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathExists, atomicWriteFile, ensureDir, readJsonIfExists } from './fsUtil.js';
import { PROJECT_MARKERS, STORAGE_DIR_NAME } from '@shared/constants.js';
import { readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import lockfile from 'proper-lockfile';
import { log } from './log.js';

const execFileAsync = promisify(execFile);

export interface PreflightInput {
  cwd: string;
  claudeBin: string;
  force?: boolean;
}

export interface PreflightResult {
  storageRoot: string;
  lockFilePath: string;
  releaseLock: () => Promise<void>;
}

// Threshold (ms) past which a lockfile is considered stale and may be
// reclaimed. proper-lockfile refreshes the lockfile's mtime every stale/2
// while the holder is alive; after a crash it is reclaimable after `stale` ms.
// Set generously: a long event-loop stall, debugger pause, or brief system
// sleep should not cause a second invocation to consider the lock stale and
// race with the original — that would defeat the single-instance guarantee.
// Users can always reclaim manually via the hint in `instance-running`.
const LOCK_STALE_MS = 5 * 60_000;

export class PreflightError extends Error {
  code: string;
  hint: string | undefined;
  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

export async function runPreflight(input: PreflightInput): Promise<PreflightResult> {
  await checkClaudeCli(input.claudeBin);
  // No live API ping: an upstream hiccup would block startup gate-zero, and
  // anyone running mdredd has already exercised `claude` at least once. If
  // auth is broken, the first run's stderr surfaces in the UI via SSE.
  const storageRoot = join(homedir(), STORAGE_DIR_NAME);
  await cwdGuard(input.cwd, input.force ?? false, storageRoot);
  const lockFilePath = join(storageRoot, '.lock');
  await ensureDir(storageRoot);
  await ensureAutoGitignore(storageRoot);
  const releaseLock = await acquireLock(storageRoot, lockFilePath);
  await recoverAbandonedRuns(storageRoot);
  return { storageRoot, lockFilePath, releaseLock };
}

async function checkClaudeCli(bin: string): Promise<void> {
  try {
    const { stdout } = await execFileAsync(bin, ['--version'], { timeout: 5_000 });
    const trimmed = stdout.trim();
    log.info('preflight.claude-version', { version: trimmed });
  } catch {
    throw new PreflightError(
      'claude-missing',
      `Could not execute ${bin} --version.`,
      'Install Claude Code (https://www.anthropic.com/claude-code) and ensure `claude` is on PATH, or set CLAUDE_BIN.',
    );
  }

  try {
    const { stdout } = await execFileAsync(bin, ['--help'], { timeout: 5_000 });
    const required = [
      '--output-format',
      '--include-partial-messages',
      '--tools',
      '--allowedTools',
      '--strict-mcp-config',
      '--setting-sources',
      '--model',
      '--effort',
      '--json-schema',
    ];
    const missing = required.filter((flag) => !stdout.includes(flag));
    if (missing.length) {
      throw new PreflightError(
        'claude-flags-missing',
        `This claude CLI does not support required flags: ${missing.join(', ')}`,
        'Upgrade Claude Code to the latest version.',
      );
    }
  } catch (err) {
    if (err instanceof PreflightError) throw err;
    throw new PreflightError(
      'claude-help-failed',
      `Could not read ${bin} --help output.`,
      'Try running `claude --help` manually and report the error.',
    );
  }
}

async function cwdGuard(cwd: string, force: boolean, storageRoot: string): Promise<void> {
  const home = homedir();
  if (cwd === home) {
    throw new PreflightError(
      'cwd-home',
      'Refusing to run mdredd from your home directory.',
      'cd into a project directory (one with .git/, package.json, etc.) and try again.',
    );
  }
  if (cwd === '/' || cwd === '/root') {
    throw new PreflightError(
      'cwd-root',
      'Refusing to run mdredd from the root filesystem.',
      'cd into a project directory and try again.',
    );
  }

  // Refuse if cwd is at or under the global mdredd storage directory.
  if (cwd === storageRoot || cwd.startsWith(storageRoot + '/')) {
    throw new PreflightError(
      'cwd-inside-storage',
      `Refusing to run mdredd from inside the storage directory (${storageRoot}).`,
      'cd into the project root and try again.',
    );
  }

  if (force) return;

  const hasMarker = await anyExists(PROJECT_MARKERS.map((m) => join(cwd, m)));
  if (!hasMarker) {
    throw new PreflightError(
      'cwd-no-marker',
      `No project marker (${PROJECT_MARKERS.join(', ')}) found at ${cwd}.`,
      'Run mdredd from a project root, or pass --force.',
    );
  }
}

async function anyExists(paths: string[]): Promise<boolean> {
  for (const p of paths) {
    if (await pathExists(p)) return true;
  }
  return false;
}

async function ensureAutoGitignore(storageRoot: string): Promise<void> {
  const gitignorePath = join(storageRoot, '.gitignore');
  if (await pathExists(gitignorePath)) return;
  await atomicWriteFile(gitignorePath, '*\n!.gitignore\n');
}

function lockMetaPath(lockFilePath: string): string {
  return `${lockFilePath}.meta.json`;
}

// Older versions wrote a JSON file at `.lock`. proper-lockfile uses that path
// as a directory (mkdir-based), so a stale legacy file would block startup
// forever. Remove it before attempting to acquire.
async function migrateLegacyLock(lockFilePath: string): Promise<void> {
  try {
    const st = await stat(lockFilePath);
    if (st.isFile()) {
      await unlink(lockFilePath).catch(() => undefined);
      log.info('preflight.legacy-lock-removed', { path: lockFilePath });
    }
  } catch {
    // not present — nothing to migrate
  }
}

export async function acquireLock(
  storageRoot: string,
  lockFilePath: string,
): Promise<() => Promise<void>> {
  await migrateLegacyLock(lockFilePath);
  const metaPath = lockMetaPath(lockFilePath);
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(storageRoot, {
      lockfilePath: lockFilePath,
      stale: LOCK_STALE_MS,
      realpath: false,
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'ELOCKED') {
      const meta = await readJsonIfExists<{ pid: number; port: number }>(metaPath);
      const info = meta ? ` (pid ${meta.pid}, port ${meta.port})` : '';
      throw new PreflightError(
        'instance-running',
        `Another mdredd instance appears to be running${info}.`,
        `Close it first, or, if you are sure it is stale, remove the lock directory and its sidecar: rm -rf ${lockFilePath} ${metaPath}`,
      );
    }
    throw err;
  }
  return async () => {
    try {
      await release();
    } catch (err) {
      // Surface release failures so the operator knows why the lock wasn't
      // cleared — they will have to wait out the stale window or remove the
      // lock directory manually (see the `instance-running` hint).
      log.warn('preflight.lock-release-failed', {
        path: lockFilePath,
        error: (err as Error).message,
      });
    }
    await unlink(metaPath).catch(() => undefined);
  };
}

export async function writeLockMeta(
  lockFilePath: string,
  pid: number,
  port: number,
): Promise<void> {
  await atomicWriteFile(
    lockMetaPath(lockFilePath),
    JSON.stringify({ pid, port, startedAt: new Date().toISOString() }, null, 2),
  );
}

async function recoverAbandonedRuns(storageRoot: string): Promise<void> {
  if (!(await pathExists(storageRoot))) return;
  const entries = await readdir(storageRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const configPath = join(storageRoot, entry.name, 'config.json');
    let cfg;
    try {
      cfg = JSON.parse(await readFile(configPath, 'utf8'));
    } catch {
      continue;
    }
    if (cfg && (cfg.status === 'preparing' || cfg.status === 'streaming')) {
      cfg.status = 'abandoned';
      cfg.endedAt = cfg.endedAt ?? new Date().toISOString();
      cfg.truncationReason = cfg.truncationReason ?? null;
      await writeFile(configPath, JSON.stringify(cfg, null, 2));
      log.info('preflight.run-marked-abandoned', { run: entry.name });
    }
  }
}

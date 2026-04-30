import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathExists, atomicWriteFile, ensureDir, readJsonIfExists } from './fsUtil.js';
import {
  PROJECT_INFO_FILE,
  PROJECT_MARKERS,
  PROJECTS_DIR_NAME,
  STORAGE_DIR_NAME,
} from '@shared/constants.js';
import { readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import lockfile from 'proper-lockfile';
import { log } from './log.js';

const execFileAsync = promisify(execFile);

export interface PreflightInput {
  cwd: string;
  claudeBin: string;
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
  const globalRoot = join(homedir(), STORAGE_DIR_NAME);
  await cwdGuard(input.cwd, globalRoot);
  // Per-project storage so two mdredds in different cwds don't share a lock,
  // session, or run history. The cwd-inside-storage guard above still uses
  // the global root so a user can't run mdredd from inside `~/.mdredd/`.
  const storageRoot = join(globalRoot, PROJECTS_DIR_NAME, projectKey(input.cwd));
  const lockFilePath = join(storageRoot, '.lock');
  await ensureDir(storageRoot);
  await ensureAutoGitignore(globalRoot);
  await writeProjectInfo(storageRoot, input.cwd);
  const releaseLock = await acquireLock(storageRoot, lockFilePath);
  await recoverAbandonedRuns(storageRoot);
  return { storageRoot, lockFilePath, releaseLock };
}

// Stable per-cwd key. SHA-256 truncated to 12 hex chars: collision-resistant
// enough that two distinct project paths on one machine will never collide,
// short enough to be readable in directory listings. Symlinked paths get
// distinct keys from their realpath because we only normalize via `resolve`,
// not `realpath` — users who reach a project through a symlink intentionally
// get separate sessions.
export function projectKey(cwd: string): string {
  return createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 12);
}

// Drop a tiny sidecar with the cwd that produced this storageRoot. Purely
// for human inspection / debugging — `ls ~/.mdredd/projects/<key>/project.json`
// answers "which project is this?" without rebuilding the hash.
async function writeProjectInfo(storageRoot: string, cwd: string): Promise<void> {
  const path = join(storageRoot, PROJECT_INFO_FILE);
  const existing = await readJsonIfExists<{ cwd?: string }>(path);
  if (existing?.cwd === cwd) return;
  await atomicWriteFile(
    path,
    JSON.stringify({ cwd: resolve(cwd), updatedAt: new Date().toISOString() }, null, 2),
  );
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

async function cwdGuard(cwd: string, storageRoot: string): Promise<void> {
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

  const hasMarker = await anyExists(PROJECT_MARKERS.map((m) => join(cwd, m)));
  if (!hasMarker) {
    throw new PreflightError(
      'cwd-no-marker',
      `No project marker (${PROJECT_MARKERS.join(', ')}) found at ${cwd}.`,
      'Run mdredd from a project root.',
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

function tryAcquire(storageRoot: string, lockFilePath: string): Promise<() => Promise<void>> {
  return lockfile.lock(storageRoot, {
    lockfilePath: lockFilePath,
    stale: LOCK_STALE_MS,
    realpath: false,
  });
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

// Probe whether `pid` is alive without sending a real signal. `process.kill(pid, 0)`
// throws ESRCH for a dead pid, EPERM for a live pid we don't own, and succeeds for
// a live pid we do own — so anything other than ESRCH means "still alive, don't
// reclaim". Non-positive pids are rejected because `process.kill(0)` targets the
// caller's process group instead of a specific pid.
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code !== 'ESRCH';
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
    release = await tryAcquire(storageRoot, lockFilePath);
  } catch (err) {
    if ((err as { code?: string }).code !== 'ELOCKED') throw err;
    release = await reclaimOrFail(storageRoot, lockFilePath, metaPath);
  }
  // Bind meta to *this* lock instance via the lock dir's inode so a future
  // reader can verify the meta belongs to the lock dir it's holding (not to
  // a previous owner whose meta survived a crash). Written here, BEFORE
  // returning, so a third process that races between our mkdir and our
  // writeFile sees either no meta or a meta whose `lockIno` does not match
  // the current `.lock/` ino — never a stale meta paired with a fresh lock.
  try {
    await writeMetaWithFingerprint(metaPath, lockFilePath, process.pid);
  } catch (err) {
    // CLAUDE.md guarantees any thrown error during startup releases the
    // lock before exiting. Without this, a transient meta-write failure
    // (disk full, EPERM, EIO) would leak the `.lock/` dir until proper-
    // lockfile's 5-minute stale window elapsed, blocking restart.
    await release().catch(() => undefined);
    await unlink(metaPath).catch(() => undefined);
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

interface LockMeta {
  pid: number;
  port?: number;
  startedAt?: string;
  // Inode of the lock directory at the time this meta was written. A reader
  // that sees ELOCKED can stat the live `.lock/` dir and refuse to reclaim
  // when this fingerprint does not match — that meta describes a previous
  // lock instance, not the current one (closes the P1 race window).
  lockIno?: number;
}

async function reclaimOrFail(
  storageRoot: string,
  lockFilePath: string,
  metaPath: string,
): Promise<() => Promise<void>> {
  const meta = await readJsonIfExists<LockMeta>(metaPath);
  const lockStat = await stat(lockFilePath).catch(() => null);
  // Only reclaim when (a) the meta is bound to the *current* lock dir via
  // its inode AND (b) the recorded pid is dead. Either side missing means
  // the meta is either stale-from-a-previous-owner or the lock is held by
  // a process we cannot prove is gone. In both cases we fall through to
  // `instance-running` and let proper-lockfile's stale window handle it.
  const fingerprintMatches =
    !!meta &&
    lockStat !== null &&
    typeof meta.lockIno === 'number' &&
    meta.lockIno === lockStat.ino;
  if (!fingerprintMatches || !meta || isPidAlive(meta.pid)) {
    const info = meta ? ` (pid ${meta.pid}${meta.port ? `, port ${meta.port}` : ''})` : '';
    throw new PreflightError(
      'instance-running',
      `Another mdredd instance appears to be running${info}.`,
      `Close it first, or, if you are sure it is stale, remove the lock directory and its sidecar: rm -rf ${lockFilePath} ${metaPath}`,
    );
  }
  log.warn('preflight.lock-stale-recovered', { pid: meta.pid, port: meta.port });
  await rm(lockFilePath, { recursive: true, force: true });
  await unlink(metaPath).catch(() => undefined);
  try {
    return await tryAcquire(storageRoot, lockFilePath);
  } catch (err) {
    if ((err as { code?: string }).code === 'ELOCKED') {
      // Race: another mdredd reclaimed the lock between our rm and our retry.
      // Surface the canonical instance-running error rather than leaking
      // proper-lockfile's raw ELOCKED to stdout.
      throw new PreflightError(
        'instance-running',
        'Another mdredd instance won the lock-recovery race.',
        `If you believe this lock is stuck, remove it manually: rm -rf ${lockFilePath} ${metaPath}`,
      );
    }
    throw err;
  }
}

async function writeMetaWithFingerprint(
  metaPath: string,
  lockFilePath: string,
  pid: number,
  port?: number,
): Promise<void> {
  let lockIno: number | undefined;
  try {
    const st = await stat(lockFilePath);
    lockIno = st.ino;
  } catch {
    // If we can't stat the lock dir we just acquired, something is very
    // wrong — but failing here would prevent startup. Write meta without
    // the fingerprint and rely on the legacy pid-only behaviour.
    log.warn('preflight.lock-stat-failed', { path: lockFilePath });
  }
  const meta: LockMeta = { pid, startedAt: new Date().toISOString() };
  if (typeof port === 'number') meta.port = port;
  if (typeof lockIno === 'number') meta.lockIno = lockIno;
  await atomicWriteFile(metaPath, JSON.stringify(meta, null, 2));
}

// Update the meta sidecar with the bound port. Re-uses the inode-fingerprinted
// writer so the `lockIno` field stays in sync with the live `.lock/` dir even
// after this overwrite — without that, the P1 fingerprint guard would falsely
// reject a meta written here (no `lockIno`) and refuse to reclaim a genuinely
// stale lock on the next mdredd boot.
export async function writeLockMeta(
  lockFilePath: string,
  pid: number,
  port: number,
): Promise<void> {
  await writeMetaWithFingerprint(lockMetaPath(lockFilePath), lockFilePath, pid, port);
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

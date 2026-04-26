import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir, tmpdir } from 'node:os';
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
const LOCK_STALE_MS = 30_000;

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
  await authSmokeTest(input.claudeBin);
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

// Probe schema for the auth smoke test: forces the CLI to exercise the
// --json-schema path the judge depends on, using a trivial shape that any
// model can emit in one short turn.
const PING_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: { ok: { type: 'boolean' } },
} as const;

const PING_TIMEOUT_MS = 30_000;

export async function authSmokeTest(bin: string): Promise<void> {
  const args = [
    '-p',
    'ping',
    '--model',
    'haiku',
    '--output-format',
    'json',
    '--tools',
    '',
    '--allowedTools',
    '',
    '--strict-mcp-config',
    '--setting-sources',
    'user',
    '--disable-slash-commands',
    '--json-schema',
    JSON.stringify(PING_JSON_SCHEMA),
  ];

  const env = { ...process.env };
  delete env.NODE_OPTIONS;

  const result = await new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
    timedOut: boolean;
    spawnError?: Error;
  }>((resolve) => {
    const proc = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: tmpdir(),
      env,
    });
    let stderr = '';
    proc.stdout.on('data', () => {
      /* drain */
    });
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, PING_TIMEOUT_MS);
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, signal: null, stderr, timedOut: false, spawnError: err });
    });
    proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ exitCode: code, signal, stderr, timedOut });
    });
  });

  if (result.spawnError) {
    throw new PreflightError(
      'claude-auth-spawn-failed',
      `Could not spawn ${bin} for auth smoke test: ${result.spawnError.message}`,
      'Ensure `claude` is on PATH or set CLAUDE_BIN.',
    );
  }

  if (result.timedOut) {
    throw new PreflightError(
      'claude-auth-timeout',
      `\`${bin} -p "ping"\` did not respond within ${PING_TIMEOUT_MS / 1000}s.`,
      'If you are not authenticated, run `claude login`. Otherwise check your network and retry.',
    );
  }

  if (result.exitCode !== 0) {
    const stderrTail = result.stderr.trim().slice(-500);
    const looksLikeAuth = isLikelyAuthError(result.stderr);
    throw new PreflightError(
      'claude-auth-failed',
      `\`${bin} -p "ping"\` exited ${result.exitCode}${stderrTail ? `: ${stderrTail}` : ''}`,
      looksLikeAuth
        ? 'Run `claude login` first, then try again.'
        : 'Run `claude login` first, then try again. If the error above is unrelated to auth, fix it and retry.',
    );
  }

  log.info('preflight.claude-auth-ok', {});
}

function isLikelyAuthError(stderr: string): boolean {
  return /\b(auth|authenticat|login|unauthori[sz]ed|401|403|api[_ -]?key|credentials?)\b/i.test(
    stderr,
  );
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

async function acquireLock(
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
        `Close it first, or remove ${lockFilePath} if you are sure it is stale.`,
      );
    }
    throw err;
  }
  return async () => {
    await release().catch(() => undefined);
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

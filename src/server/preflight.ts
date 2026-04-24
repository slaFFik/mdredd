import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathExists, atomicWriteFile, ensureDir, readJsonIfExists } from './fsUtil.js';
import { PROJECT_MARKERS, STORAGE_ROOT_REL } from '@shared/constants.js';
import { readdir, readFile, writeFile, unlink } from 'node:fs/promises';
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
  ownedLock: boolean;
}

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
  await cwdGuard(input.cwd, input.force ?? false);
  const storageRoot = resolve(input.cwd, STORAGE_ROOT_REL);
  const lockFilePath = join(storageRoot, '.lock');
  await ensureDir(storageRoot);
  await ensureAutoGitignore(storageRoot);
  await acquireLock(lockFilePath);
  await recoverAbandonedRuns(storageRoot);
  return { storageRoot, lockFilePath, ownedLock: true };
}

async function checkClaudeCli(bin: string): Promise<void> {
  try {
    const { stdout } = await execFileAsync(bin, ['--version'], { timeout: 5_000 });
    const trimmed = stdout.trim();
    log.info('preflight.claude-version', { version: trimmed });
  } catch (err) {
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

async function cwdGuard(cwd: string, force: boolean): Promise<void> {
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

  // Refuse if cwd is inside an agents/mdredd directory (walk upward).
  let cursor = cwd;
  let guard = 0;
  while (cursor && cursor !== '/' && guard++ < 50) {
    const base = cursor.split('/').slice(-2).join('/');
    if (base === STORAGE_ROOT_REL) {
      throw new PreflightError(
        'cwd-inside-storage',
        `Refusing to run mdredd from inside an agents/mdredd directory (at ${cursor}).`,
        'cd out of the storage directory and run mdredd from the project root.',
      );
    }
    const parent = cursor.slice(0, cursor.lastIndexOf('/')) || '/';
    if (parent === cursor) break;
    cursor = parent;
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

async function acquireLock(lockFilePath: string): Promise<void> {
  const existing = await readJsonIfExists<{ pid: number; port: number; startedAt: string }>(
    lockFilePath,
  );
  if (existing && isAlive(existing.pid)) {
    throw new PreflightError(
      'instance-running',
      `Another mdredd instance appears to be running (pid ${existing.pid}, port ${existing.port}).`,
      `Close it first, or remove ${lockFilePath} if you are sure it is stale.`,
    );
  }
  if (existing) {
    log.info('preflight.stale-lock-recovered', { pid: existing.pid });
    await unlink(lockFilePath).catch(() => undefined);
  }
}

export async function writeLock(lockFilePath: string, pid: number, port: number): Promise<void> {
  await writeFile(
    lockFilePath,
    JSON.stringify({ pid, port, startedAt: new Date().toISOString() }, null, 2),
  );
}

export async function releaseLock(lockFilePath: string): Promise<void> {
  await unlink(lockFilePath).catch(() => undefined);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
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

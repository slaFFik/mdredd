import { mkdir, rename, writeFile, readFile, realpath, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { log } from './log.js';

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/**
 * Atomic write: write to <path>.tmp-<rand> then rename over target.
 * Keeps on-disk state always parseable even if the process dies mid-write.
 */
export async function atomicWriteFile(path: string, data: string | Uint8Array): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = `${path}.tmp-${randomBytes(4).toString('hex')}`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteFile(path, JSON.stringify(value, null, 2));
}

export async function readJsonIfExists<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as T;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

export function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

export function isEAccess(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'EACCES' || code === 'EPERM';
}

/**
 * Resolve `p` against `base`; throw if the result escapes `base`.
 * Guards against `..` traversal in user-provided path fragments.
 *
 * Note: this is purely path-string based and does NOT follow symlinks. A symlink
 * inside `base` whose target is outside `base` will still resolve to a path
 * inside `base` here. Use `realpathWithinBase` if symlink resolution matters
 * (anywhere a `stat`/`readFile`/`readdir` follows symlinks on user-controlled
 * input).
 */
export function resolveWithinBase(base: string, p: string): string {
  const resolved = resolve(base, p);
  const baseResolved = resolve(base);
  if (resolved !== baseResolved && !resolved.startsWith(baseResolved + sep)) {
    throw new Error(`path escape detected: ${p} resolves outside ${base}`);
  }
  return resolved;
}

/**
 * Like `resolveWithinBase`, but additionally resolves symlinks on both `base`
 * and the target and asserts the realpath is still inside `base`'s realpath.
 *
 * Pass a precomputed `baseReal` when calling repeatedly with the same `base`
 * (e.g. per directory listing) to avoid redundant realpath syscalls.
 *
 * Returns the realpath of the resolved target.
 *
 * Throws if the target does not exist (`ENOENT`) or escapes (`EESCAPE`).
 */
export async function realpathWithinBase(
  base: string,
  p: string,
  baseReal?: string,
): Promise<string> {
  const resolved = resolveWithinBase(base, p);
  const baseRealResolved = baseReal ?? (await realpath(base));
  const targetReal = await realpath(resolved);
  if (targetReal !== baseRealResolved && !targetReal.startsWith(baseRealResolved + sep)) {
    const err = new Error(
      `symlink escape detected: ${p} resolves to ${targetReal}, outside ${baseRealResolved}`,
    );
    (err as NodeJS.ErrnoException).code = 'EESCAPE';
    throw err;
  }
  return targetReal;
}

/**
 * Read `<dir>/.gitignore` and return an `Ignore` matcher, or `null` if the
 * file is missing or empty. Non-ENOENT read errors are logged and treated as
 * "no rules" rather than thrown — a broken local gitignore should not fail an
 * operation that's incidentally consulting it.
 */
export async function loadGitignore(dir: string): Promise<Ignore | null> {
  const gitignorePath = join(dir, '.gitignore');
  let raw: string;
  try {
    raw = await readFile(gitignorePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('fsUtil.gitignore-read-failed', {
        path: gitignorePath,
        error: (err as Error).message,
      });
    }
    return null;
  }
  if (raw.trim() === '') return null;
  return ignore().add(raw);
}

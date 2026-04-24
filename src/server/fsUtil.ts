import { mkdir, rename, writeFile, readFile, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';

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
 */
export function resolveWithinBase(base: string, p: string): string {
  const resolved = resolve(base, p);
  const baseResolved = resolve(base);
  if (resolved !== baseResolved && !resolved.startsWith(baseResolved + '/')) {
    throw new Error(`path escape detected: ${p} resolves outside ${base}`);
  }
  return resolved;
}

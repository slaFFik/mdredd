import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { resolveWithinBase } from './fsUtil.js';

const SKIP_ALWAYS = new Set(['.git', '.DS_Store', 'node_modules']);
const MAX_READ_BYTES = 1 * 1024 * 1024; // 1 MB

export interface FsEntry {
  name: string;
  path: string;          // relative to cwd, forward slashes
  isDirectory: boolean;
  size: number;          // 0 for directories
}

export interface FsListResult {
  path: string;          // normalized relative path that was listed
  entries: FsEntry[];
}

export interface FsReadResult {
  path: string;
  content: string;
  size: number;
}

export async function listDir(cwd: string, relPath: string): Promise<FsListResult> {
  const safePath = normalizeRel(relPath);
  const target = resolveWithinBase(cwd, safePath);
  const targetStat = await stat(target).catch((err) => {
    throw new FsBrowserError(err as Error, 'not-found');
  });
  if (!targetStat.isDirectory()) {
    throw new FsBrowserError(new Error(`not a directory: ${safePath}`), 'not-directory');
  }
  const ig = await loadRootGitignore(cwd);
  const raw = await readdir(target, { withFileTypes: true });
  const out: FsEntry[] = [];
  for (const e of raw) {
    if (SKIP_ALWAYS.has(e.name)) continue;
    const relEntry = safePath ? `${safePath}/${e.name}` : e.name;
    const matchPath = e.isDirectory() ? `${relEntry}/` : relEntry;
    if (ig.ignores(matchPath)) continue;
    let size = 0;
    if (e.isFile()) {
      try {
        const s = await stat(join(target, e.name));
        size = s.size;
      } catch {
        // unreadable file — still show it, size 0
      }
    }
    out.push({
      name: e.name,
      path: relEntry,
      isDirectory: e.isDirectory(),
      size,
    });
  }
  out.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { path: safePath, entries: out };
}

export async function readFileCapped(cwd: string, relPath: string): Promise<FsReadResult> {
  const safePath = normalizeRel(relPath);
  const target = resolveWithinBase(cwd, safePath);
  const s = await stat(target).catch((err) => {
    throw new FsBrowserError(err as Error, 'not-found');
  });
  if (!s.isFile()) {
    throw new FsBrowserError(new Error(`not a file: ${safePath}`), 'not-file');
  }
  if (s.size > MAX_READ_BYTES) {
    throw new FsBrowserError(
      new Error(`file too large: ${s.size} bytes (cap ${MAX_READ_BYTES})`),
      'too-large',
    );
  }
  const buf = await readFile(target);
  // Reject binary files: scan the first 8KB for NUL bytes.
  const scanLen = Math.min(buf.length, 8192);
  for (let i = 0; i < scanLen; i++) {
    if (buf[i] === 0) {
      throw new FsBrowserError(
        new Error(`file appears to be binary: ${safePath}`),
        'binary',
      );
    }
  }
  return { path: safePath, content: buf.toString('utf8'), size: s.size };
}

export class FsBrowserError extends Error {
  code: string;
  constructor(original: Error, code: string) {
    super(original.message);
    this.code = code;
    this.stack = original.stack;
  }
}

function normalizeRel(p: string): string {
  let s = (p ?? '').trim();
  if (s === '' || s === '/' || s === '.' || s === './') return '';
  if (s.startsWith('./')) s = s.slice(2);
  while (s.startsWith('/')) s = s.slice(1);
  while (s.endsWith('/')) s = s.slice(0, -1);
  // Reject any segment that is exactly ".."
  for (const seg of s.split('/')) {
    if (seg === '..') {
      throw new FsBrowserError(new Error(`path traversal rejected: ${p}`), 'traversal');
    }
  }
  return s;
}

async function loadRootGitignore(cwd: string): Promise<Ignore> {
  const ig = ignore();
  try {
    const raw = await readFile(join(cwd, '.gitignore'), 'utf8');
    ig.add(raw);
  } catch {
    // no .gitignore — no filtering beyond SKIP_ALWAYS
  }
  return ig;
}

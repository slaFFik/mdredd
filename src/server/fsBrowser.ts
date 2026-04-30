import { readdir, readFile, lstat, realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { loadGitignore, realpathWithinBase } from './fsUtil.js';

const SKIP_ALWAYS = new Set(['.git', '.DS_Store', 'node_modules']);
const MAX_READ_BYTES = 1 * 1024 * 1024; // 1 MB

export interface FsEntry {
  name: string;
  path: string; // relative to cwd, forward slashes
  isDirectory: boolean;
  size: number; // 0 for directories
}

export interface FsListResult {
  path: string; // normalized relative path that was listed
  entries: FsEntry[];
}

export interface FsReadResult {
  path: string;
  content: string;
  size: number;
}

export async function listDir(cwd: string, relPath: string): Promise<FsListResult> {
  const safePath = normalizeRel(relPath);
  const cwdReal = await realpath(cwd);
  // Resolve symlinks on the listing target itself: we won't list a directory
  // whose realpath escapes cwd.
  const target = await resolveSafe(cwd, safePath, cwdReal);
  const targetStat = await stat(target).catch((err) => {
    throw new FsBrowserError(err as Error, 'not-found');
  });
  if (!targetStat.isDirectory()) {
    throw new FsBrowserError(new Error(`not a directory: ${safePath}`), 'not-directory');
  }
  const ig = await loadGitignore(cwd);
  const raw = await readdir(target, { withFileTypes: true });
  const out: FsEntry[] = [];
  for (const e of raw) {
    if (SKIP_ALWAYS.has(e.name)) continue;
    const relEntry = safePath ? `${safePath}/${e.name}` : e.name;

    const entryPath = join(target, e.name);
    let lst;
    try {
      lst = await lstat(entryPath);
    } catch {
      continue;
    }

    // Resolve effective dir-ness/size off the validated realpath. Doing this
    // before the gitignore check matters for symlinks: Dirent.isDirectory()
    // returns false on a link, so a directory-only pattern like `build/`
    // would miss a symlinked dir if we built `matchPath` off the dirent
    // alone. It also closes a TOCTOU window — once we've confirmed `real`
    // is inside cwd, the follow-up stat goes through `real` so the link
    // can't be swapped out from under us between checks.
    let isDirectory: boolean;
    let size = 0;
    if (lst.isSymbolicLink()) {
      let real: string;
      try {
        real = await realpath(entryPath);
      } catch {
        continue;
      }
      if (real !== cwdReal && !real.startsWith(cwdReal + sep)) {
        continue;
      }
      let realLst;
      try {
        realLst = await lstat(real);
      } catch {
        continue;
      }
      isDirectory = realLst.isDirectory();
      if (realLst.isFile()) size = realLst.size;
    } else {
      isDirectory = lst.isDirectory();
      if (lst.isFile()) size = lst.size;
    }

    const matchPath = isDirectory ? `${relEntry}/` : relEntry;
    if (ig?.ignores(matchPath)) continue;

    out.push({
      name: e.name,
      path: relEntry,
      isDirectory,
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
  const target = await resolveSafe(cwd, safePath);
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
      throw new FsBrowserError(new Error(`file appears to be binary: ${safePath}`), 'binary');
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

async function resolveSafe(cwd: string, safePath: string, baseReal?: string): Promise<string> {
  try {
    return await realpathWithinBase(cwd, safePath, baseReal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new FsBrowserError(err as Error, 'not-found');
    }
    if (code === 'EESCAPE') {
      throw new FsBrowserError(err as Error, 'symlink-escape');
    }
    throw err;
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

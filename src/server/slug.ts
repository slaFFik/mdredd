import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import slugify from 'slugify';
import { pathExists } from './fsUtil.js';

const MAX_SLUG_LENGTH = 32;

export interface SlugInput {
  /** User-entered variant name; empty string means fallback to `variant-<columnIndex>`. */
  explicitName: string;
  /** Variant content; only the trailing 6-char hash is derived from it. */
  variantContent: string;
  /** 1-based column position; used in the fallback slug `variant-N`. */
  columnIndex: number;
  now?: Date;
}

export interface SlugResult {
  folderName: string;
  slugBase: string;
  contentHash: string;
  timestamp: string;
  source: 'explicit' | 'fallback';
}

// Unix epoch seconds — 10 digits, sorts correctly as a string. Second-precision
// is enough since same-second collisions are handled by the numeric suffix in
// deriveSlug (and only trip when timestamp + slug base + content hash all match).
function formatTimestamp(d: Date): string {
  return Math.floor(d.getTime() / 1000).toString();
}

function hashContent(content: string): string {
  const lfNormalized = content.replace(/\r\n/g, '\n');
  return createHash('sha256').update(lfNormalized, 'utf8').digest('hex').slice(0, 6);
}

export function slugifyName(input: string): string {
  return slugify(input, { lower: true, strict: true, trim: true }).slice(0, MAX_SLUG_LENGTH);
}

// Defense-in-depth: slugify shouldn't produce these, but a future config change
// or extension could. Reject anything that could escape the per-run dir.
function isSafeSlugFragment(s: string): boolean {
  if (!s) return false;
  if (s.startsWith('.')) return false;
  if (s.includes('/') || s.includes('..') || s.includes('\\')) return false;
  return true;
}

/**
 * Derive the run folder name. Uses the user-entered variant name when present
 * (slugified via the `slugify` library); otherwise falls back to a positional
 * `variant-<columnIndex>` slug. Synchronous — no model spawn.
 */
export function deriveSlug(input: SlugInput, existingFolderNames: Set<string>): SlugResult {
  const now = input.now ?? new Date();
  const timestamp = formatTimestamp(now);
  const contentHash = hashContent(input.variantContent);

  let slugBase = '';
  let source: SlugResult['source'] = 'fallback';

  const trimmed = input.explicitName.trim();
  if (trimmed) {
    const candidate = slugifyName(trimmed);
    if (isSafeSlugFragment(candidate)) {
      slugBase = candidate;
      source = 'explicit';
    }
  }

  if (!slugBase) {
    slugBase = `variant-${input.columnIndex}`;
  }

  let folderName = `${timestamp}-${slugBase}-${contentHash}`;
  let suffix = 0;
  while (existingFolderNames.has(folderName)) {
    suffix += 1;
    folderName = `${timestamp}-${slugBase}-${contentHash}-${suffix}`;
    if (suffix > 50) throw new Error(`slug collision storm: ${folderName}`);
  }

  return { folderName, slugBase, contentHash, timestamp, source };
}

export async function listRunFolderNames(storageRoot: string): Promise<Set<string>> {
  if (!(await pathExists(storageRoot))) return new Set();
  const entries = await readdir(storageRoot, { withFileTypes: true });
  return new Set(
    entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name),
  );
}

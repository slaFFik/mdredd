import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathExists } from './fsUtil.js';
import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { log } from './log.js';

const MAX_SLUG_LENGTH = 32;

export interface SlugInput {
  explicitName: string; // user-entered variant name; empty string means auto-generate
  variantContent: string; // current variant content (used for hashing + Haiku input)
  claudeBin: string;
  now?: Date;
}

export interface SlugResult {
  folderName: string; // <timestamp>-<slug-base>-<hash>
  slugBase: string;
  contentHash: string;
  timestamp: string;
  source: 'explicit' | 'haiku' | 'fallback';
}

export function formatTimestamp(d: Date): string {
  // Unix epoch seconds — 10 digits, sorts correctly as a string, compact in folder listings.
  // Second-precision → collisions within a single second are handled by the suffix logic
  // in deriveSlug (only trips when timestamp + slug base + content hash all match).
  return Math.floor(d.getTime() / 1000).toString();
}

export function hashContent(content: string): string {
  const lfNormalized = content.replace(/\r\n/g, '\n');
  return createHash('sha256').update(lfNormalized, 'utf8').digest('hex').slice(0, 6);
}

export function kebabCase(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/^-+|-+$/g, '');
}

export function isSafeSlugFragment(s: string): boolean {
  if (!s) return false;
  if (s.startsWith('.')) return false;
  if (s.includes('/') || s.includes('..') || s.includes('\\')) return false;
  return true;
}

/**
 * Derive the run folder name. If explicitName is given, kebab-case it.
 * Otherwise, briefly block on a Haiku slug generation; fall back to literal "variant" on failure.
 */
export async function deriveSlug(
  input: SlugInput,
  existingFolderNames: Set<string>,
): Promise<SlugResult> {
  const now = input.now ?? new Date();
  const timestamp = formatTimestamp(now);
  const contentHash = hashContent(input.variantContent);

  let slugBase = '';
  let source: SlugResult['source'] = 'fallback';

  if (input.explicitName.trim()) {
    slugBase = kebabCase(input.explicitName.trim());
    if (isSafeSlugFragment(slugBase)) {
      source = 'explicit';
    } else {
      slugBase = '';
    }
  }

  if (!slugBase) {
    const haikuSlug = await tryHaikuSlug(input.variantContent, input.claudeBin);
    if (haikuSlug && isSafeSlugFragment(haikuSlug)) {
      slugBase = haikuSlug;
      source = 'haiku';
    }
  }

  if (!slugBase) {
    slugBase = 'variant';
    source = 'fallback';
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

export function slugStoragePath(storageRoot: string, folderName: string): string {
  return join(storageRoot, folderName);
}

async function tryHaikuSlug(content: string, claudeBin: string): Promise<string | null> {
  const prompt =
    'Produce a 2-4 word kebab-case slug summarizing this variant. Output only the slug, no quotes, no explanation. Example: "concise-style" or "verbose-debugging". Variant content follows:\n\n' +
    content.slice(0, 4_000);

  return new Promise<string | null>((resolve) => {
    let done = false;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      resolve(value);
    };

    const proc = spawn(
      claudeBin,
      [
        '-p',
        prompt,
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
        'project',
        '--disable-slash-commands',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let buf = '';
    proc.stdout.on('data', (d) => (buf += d.toString()));
    proc.stderr.on('data', (d) => {
      log.debug('haiku-slug stderr', { text: d.toString().slice(0, 200) });
    });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      finish(null);
    }, 8_000);

    proc.on('error', (err) => {
      clearTimeout(timer);
      log.warn('haiku-slug spawn error', { error: err.message });
      finish(null);
    });

    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) return finish(null);
      try {
        const parsed = JSON.parse(buf);
        const result: string | undefined = parsed.result;
        if (!result) return finish(null);
        const extracted = result.trim().split(/\s+/)[0] ?? '';
        const slug = kebabCase(extracted);
        finish(slug || null);
      } catch {
        finish(null);
      }
    });
  });
}

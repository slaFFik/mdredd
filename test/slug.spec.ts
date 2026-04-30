import { deriveSlug, slugifyName } from '../src/server/slug.js';

let failures = 0;
function scenario(name: string, run: () => void): void {
  process.stdout.write(`• ${name} … `);
  try {
    run();
    process.stdout.write('PASS\n');
  } catch (err) {
    process.stdout.write('FAIL\n');
    console.error('  ' + (err as Error).message);
    failures += 1;
  }
}

function assertEq<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(
      `${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
    );
  }
}

const FIXED_NOW = new Date('2026-04-30T08:38:35.000Z'); // → epoch 1777538315
const TS = '1777538315';

scenario('slugifyName: lowercases, strips punctuation, collapses spaces to dashes', () => {
  assertEq(slugifyName('My Cool Variant!'), 'my-cool-variant', 'punctuation + casing');
  assertEq(slugifyName('  trim spaces  '), 'trim-spaces', 'leading/trailing whitespace');
  assertEq(slugifyName('a/b/../c'), 'abc', 'path-like input is sanitized');
});

scenario('slugifyName: caps length at 32 chars', () => {
  const long = 'a'.repeat(80);
  assertEq(slugifyName(long).length, 32, 'capped at MAX_SLUG_LENGTH');
});

scenario('deriveSlug: explicit name → slugified, source=explicit', () => {
  const slug = deriveSlug(
    { explicitName: 'My Variant', variantContent: 'hello', columnIndex: 1, now: FIXED_NOW },
    new Set(),
  );
  assertEq(slug.source, 'explicit', 'source');
  assertEq(slug.slugBase, 'my-variant', 'slugBase');
  // contentHash for "hello" with sha256, first 6 hex.
  assertEq(slug.folderName, `${TS}-my-variant-2cf24d`, 'folderName');
});

scenario('deriveSlug: empty name → variant-<columnIndex> fallback', () => {
  const a = deriveSlug(
    { explicitName: '', variantContent: 'x', columnIndex: 1, now: FIXED_NOW },
    new Set(),
  );
  assertEq(a.source, 'fallback', 'source col-1');
  assertEq(a.slugBase, 'variant-1', 'slugBase col-1');
  const b = deriveSlug(
    { explicitName: '', variantContent: 'x', columnIndex: 3, now: FIXED_NOW },
    new Set(),
  );
  assertEq(b.slugBase, 'variant-3', 'slugBase col-3');
});

scenario('deriveSlug: whitespace-only name → fallback', () => {
  const slug = deriveSlug(
    { explicitName: '   ', variantContent: 'x', columnIndex: 2, now: FIXED_NOW },
    new Set(),
  );
  assertEq(slug.source, 'fallback', 'source');
  assertEq(slug.slugBase, 'variant-2', 'slugBase');
});

scenario('deriveSlug: name slugified to empty (e.g. "...") → fallback', () => {
  const slug = deriveSlug(
    { explicitName: '...', variantContent: 'x', columnIndex: 2, now: FIXED_NOW },
    new Set(),
  );
  assertEq(slug.source, 'fallback', 'source');
  assertEq(slug.slugBase, 'variant-2', 'slugBase');
});

scenario('deriveSlug: collision adds numeric suffix', () => {
  const existing = new Set([`${TS}-foo-2cf24d`]);
  const slug = deriveSlug(
    { explicitName: 'foo', variantContent: 'hello', columnIndex: 1, now: FIXED_NOW },
    existing,
  );
  assertEq(slug.folderName, `${TS}-foo-2cf24d-1`, 'first collision suffix');
});

if (failures > 0) {
  console.log(`\n${failures} slug scenario(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll slug scenarios passed.');

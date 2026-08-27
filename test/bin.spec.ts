import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const binPath = resolve(repoRoot, 'bin', 'mdredd.js');
const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
  version: string;
};

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

scenario('--version prints the package.json version and exits 0', () => {
  const res = spawnSync(process.execPath, [binPath, '--version'], { encoding: 'utf8' });
  assertEq(res.status, 0, 'exit code');
  assertEq(res.stdout.trim(), pkg.version, 'stdout');
});

scenario('--version answers without booting the server (works from a refused cwd, no dist)', () => {
  // ~ is a cwd the server refuses to run from, and CI's test job has no dist/
  // build — the flag must short-circuit before either check can interfere.
  const res = spawnSync(process.execPath, [binPath, '--version'], {
    encoding: 'utf8',
    cwd: homedir(),
  });
  assertEq(res.status, 0, 'exit code');
  assertEq(res.stdout.trim(), pkg.version, 'stdout');
  assertEq(res.stderr, '', 'stderr is silent');
});

if (failures > 0) {
  console.log(`\n${failures} bin scenario(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll bin scenarios passed.');

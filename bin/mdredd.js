#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));

// Before the dist/ check: the version is known without a build, and must not
// boot the server (which acquires the project lock and opens the browser).
if (process.argv.includes('--version')) {
  const pkg = JSON.parse(readFileSync(resolve(here, '..', 'package.json'), 'utf8'));
  console.log(pkg.version);
  process.exit(0);
}

const built = resolve(here, '..', 'dist', 'server', 'index.js');

if (!existsSync(built)) {
  console.error(
    'mdredd: build artifacts missing. Run `npm run build` in the mdredd repo before launching.',
  );
  process.exit(1);
}

await import(built);

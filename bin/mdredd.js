#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const built = resolve(here, '..', 'dist', 'server', 'index.js');

if (!existsSync(built)) {
  console.error(
    'mdredd: build artifacts missing. Run `npm run build` in the mdredd repo before launching.',
  );
  process.exit(1);
}

await import(built);

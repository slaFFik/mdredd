import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSandbox } from '../src/server/sandbox.js';
import { listDir, readFileCapped, FsBrowserError } from '../src/server/fsBrowser.js';
import { pathExists } from '../src/server/fsUtil.js';

async function scenario(name: string, run: () => Promise<void>): Promise<void> {
  process.stdout.write(`• ${name} … `);
  try {
    await run();
    process.stdout.write('PASS\n');
  } catch (err) {
    process.stdout.write('FAIL\n');
    console.error(err);
    process.exit(1);
  }
}

async function withCwd(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'mdredd-sandbox-'));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function build(cwd: string) {
  const storageRoot = join(cwd, '.storage');
  return buildSandbox({
    cwd,
    storageRoot,
    runFolder: 'run-test',
    variantType: 'CLAUDE.md',
    skillOrAgentName: null,
    variantContent: '# test\n',
    mode: 'read-only',
  });
}

async function listAllRel(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = full.slice(base.length + 1);
    if (entry.isDirectory()) {
      out.push(rel + '/');
      out.push(...(await listAllRel(full, base)));
    } else {
      out.push(rel);
    }
  }
  return out;
}

await scenario('sandbox: nested .gitignore filters out matching files', async () => {
  await withCwd(async (cwd) => {
    await writeFile(join(cwd, '.gitignore'), 'root-secret\n');
    await mkdir(join(cwd, 'apps', 'foo'), { recursive: true });
    await writeFile(join(cwd, 'apps', 'foo', '.gitignore'), 'private.txt\n');
    await writeFile(join(cwd, 'apps', 'foo', 'public.txt'), 'visible');
    await writeFile(join(cwd, 'apps', 'foo', 'private.txt'), 'hidden');
    await writeFile(join(cwd, 'root-secret'), 'should be ignored');
    await writeFile(join(cwd, 'kept.txt'), 'visible');

    const sb = await build(cwd);
    const all = await listAllRel(sb.projectDir);
    if (!all.includes('apps/foo/public.txt')) {
      throw new Error('expected apps/foo/public.txt to be mirrored');
    }
    if (!all.includes('kept.txt')) {
      throw new Error('expected kept.txt to be mirrored');
    }
    if (all.includes('apps/foo/private.txt')) {
      throw new Error('apps/foo/.gitignore should have hidden private.txt');
    }
    if (all.includes('root-secret')) {
      throw new Error('root .gitignore should have hidden root-secret');
    }
  });
});

await scenario('sandbox: nested node_modules is excluded at every depth', async () => {
  await withCwd(async (cwd) => {
    await mkdir(join(cwd, 'apps', 'foo', 'node_modules', 'react'), { recursive: true });
    await writeFile(join(cwd, 'apps', 'foo', 'node_modules', 'react', 'index.js'), '// pkg');
    await writeFile(join(cwd, 'apps', 'foo', 'src.ts'), 'src');

    const sb = await build(cwd);
    const all = await listAllRel(sb.projectDir);
    if (!all.includes('apps/foo/src.ts')) throw new Error('expected apps/foo/src.ts');
    if (all.some((p) => p.includes('node_modules'))) {
      throw new Error('nested node_modules must not appear in sandbox');
    }
  });
});

await scenario('sandbox: symlink whose target escapes cwd is refused', async () => {
  await withCwd(async (cwd) => {
    const outside = await mkdtemp(join(tmpdir(), 'mdredd-host-secret-'));
    try {
      await writeFile(join(outside, 'creds'), 'API_KEY=leaked');
      await symlink(outside, join(cwd, 'escape'));
      await writeFile(join(cwd, 'README.md'), '# proj');

      const sb = await build(cwd);
      const escaped = sb.skippedTopLevel.find((s) => s.name === 'escape');
      if (!escaped || escaped.reason !== 'symlink escapes cwd') {
        throw new Error(
          `expected top-level "escape" skipped as 'symlink escapes cwd', got ${JSON.stringify(sb.skippedTopLevel)}`,
        );
      }
      if (await pathExists(join(sb.projectDir, 'escape'))) {
        throw new Error('escape symlink should not be mirrored into the sandbox');
      }
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

await scenario('sandbox: nested symlink that escapes cwd is refused too', async () => {
  await withCwd(async (cwd) => {
    const outside = await mkdtemp(join(tmpdir(), 'mdredd-host-secret-'));
    try {
      await writeFile(join(outside, 'creds'), 'API_KEY=leaked');
      await mkdir(join(cwd, 'apps'), { recursive: true });
      await symlink(outside, join(cwd, 'apps', 'leak'));
      await writeFile(join(cwd, 'apps', 'fine.txt'), 'fine');

      const sb = await build(cwd);
      // Top-level "apps" should be mirrored, but the nested "leak" must not appear.
      if (await pathExists(join(sb.projectDir, 'apps', 'leak'))) {
        throw new Error('nested symlink to outside cwd should not be mirrored');
      }
      if (!(await pathExists(join(sb.projectDir, 'apps', 'fine.txt')))) {
        throw new Error('expected apps/fine.txt to still be mirrored');
      }
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

await scenario('sandbox: cycle inside a subtree is detected', async () => {
  await withCwd(async (cwd) => {
    await mkdir(join(cwd, 'a', 'b'), { recursive: true });
    // a/b/loop -> a   (cycle: a -> a/b -> a)
    await symlink(join(cwd, 'a'), join(cwd, 'a', 'b', 'loop'));
    await writeFile(join(cwd, 'a', 'file.txt'), 'x');

    const sb = await build(cwd);
    if (!(await pathExists(join(sb.projectDir, 'a', 'file.txt')))) {
      throw new Error('expected a/file.txt to mirror');
    }
    if (await pathExists(join(sb.projectDir, 'a', 'b', 'loop', 'b', 'loop'))) {
      throw new Error('cycle should not have been followed deeply');
    }
  });
});

await scenario('fsBrowser: symlink to outside cwd is hidden in listDir', async () => {
  await withCwd(async (cwd) => {
    const outside = await mkdtemp(join(tmpdir(), 'mdredd-host-secret-'));
    try {
      await writeFile(join(outside, 'creds'), 'API_KEY=leaked');
      await symlink(outside, join(cwd, 'escape'));
      await writeFile(join(cwd, 'kept.txt'), 'visible');

      const list = await listDir(cwd, '');
      if (list.entries.some((e) => e.name === 'escape')) {
        throw new Error('escape symlink should not appear in browser listing');
      }
      if (!list.entries.some((e) => e.name === 'kept.txt')) {
        throw new Error('expected kept.txt to appear');
      }
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

await scenario('fsBrowser: readFileCapped refuses to read across an escaping symlink', async () => {
  await withCwd(async (cwd) => {
    const outside = await mkdtemp(join(tmpdir(), 'mdredd-host-secret-'));
    try {
      await writeFile(join(outside, 'creds'), 'API_KEY=leaked');
      await symlink(outside, join(cwd, 'escape'));

      let caught: FsBrowserError | null = null;
      try {
        await readFileCapped(cwd, 'escape/creds');
      } catch (err) {
        if (err instanceof FsBrowserError) caught = err;
        else throw err;
      }
      if (!caught) throw new Error('expected an FsBrowserError');
      if (caught.code !== 'symlink-escape') {
        throw new Error(`expected code 'symlink-escape', got '${caught.code}'`);
      }
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

await scenario('fsBrowser: readFileCapped still works on real files', async () => {
  await withCwd(async (cwd) => {
    await writeFile(join(cwd, 'README.md'), '# hi');
    const r = await readFileCapped(cwd, 'README.md');
    if (r.content !== '# hi') throw new Error('content mismatch');
  });
});

console.log('\nAll sandbox security scenarios passed.');

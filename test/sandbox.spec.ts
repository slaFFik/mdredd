import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { buildSandbox } from '../src/server/sandbox.js';
import { listDir, readFileCapped, FsBrowserError } from '../src/server/fsBrowser.js';
import { pathExists } from '../src/server/fsUtil.js';

let failures = 0;
async function scenario(name: string, run: () => Promise<void>): Promise<void> {
  process.stdout.write(`• ${name} … `);
  try {
    await run();
    process.stdout.write('PASS\n');
  } catch (err) {
    process.stdout.write('FAIL\n');
    console.error('  ' + (err as Error).message);
    failures += 1;
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

async function build(cwd: string, mode: 'read-only' | 'write' = 'read-only') {
  const storageRoot = join(cwd, '.storage');
  return buildSandbox({
    cwd,
    storageRoot,
    runFolder: 'run-test',
    variantType: 'CLAUDE.md',
    skillOrAgentName: null,
    variantContent: '# test\n',
    mode,
  });
}

async function listAllRel(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = full.slice(base.length + 1);
    // stat-follow symlinks so the helper sees the same shape regardless of
    // whether sandbox dirs are real dirs or directory-symlinks.
    let isDir;
    try {
      isDir = (await stat(full)).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
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

await scenario('sandbox: cycle inside a subtree is detected on first encounter', async () => {
  await withCwd(async (cwd) => {
    await mkdir(join(cwd, 'a', 'b'), { recursive: true });
    // a/b/loop -> a   (cycle: a -> a/b -> a). The realpath of `a` should be
    // in ancestors by the time we reach the symlink, so the symlink is
    // rejected before it ever gets mirrored — not after we've already started
    // walking the cycle one level in.
    await symlink(join(cwd, 'a'), join(cwd, 'a', 'b', 'loop'));
    await writeFile(join(cwd, 'a', 'file.txt'), 'x');

    const sb = await build(cwd);
    if (!(await pathExists(join(sb.projectDir, 'a', 'file.txt')))) {
      throw new Error('expected a/file.txt to mirror');
    }
    if (await pathExists(join(sb.projectDir, 'a', 'b', 'loop'))) {
      throw new Error('cycle symlink should be rejected on first encounter');
    }
  });
});

await scenario('sandbox: nested .gitignore can negate a root rule', async () => {
  await withCwd(async (cwd) => {
    await writeFile(join(cwd, '.gitignore'), '*.log\n');
    await mkdir(join(cwd, 'apps', 'foo'), { recursive: true });
    await writeFile(join(cwd, 'apps', 'foo', '.gitignore'), '!keep.log\n');
    await writeFile(join(cwd, 'apps', 'foo', 'keep.log'), 'kept');
    await writeFile(join(cwd, 'apps', 'foo', 'noisy.log'), 'noise');
    await writeFile(join(cwd, 'top.log'), 'top');

    const sb = await build(cwd);
    const all = await listAllRel(sb.projectDir);
    if (!all.includes('apps/foo/keep.log')) {
      throw new Error('nested !keep.log should override root *.log');
    }
    if (all.includes('apps/foo/noisy.log')) {
      throw new Error('root *.log should still hide non-negated nested files');
    }
    if (all.includes('top.log')) {
      throw new Error('root *.log should still hide top-level matches');
    }
  });
});

await scenario('fsBrowser: directory-only gitignore pattern matches a symlinked dir', async () => {
  await withCwd(async (cwd) => {
    const realDir = join(cwd, 'real');
    await mkdir(realDir);
    await writeFile(join(realDir, 'inside.txt'), 'x');
    // The gitignore rule is directory-only (`build/`) and the entry is a
    // symlink to a directory. Dirent.isDirectory() reports false for links,
    // so without resolving the link we'd miss the rule and leak the link.
    await symlink(realDir, join(cwd, 'build'));
    await writeFile(join(cwd, '.gitignore'), 'build/\n');
    await writeFile(join(cwd, 'kept.txt'), 'visible');

    const list = await listDir(cwd, '');
    if (list.entries.some((e) => e.name === 'build')) {
      throw new Error('symlinked directory should be filtered by build/ rule');
    }
    if (!list.entries.some((e) => e.name === 'kept.txt')) {
      throw new Error('expected kept.txt to appear');
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

await scenario(
  'sandbox: write mode plants .claude/settings.json with outputs-only permission rules',
  async () => {
    await withCwd(async (cwd) => {
      const sb = await build(cwd, 'write');
      if (sb.settingsPath === null) {
        throw new Error('write mode should report a settingsPath');
      }
      const expectedPath = join(sb.projectDir, '.claude', 'settings.json');
      if (sb.settingsPath !== expectedPath) {
        throw new Error(`settingsPath = ${sb.settingsPath}, expected ${expectedPath}`);
      }
      // The allow rule uses `../outputs/**` — that pattern only resolves to the
      // run's outputs/ if claude's cwd (projectDir) is exactly one level below
      // outputsDir. Assert the relative-path invariant explicitly so a future
      // sandbox layout change can't silently desync from the planted rule.
      const rel = relative(sb.projectDir, sb.outputsDir);
      if (rel !== '../outputs') {
        throw new Error(`outputsDir relative to projectDir = '${rel}', expected '../outputs'`);
      }
      const settings = JSON.parse(await readFile(sb.settingsPath, 'utf8'));
      const allow = settings?.permissions?.allow;
      const deny = settings?.permissions?.deny;
      if (
        !Array.isArray(allow) ||
        !allow.includes('Write(../outputs/**)') ||
        !allow.includes('Edit(../outputs/**)')
      ) {
        throw new Error(`allow rules missing or wrong: ${JSON.stringify(allow)}`);
      }
      if (!Array.isArray(deny) || !deny.includes('Write(**)') || !deny.includes('Edit(**)')) {
        throw new Error(`deny rules missing or wrong: ${JSON.stringify(deny)}`);
      }
    });
  },
);

await scenario('sandbox: read-only mode plants no .claude/settings.json', async () => {
  await withCwd(async (cwd) => {
    const sb = await build(cwd, 'read-only');
    if (sb.settingsPath !== null) {
      throw new Error(`read-only mode should not produce a settings file, got ${sb.settingsPath}`);
    }
    if (await pathExists(join(sb.projectDir, '.claude', 'settings.json'))) {
      throw new Error('read-only mode left a .claude/settings.json on disk');
    }
  });
});

if (failures > 0) {
  console.log(`\n${failures} sandbox security scenario(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll sandbox security scenarios passed.');

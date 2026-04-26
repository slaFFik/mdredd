import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, authSmokeTest, PreflightError } from '../src/server/preflight.js';

const fakeBin = new URL('./fake-claude.mjs', import.meta.url).pathname;

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

async function expectPreflightError(
  fn: () => Promise<void>,
  expectedCode: string,
  hintMustInclude: string,
): Promise<PreflightError> {
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof PreflightError)) {
      throw new Error(
        `expected PreflightError, got ${(err as Error).constructor.name}: ${(err as Error).message}`,
        { cause: err },
      );
    }
    if (err.code !== expectedCode) {
      throw new Error(`expected code ${expectedCode}, got ${err.code} — ${err.message}`, {
        cause: err,
      });
    }
    if (!err.hint || !err.hint.includes(hintMustInclude)) {
      throw new Error(`expected hint to include "${hintMustInclude}", got: ${err.hint}`, {
        cause: err,
      });
    }
    return err;
  }
  throw new Error('expected the call to throw, but it returned');
}

await scenario('authSmokeTest: passes when fake-claude exits 0', async () => {
  const prevScenario = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = 'happy';
  try {
    await authSmokeTest(fakeBin);
  } finally {
    if (prevScenario === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prevScenario;
  }
});

await scenario(
  'authSmokeTest: surfaces `claude login` hint when fake-claude is unauthenticated',
  async () => {
    const prevScenario = process.env.FAKE_CLAUDE_SCENARIO;
    process.env.FAKE_CLAUDE_SCENARIO = 'auth-error';
    try {
      const err = await expectPreflightError(
        () => authSmokeTest(fakeBin),
        'claude-auth-failed',
        'claude login',
      );
      if (!err.message.includes('Authentication required')) {
        throw new Error(`expected stderr tail in message, got: ${err.message}`);
      }
    } finally {
      if (prevScenario === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
      else process.env.FAKE_CLAUDE_SCENARIO = prevScenario;
    }
  },
);

await scenario('authSmokeTest: spawn-error path when binary is missing', async () => {
  await expectPreflightError(
    () => authSmokeTest('/definitely/not/a/real/claude-binary-xyz'),
    'claude-auth-spawn-failed',
    'PATH',
  );
});

async function withTempStorage<T>(run: (storageRoot: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'mdredd-lock-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

await scenario('acquireLock: acquires, then re-acquires after release', async () => {
  await withTempStorage(async (storageRoot) => {
    const lockPath = join(storageRoot, '.lock');
    const release1 = await acquireLock(storageRoot, lockPath);
    const stat1 = await stat(lockPath);
    if (!stat1.isDirectory()) {
      throw new Error('expected lockfile path to be a directory after acquire');
    }
    await release1();
    // Second acquire on the same storage root should succeed once the first
    // has been released — proves the wrapper actually clears the lock.
    const release2 = await acquireLock(storageRoot, lockPath);
    await release2();
  });
});

await scenario(
  'acquireLock: surfaces ELOCKED as instance-running with rm -rf hint',
  async () => {
    await withTempStorage(async (storageRoot) => {
      const lockPath = join(storageRoot, '.lock');
      const release = await acquireLock(storageRoot, lockPath);
      try {
        const err = await expectPreflightError(
          async () => {
            await acquireLock(storageRoot, lockPath);
          },
          'instance-running',
          'rm -rf',
        );
        if (!err.hint || !err.hint.includes(`${lockPath}.meta.json`)) {
          throw new Error(`expected hint to mention meta sidecar, got: ${err.hint}`);
        }
      } finally {
        await release();
      }
    });
  },
);

await scenario('acquireLock: legacy `.lock` file is migrated away', async () => {
  await withTempStorage(async (storageRoot) => {
    const lockPath = join(storageRoot, '.lock');
    // Older versions wrote `.lock` as a regular JSON file. proper-lockfile
    // uses the same path as a mkdir-based directory, so a stale legacy file
    // would block startup forever — acquire must remove it first.
    await writeFile(lockPath, '{"pid":1,"port":6800}');
    const release = await acquireLock(storageRoot, lockPath);
    try {
      const st = await stat(lockPath);
      if (!st.isDirectory()) {
        throw new Error('expected `.lock` to be a directory after migration');
      }
    } finally {
      await release();
    }
  });
});

await scenario('acquireLock: release removes the lock directory and meta sidecar', async () => {
  await withTempStorage(async (storageRoot) => {
    const lockPath = join(storageRoot, '.lock');
    const metaPath = `${lockPath}.meta.json`;
    const release = await acquireLock(storageRoot, lockPath);
    // Simulate writeLockMeta having run during normal startup so we can
    // verify release() removes the sidecar too.
    await writeFile(metaPath, '{"pid":1,"port":6800,"startedAt":""}');
    await release();
    const entries = await readdir(storageRoot);
    if (entries.includes('.lock')) {
      throw new Error(`expected .lock to be gone after release, got: ${entries.join(', ')}`);
    }
    if (entries.includes('.lock.meta.json')) {
      throw new Error(`expected meta sidecar to be removed, got: ${entries.join(', ')}`);
    }
  });
});

await scenario('acquireLock: storageRoot must exist before acquire', async () => {
  // Sanity check that the helper relies on the caller having ensured the
  // directory — this matches the runPreflight() ordering (ensureDir first).
  await withTempStorage(async (parent) => {
    const storageRoot = join(parent, 'nested');
    await mkdir(storageRoot, { recursive: true });
    const release = await acquireLock(storageRoot, join(storageRoot, '.lock'));
    await release();
  });
});

console.log('\nAll preflight smoke scenarios passed.');

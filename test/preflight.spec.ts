import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, PreflightError, projectKey } from '../src/server/preflight.js';

// Spawn a no-op child and wait for it to exit so we get a pid that is
// guaranteed dead at the moment the test reads it. Pid recycling on Linux/
// macOS does not reuse a freshly-exited pid within the lifetime of one test
// run, so this is reliable.
async function exitedChildPid(): Promise<number> {
  const child = spawn('/bin/sh', ['-c', 'exit 0']);
  if (typeof child.pid !== 'number') throw new Error('spawn did not return a pid');
  const pid = child.pid;
  await new Promise<void>((resolve) => child.on('exit', () => resolve()));
  return pid;
}

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

await scenario('acquireLock: surfaces ELOCKED as instance-running with rm -rf hint', async () => {
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
});

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

await scenario('acquireLock: reclaims a lock whose meta records a dead pid', async () => {
  await withTempStorage(async (storageRoot) => {
    const lockPath = join(storageRoot, '.lock');
    const metaPath = `${lockPath}.meta.json`;
    // Simulate the post-crash / killed-tsx-watch state: the lock directory is
    // still on disk (would normally trigger ELOCKED for 5 min) but the meta
    // sidecar points at a pid that is no longer alive AND its `lockIno`
    // fingerprint matches the live `.lock/` dir — i.e. the previous owner
    // wrote meta correctly before dying.
    await mkdir(lockPath);
    const lockStat = await stat(lockPath);
    const deadPid = await exitedChildPid();
    await writeFile(
      metaPath,
      JSON.stringify({
        pid: deadPid,
        port: 6800,
        startedAt: new Date().toISOString(),
        lockIno: lockStat.ino,
      }),
    );
    const release = await acquireLock(storageRoot, lockPath);
    try {
      const st = await stat(lockPath);
      if (!st.isDirectory()) {
        throw new Error('expected fresh lock directory after stale-pid reclaim');
      }
    } finally {
      await release();
    }
  });
});

await scenario('acquireLock: refuses to reclaim when meta records a live pid', async () => {
  await withTempStorage(async (storageRoot) => {
    const lockPath = join(storageRoot, '.lock');
    const metaPath = `${lockPath}.meta.json`;
    await mkdir(lockPath);
    const lockStat = await stat(lockPath);
    // pid 1 (init) always exists. process.kill(1, 0) typically throws EPERM
    // because we don't own init, which our liveness check correctly treats as
    // "still alive — do not reclaim".
    await writeFile(
      metaPath,
      JSON.stringify({
        pid: 1,
        port: 6800,
        startedAt: new Date().toISOString(),
        lockIno: lockStat.ino,
      }),
    );
    await expectPreflightError(
      async () => {
        await acquireLock(storageRoot, lockPath);
      },
      'instance-running',
      'rm -rf',
    );
  });
});

// --- P1: meta sidecar must be bound to the lock instance via its inode ----

await scenario('acquireLock: refuses to reclaim when meta lockIno does not match', async () => {
  // Simulates the P1 race: the meta sidecar survived a previous owner's
  // crash and its `lockIno` references a now-deleted `.lock/` directory.
  // The current `.lock/` dir was just created by another mdredd that has
  // not yet rewritten the meta. A racing third process must NOT reclaim
  // that fresh lock just because the stale meta records a dead pid.
  await withTempStorage(async (storageRoot) => {
    const lockPath = join(storageRoot, '.lock');
    const metaPath = `${lockPath}.meta.json`;
    await mkdir(lockPath);
    const liveStat = await stat(lockPath);
    const deadPid = await exitedChildPid();
    // Meta points at a *different* inode (simulating the previous owner's
    // lock dir before it was rm-rf'd and re-mkdir'd). Pid is dead.
    const staleIno = liveStat.ino + 999_999;
    await writeFile(
      metaPath,
      JSON.stringify({
        pid: deadPid,
        port: 6800,
        startedAt: new Date().toISOString(),
        lockIno: staleIno,
      }),
    );
    await expectPreflightError(
      async () => {
        await acquireLock(storageRoot, lockPath);
      },
      'instance-running',
      'rm -rf',
    );
    // The fresh lock directory must not have been wiped by the rejected
    // reclaim — the live owner is still represented on disk.
    const after = await stat(lockPath);
    if (!after.isDirectory()) throw new Error('expected lock dir to be left intact');
  });
});

await scenario(
  'acquireLock: refuses to reclaim when meta has no lockIno field at all',
  async () => {
    // Pre-fingerprint meta files (from older mdredd builds) carry no lockIno.
    // After the P1 hardening these must be treated as not-bound-to-this-lock
    // and never reclaimed automatically — fall through to the manual hint.
    await withTempStorage(async (storageRoot) => {
      const lockPath = join(storageRoot, '.lock');
      const metaPath = `${lockPath}.meta.json`;
      await mkdir(lockPath);
      const deadPid = await exitedChildPid();
      await writeFile(
        metaPath,
        JSON.stringify({ pid: deadPid, port: 6800, startedAt: new Date().toISOString() }),
      );
      await expectPreflightError(
        async () => {
          await acquireLock(storageRoot, lockPath);
        },
        'instance-running',
        'rm -rf',
      );
    });
  },
);

// --- meta written atomically inside acquireLock -------------------------

await scenario('acquireLock: writes meta sidecar with lockIno fingerprint on success', async () => {
  // After the P1 fix, acquireLock is responsible for writing the meta
  // sidecar — index.ts no longer holds the only writer. A reader hitting
  // ELOCKED right after acquire must be able to read a complete meta with
  // a lockIno that matches the live lock dir.
  await withTempStorage(async (storageRoot) => {
    const lockPath = join(storageRoot, '.lock');
    const metaPath = `${lockPath}.meta.json`;
    const release = await acquireLock(storageRoot, lockPath);
    try {
      const raw = JSON.parse(
        await (async () => {
          const { readFile: rf } = await import('node:fs/promises');
          return rf(metaPath, 'utf8');
        })(),
      ) as { pid: number; lockIno?: number; startedAt?: string };
      if (raw.pid !== process.pid) {
        throw new Error(`expected meta.pid=${process.pid}, got ${raw.pid}`);
      }
      const lockStat = await stat(lockPath);
      if (raw.lockIno !== lockStat.ino) {
        throw new Error(
          `expected meta.lockIno=${lockStat.ino} (live lock ino), got ${raw.lockIno}`,
        );
      }
    } finally {
      await release();
    }
  });
});

await scenario('acquireLock: releases the lock when meta write fails', async () => {
  // CLAUDE.md guarantees any thrown error during startup releases the
  // lock before exiting. Pre-create the meta path as a directory so the
  // atomic-rename inside writeMetaWithFingerprint fails — this stands in
  // for a transient FS error (disk full, EPERM, EIO) without monkey-
  // patching imports. Regression: previously the meta write was unguarded,
  // so a throw here leaked the `.lock/` dir for the full 5-minute stale
  // window and blocked restart.
  await withTempStorage(async (storageRoot) => {
    const lockPath = join(storageRoot, '.lock');
    const metaPath = `${lockPath}.meta.json`;
    await mkdir(metaPath);
    let threw = false;
    try {
      await acquireLock(storageRoot, lockPath);
    } catch {
      threw = true;
    }
    if (!threw) throw new Error('expected acquireLock to throw when meta write fails');
    const lockGone = await stat(lockPath).then(
      () => false,
      (err) => (err as { code?: string }).code === 'ENOENT',
    );
    if (!lockGone) {
      throw new Error('expected .lock directory to be released after meta write failure');
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

// P3 (post-reclaim ELOCKED race surfaces as instance-running) is verified by
// inspection rather than an explicit scenario — exercising the path requires
// a competing OS process to win a tryAcquire between our rm and our retry,
// which a same-process test cannot deterministically reproduce because
// proper-lockfile shares state between sibling calls. The production guard
// is a 5-line catch in `reclaimOrFail` that converts ELOCKED to PreflightError;
// any same-process unit test would test the wrapper, not the race.

// --- multi-directory: projectKey is stable + path-aware ----------------

await scenario('projectKey: same cwd → same key, different cwd → different key', async () => {
  const a1 = projectKey('/Users/me/projA');
  const a2 = projectKey('/Users/me/projA');
  const b = projectKey('/Users/me/projB');
  if (a1 !== a2) throw new Error(`same cwd should yield identical key: ${a1} vs ${a2}`);
  if (a1 === b) throw new Error(`different cwds should yield distinct keys: ${a1} === ${b}`);
  if (!/^[0-9a-f]{12}$/.test(a1)) {
    throw new Error(`expected 12-hex-char key, got ${a1}`);
  }
});

await scenario('projectKey: normalizes redundant path components', async () => {
  // `resolve()` collapses `./` and `..` so `/Users/me/projA/./` == `/Users/me/projA`.
  // Two paths that resolve to the same canonical form must share a key.
  const a = projectKey('/Users/me/projA');
  const b = projectKey('/Users/me/projA/');
  const c = projectKey('/Users/me/projB/../projA');
  if (a !== b || a !== c) {
    throw new Error(`expected normalized paths to share a key, got ${a}/${b}/${c}`);
  }
});

await scenario('two locks on different storageRoots can be held simultaneously', async () => {
  // Confirms the multi-directory invariant: two mdredds in different cwds
  // (each with its own per-project storageRoot) never compete for the same
  // lock and can both run at once. Without per-project scoping this test
  // would deadlock — the second acquire would block on the first.
  await withTempStorage(async (parentA) => {
    await withTempStorage(async (parentB) => {
      const lockA = join(parentA, '.lock');
      const lockB = join(parentB, '.lock');
      const releaseA = await acquireLock(parentA, lockA);
      try {
        const releaseB = await acquireLock(parentB, lockB);
        await releaseB();
      } finally {
        await releaseA();
      }
    });
  });
});

console.log('\nAll preflight smoke scenarios passed.');

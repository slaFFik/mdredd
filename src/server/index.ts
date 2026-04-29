import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import getPort from 'get-port';
import open from 'open';
import { runPreflight, writeLockMeta } from './preflight.js';
import { SessionStore } from './session.js';
import { RunManager } from './runManager.js';
import { createRouter } from './routes.js';
import { makeAuthContext } from './security.js';
import { log } from './log.js';

const DEFAULT_PREF_PORT = 6800;
// Hardcoded against vite.config.ts (strictPort:true) so dev runs always use
// the same port. If that constant moves, this one has to move with it.
const VITE_DEV_PORT = 5173;
// True when running through tsx watch (file URL is .ts), false when running
// the compiled bundle (.js). The compiled bundle serves dist/web/, which is
// self-contained; the source-mode server cannot serve src/web/index.html
// without Vite's transform pipeline. So in dev we point the printed URL and
// auto-open at Vite instead, where /api and /sse proxy back to mdredd.
const isDev = import.meta.url.endsWith('.ts');

async function main(): Promise<void> {
  const cwd = process.cwd();
  const claudeBin = process.env.CLAUDE_BIN ?? 'claude';
  const force = process.argv.includes('--force');
  const shouldOpen = !process.argv.includes('--no-open');

  let preflight;
  try {
    preflight = await runPreflight({ cwd, claudeBin, force });
  } catch (err) {
    const e = err as { code?: string; message: string; hint?: string };
    console.error(`mdredd: ${e.code ?? 'error'} — ${e.message}`);
    if (e.hint) console.error(`hint: ${e.hint}`);
    process.exit(1);
  }

  // The lock is owned from this point forward; release it on any failure so
  // a botched startup doesn't leave a stale lock blocking subsequent runs
  // until the staleness window expires.
  try {
    const sessionStore = await SessionStore.load(preflight.storageRoot, cwd);
    const port = await getPort({ port: [DEFAULT_PREF_PORT, 6801, 6802, 6803, 6804, 0] });
    const auth = makeAuthContext(port);

    const runManager = new RunManager({
      claudeBin,
      cwd,
      storageRoot: preflight.storageRoot,
      session: sessionStore,
    });
    await runManager.init();

    const webRoot = resolveWebRoot();
    const handler = createRouter({ auth, session: sessionStore, runManager, webRoot, cwd });

    const server = createServer((req, res) => {
      Promise.resolve(handler(req, res)).catch((err) => {
        log.error('http.handler-rejected', { error: (err as Error).message });
        try {
          res.statusCode = 500;
          res.end();
        } catch {
          /* */
        }
      });
    });

    // Bind failures (EADDRINUSE/EACCES) surface via the 'error' event, not
    // the listen callback. Without this handler Node would emit an unhandled
    // 'error' and exit while still holding the proper-lockfile lock,
    // blocking restarts until the stale window expires.
    server.once('error', (err) => {
      console.error(`mdredd: failed to bind ${port}: ${err.message}`);
      log.error('server.listen-error', { port, error: err.message });
      void preflight.releaseLock().finally(() => process.exit(1));
    });

    server.listen(port, '127.0.0.1', () => {
      // Keep this callback synchronous so a writeLockMeta rejection cannot
      // escape as an unhandled promise rejection. On failure release the
      // lock (we just acquired it but never wrote the sidecar) and exit.
      writeLockMeta(preflight.lockFilePath, process.pid, port)
        .then(() => {
          const apiUrl = `http://127.0.0.1:${auth.port}/`;
          const devUrl = `http://127.0.0.1:${VITE_DEV_PORT}/`;
          const browserUrl = isDev ? devUrl : apiUrl;
          log.info('server.listening', { url: apiUrl, pid: process.pid });
          console.log(`mdredd listening at ${apiUrl}`);
          if (isDev) {
            console.log(`open in browser (Vite + HMR): ${devUrl}`);
          }
          if (shouldOpen) {
            void maybeOpen(browserUrl, isDev, preflight.storageRoot);
          }
        })
        .catch((err) => {
          console.error(`mdredd: could not write lock metadata: ${(err as Error).message}`);
          log.error('server.lock-meta-failed', { error: (err as Error).message });
          void preflight.releaseLock().finally(() => process.exit(1));
        });
    });

    // 5s for runners to drain (each runner self-bounds at SIGTERM+2s SIGKILL),
    // plus 3s slack for lockfile / FS work. Anything still hanging past the hard
    // timer is force-exited so a stuck child can never wedge the server.
    const STOP_RUNNERS_TIMEOUT_MS = 5_000;
    const HARD_SHUTDOWN_TIMEOUT_MS = 8_000;

    let shuttingDown = false;
    const shutdown = async (sig: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      log.info('server.shutdown', { signal: sig, activeRuns: runManager.activeCount() });
      const hardTimer = setTimeout(() => {
        log.error('server.shutdown-forced-exit', { reason: 'hard timeout exceeded' });
        process.exit(1);
      }, HARD_SHUTDOWN_TIMEOUT_MS);
      hardTimer.unref();
      try {
        // Stop accepting new HTTP traffic and drop existing keep-alive/SSE
        // connections so the server's `listening` socket and the SSE keepers
        // don't hold the event loop open.
        server.close();
        server.closeAllConnections?.();
        const result = await runManager.stopAll(STOP_RUNNERS_TIMEOUT_MS);
        if (result.timedOut) {
          log.warn('server.shutdown.stopAll-timeout', { stopped: result.stopped });
        }
        await preflight.releaseLock();
      } catch (err) {
        log.error('server.shutdown-error', { error: (err as Error).message });
      } finally {
        clearTimeout(hardTimer);
      }
      process.exit(0);
    };
    process.on('SIGINT', () => {
      void shutdown('SIGINT');
    });
    process.on('SIGTERM', () => {
      void shutdown('SIGTERM');
    });
  } catch (err) {
    await preflight.releaseLock().catch(() => undefined);
    throw err;
  }
}

function resolveWebRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // When compiled, this file lives at dist/server/index.js, so the web bundle
  // is at dist/web/ (one level up, then into web).
  return resolve(here, '..', 'web');
}

// Open the browser unless this is a tsx-watch-triggered dev restart. The URL
// is stable across restarts (same-origin auth, no per-launch token), so the
// already-open tab keeps working — repeated `open()` calls would just spam new
// tabs/windows on each save. Prod launches always open: there is no restart
// loop, so the user reaches mdredd through this path on purpose.
async function maybeOpen(url: string, isDev: boolean, storageRoot: string): Promise<void> {
  if (isDev && (await isDevRestartFromSameWatcher(storageRoot))) return;
  try {
    await open(url);
  } catch (err) {
    console.log(`(could not open browser automatically: ${(err as Error).message})`);
  }
}

// True iff a marker file under storageRoot records a previous launch with the
// same parent pid as this process. tsx-watch is the parent across restarts of
// the same `npm run dev` invocation, so a matching parent pid means "this is a
// hot-restart, the user already has the tab open." A different (or absent)
// parent pid means a fresh `npm run dev` was launched — open the browser.
async function isDevRestartFromSameWatcher(storageRoot: string): Promise<boolean> {
  const markerPath = join(storageRoot, '.dev-open-marker');
  const ppid = process.ppid;
  let isRestart = false;
  try {
    const raw = await readFile(markerPath, 'utf8');
    const parsed = JSON.parse(raw) as { parentPid?: number };
    if (parsed.parentPid === ppid) isRestart = true;
  } catch {
    /* missing/malformed marker: treat as first launch */
  }
  // Refresh the marker so the *next* restart finds our pid. Best-effort write:
  // a failure only causes one redundant browser open, never a broken launch.
  try {
    await writeFile(markerPath, JSON.stringify({ parentPid: ppid }), 'utf8');
  } catch {
    /* swallow */
  }
  return isRestart;
}

main().catch((err) => {
  console.error('mdredd: fatal', err);
  process.exit(1);
});

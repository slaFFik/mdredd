import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import getPort from 'get-port';
import open from 'open';
import { runPreflight, writeLockMeta } from './preflight.js';
import { SessionStore } from './session.js';
import { RunManager } from './runManager.js';
import { createRouter } from './routes.js';
import { makeAuthContext } from './security.js';
import { log } from './log.js';

const DEFAULT_PREF_PORT = 6800;

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

    server.listen(port, '127.0.0.1', async () => {
      await writeLockMeta(preflight.lockFilePath, process.pid, port);
      const url = `${auth.origin}/?t=${auth.token}`;
      log.info('server.listening', { url, pid: process.pid });
      console.log(`mdredd listening at ${url}`);
      if (shouldOpen) {
        open(url).catch((err) => {
          console.log(`(could not open browser automatically: ${err.message})`);
        });
      }
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

main().catch((err) => {
  console.error('mdredd: fatal', err);
  process.exit(1);
});

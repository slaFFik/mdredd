import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import getPort from 'get-port';
import open from 'open';
import { runPreflight, writeLock, releaseLock } from './preflight.js';
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

  const sessionStore = await SessionStore.load(preflight.storageRoot, cwd);
  const port = await getPort({ port: [DEFAULT_PREF_PORT, 6801, 6802, 6803, 6804, 0] });
  const auth = makeAuthContext(port);

  const runManager = new RunManager({ claudeBin, cwd, storageRoot: preflight.storageRoot, session: sessionStore });
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
    await writeLock(preflight.lockFilePath, process.pid, port);
    const url = `${auth.origin}/?t=${auth.token}`;
    log.info('server.listening', { url, pid: process.pid });
    console.log(`mdredd listening at ${url}`);
    if (shouldOpen) {
      open(url).catch((err) => {
        console.log(`(could not open browser automatically: ${err.message})`);
      });
    }
  });

  const shutdown = async (sig: string): Promise<void> => {
    log.info('server.shutdown', { signal: sig });
    server.close();
    await releaseLock(preflight.lockFilePath);
    process.exit(0);
  };
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
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

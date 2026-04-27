import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionStore } from './session.js';
import { RunManager, RunManagerError } from './runManager.js';
import {
  type AuthContext,
  extractTokenFromRequest,
  isMutatingMethod,
  originMatches,
  tokenMatches,
} from './security.js';
import { log } from './log.js';
import { HEARTBEAT_INTERVAL_MS } from '@shared/constants.js';
import { MAX_COLUMNS, makeBlankColumn, type ColumnConfig } from '@shared/schemas/session.js';
import { EffortSchema, ModeSchema, type ColumnStatus } from '@shared/schemas/types.js';
import { VariantTypeSchema } from '@shared/schemas/types.js';
import { defaultEffortForModel, effortLevelsForModel } from '@shared/constants.js';
import type { ServerSseEvent } from '@shared/schemas/events.js';
import { listLocalAgents, listLocalSkills } from './localVariants.js';
import { FsBrowserError, listDir, readFileCapped } from './fsBrowser.js';

export interface RouteDeps {
  auth: AuthContext;
  session: SessionStore;
  runManager: RunManager;
  webRoot: string; // dist/web absolute path
  cwd: string; // user project cwd — used to scan .claude/skills and .claude/agents
  includePartialBuild?: boolean;
}

export function createRouter(deps: RouteDeps) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const path = url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();

    try {
      // Auth: token is required on API + SSE; static assets (the SPA bundle) are token-free
      // so the browser can load them without injecting tokens into asset URLs.
      const requiresToken = path.startsWith('/api/') || path === '/sse';
      if (requiresToken) {
        const token = extractTokenFromRequest(req);
        if (!tokenMatches(deps.auth.token, token)) {
          return json(res, 401, { error: 'unauthorized' });
        }
      }
      if (isMutatingMethod(method)) {
        if (!originMatches(deps.auth.origin, req.headers.origin as string | undefined)) {
          return json(res, 403, { error: 'bad origin' });
        }
      }

      if (path === '/api/fs/list' && method === 'GET') {
        const rel = url.searchParams.get('path') ?? '';
        try {
          const result = await listDir(deps.cwd, rel);
          return json(res, 200, result);
        } catch (err) {
          if (err instanceof FsBrowserError) {
            return json(res, 400, { error: err.code, message: err.message });
          }
          throw err;
        }
      }

      if (path === '/api/fs/read' && method === 'GET') {
        const rel = url.searchParams.get('path') ?? '';
        try {
          const result = await readFileCapped(deps.cwd, rel);
          return json(res, 200, result);
        } catch (err) {
          if (err instanceof FsBrowserError) {
            return json(res, 400, { error: err.code, message: err.message });
          }
          throw err;
        }
      }

      if (path === '/api/local-variants' && method === 'GET') {
        const [skills, agents] = await Promise.all([
          listLocalSkills(deps.cwd),
          listLocalAgents(deps.cwd),
        ]);
        return json(res, 200, { skills, agents });
      }

      if (path === '/api/state' && method === 'GET') {
        const snap = await deps.session.assembleSnapshot();
        return json(res, 200, {
          ...snap,
          activeStatuses: buildActiveStatusMap(snap.session.columns, deps.runManager, snap.runs),
        });
      }

      if (path === '/api/run' && method === 'POST') {
        const body = await readJsonBody<{ columnId: string }>(req);
        const cfg = await deps.runManager.startColumn(body.columnId);
        return json(res, 200, { ok: true, runFolder: cfg.runFolder });
      }

      if (path === '/api/stop' && method === 'POST') {
        const body = await readJsonBody<{ columnId: string }>(req);
        await deps.runManager.stopColumn(body.columnId);
        return json(res, 200, { ok: true });
      }

      if (path === '/api/session' && method === 'PATCH') {
        const body = await readJsonBody<PatchSessionBody>(req);
        const updated = await deps.session.mutate((s) => {
          if (body.mode !== undefined) s.mode = ModeSchema.parse(body.mode);
          if (body.judgeEnabled !== undefined) s.judgeEnabled = Boolean(body.judgeEnabled);
          if (body.defaultModel !== undefined) s.defaultModel = String(body.defaultModel);
        });
        return json(res, 200, updated);
      }

      const colMatch = path.match(/^\/api\/session\/columns\/([^/]+)$/);
      if (colMatch && method === 'PATCH') {
        const columnId = colMatch[1]!;
        const body = await readJsonBody<Partial<ColumnConfig>>(req);
        await deps.session.mutate((s) => {
          const col = s.columns.find((c) => c.id === columnId);
          if (!col) throw new RunManagerError('column-not-found', 'unknown column', 404);
          if (body.variantName !== undefined) col.variantName = String(body.variantName);
          if (body.variantType !== undefined)
            col.variantType = VariantTypeSchema.parse(body.variantType);
          if (body.skillOrAgentName !== undefined)
            col.skillOrAgentName = body.skillOrAgentName as string | null;
          if (body.variantContent !== undefined) col.variantContent = String(body.variantContent);
          if (body.prompt !== undefined) col.prompt = String(body.prompt);
          if (body.model !== undefined) col.model = String(body.model);
          if (body.effort !== undefined) {
            col.effort = body.effort === null ? null : EffortSchema.parse(body.effort);
          }
          // Normalize effort against the (possibly just-updated) model. Belt
          // and suspenders against a client that forgets to clear effort when
          // switching to a model that doesn't support the current value
          // (e.g. opus→sonnet leaves `xhigh` orphaned, since sonnet rejects it).
          const allowed = effortLevelsForModel(col.model);
          if (allowed.length === 0) {
            col.effort = null;
          } else if (col.effort && !allowed.includes(col.effort)) {
            col.effort = defaultEffortForModel(col.model);
          }
        });
        return json(res, 200, { ok: true });
      }

      if (path === '/api/columns' && method === 'POST') {
        const updated = await deps.session.mutate((s) => {
          if (s.columns.length >= MAX_COLUMNS) {
            throw new RunManagerError('column-cap', 'column cap reached', 400);
          }
          const existingIds = new Set(s.columns.map((c) => c.id));
          let idx = s.columns.length + 1;
          while (existingIds.has(`col-${idx}`)) idx += 1;
          s.columns.push(makeBlankColumn(`col-${idx}`, s.defaultModel));
        });
        return json(res, 200, updated);
      }

      const colDeleteMatch = path.match(/^\/api\/columns\/([^/]+)$/);
      if (colDeleteMatch && method === 'DELETE') {
        const columnId = colDeleteMatch[1]!;
        // Refuse to delete a column with an active run — otherwise the
        // subprocess would keep streaming, the UI would hide its Stop button,
        // and the user would be paying for tokens against an invisible run.
        if (deps.runManager.isColumnActive(columnId)) {
          return json(res, 409, {
            error: 'column-active',
            message: 'stop the active run before deleting the column',
          });
        }
        const updated = await deps.session.mutate((s) => {
          if (s.columns.length <= 1) {
            throw new RunManagerError('last-column', 'cannot delete last column', 400);
          }
          const idx = s.columns.findIndex((c) => c.id === columnId);
          if (idx < 0) throw new RunManagerError('column-not-found', 'unknown column', 404);
          s.columns.splice(idx, 1);
        });
        return json(res, 200, updated);
      }

      if (path === '/api/start-new' && method === 'POST') {
        if (deps.runManager.hasActive()) {
          return json(res, 409, { error: 'cannot start new while runs are active' });
        }
        await deps.session.startNew();
        return json(res, 200, { ok: true });
      }

      if (path === '/sse' && method === 'GET') {
        return handleSse(req, res, deps);
      }

      if (path === '/health' && method === 'GET') {
        return json(res, 200, { ok: true });
      }

      // Fallback: serve static web bundle.
      if (method === 'GET') {
        return serveStatic(path, res, deps);
      }

      return json(res, 404, { error: 'not found' });
    } catch (err) {
      if (err instanceof RunManagerError) {
        return json(res, err.httpStatus, { error: err.code, message: err.message });
      }
      log.error('route.unhandled', { path, error: (err as Error).message });
      return json(res, 500, { error: 'internal', message: (err as Error).message });
    }
  };
}

interface PatchSessionBody {
  mode?: string;
  judgeEnabled?: boolean;
  defaultModel?: string;
}

function buildActiveStatusMap(
  cols: ColumnConfig[],
  rm: RunManager,
  runs: Record<string, { config: { status: string } }>,
): Record<string, ColumnStatus> {
  const m: Record<string, ColumnStatus> = {};
  for (const c of cols) {
    const active = rm.getActiveStatus(c.id);
    if (active !== 'idle') {
      m[c.id] = active as ColumnStatus;
      continue;
    }
    // Inactive column: reflect the terminal status of its most recent run if any.
    const folder = c.currentRunFolder;
    if (folder && runs[folder]) {
      m[c.id] = runs[folder].config.status as ColumnStatus;
    } else {
      m[c.id] = 'idle';
    }
  }
  return m;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        req.destroy();
        reject(new Error('request body too large'));
      }
    });
    req.on('end', () => {
      if (!data) return resolve({} as T);
      try {
        resolve(JSON.parse(data) as T);
      } catch (err) {
        reject(new Error(`invalid JSON body: ${(err as Error).message}`));
      }
    });
    req.on('error', reject);
  });
}

function handleSse(_req: IncomingMessage, res: ServerResponse, deps: RouteDeps): void {
  const lastId = Number(_req.headers['last-event-id'] ?? 0);
  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('connection', 'keep-alive');
  res.flushHeaders?.();

  const write = (event: ServerSseEvent): void => {
    res.write(`id: ${event.seq}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Initial comment keeps EventSource open across proxies.
  res.write(': connected\n\n');

  const unsubscribe = deps.runManager.subscribe({
    lastEventId: Number.isFinite(lastId) && lastId > 0 ? lastId : 0,
    onEvent: (e) => {
      try {
        write(e);
      } catch (err) {
        log.warn('sse.write-failed', { error: (err as Error).message });
      }
    },
    onClose: () => {
      try {
        res.end();
      } catch {
        /* */
      }
    },
  });

  const hb = setInterval(() => deps.runManager.emitHeartbeat(), HEARTBEAT_INTERVAL_MS);

  res.on('close', () => {
    clearInterval(hb);
    unsubscribe();
  });
}

async function serveStatic(urlPath: string, res: ServerResponse, deps: RouteDeps): Promise<void> {
  const requested = urlPath === '/' ? '/index.html' : urlPath;
  const safe = resolveSafe(deps.webRoot, requested);
  if (!safe) {
    return fallbackHtml(res, deps);
  }
  try {
    const data = await readFile(safe);
    const ext = extname(safe).toLowerCase();
    const type = MIME_TYPES[ext] ?? 'application/octet-stream';
    res.statusCode = 200;
    res.setHeader('content-type', type);
    res.setHeader('cache-control', 'no-cache');
    res.end(data);
  } catch {
    // Fallback: SPA 404 — serve index.html so client router can handle.
    return fallbackHtml(res, deps);
  }
}

async function fallbackHtml(res: ServerResponse, deps: RouteDeps): Promise<void> {
  const index = join(deps.webRoot, 'index.html');
  try {
    const html = await readFile(index, 'utf8');
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(html);
  } catch {
    res.statusCode = 503;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end('mdredd web bundle is missing. Run `npm run build` (or `npm run dev:web` in dev).');
  }
}

function resolveSafe(root: string, urlPath: string): string | null {
  const cleaned = urlPath.replace(/\?.*$/, '').replace(/\/+$/, '');
  const rel = cleaned.replace(/^\/+/, '');
  const target = resolve(root, rel);
  if (target !== root && !target.startsWith(root + '/')) return null;
  return target;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

// Suppress unused import warning for fileURLToPath if the dev harness changes.
void fileURLToPath;

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRouter, type RouteDeps } from '../src/server/routes.js';
import { makeAuthContext } from '../src/server/security.js';
import { makeDefaultSession } from '@shared/schemas/session.js';

// Router-level integration coverage for the auth gate. The helper-only
// suite in test/security.spec.ts checks that originMatches/hostMatches do
// the right thing in isolation; this spec verifies that the wiring inside
// createRouter actually applies the documented policy: Host always required;
// Origin required on mutating; Origin optional on GET/HEAD but pinned when
// present. Codex flagged the test gap during the 2026-04-29 review.

const PORT = 6800;
const auth = makeAuthContext(PORT);

interface MockReq {
  url: string;
  method: string;
  headers: Record<string, string | undefined>;
  on(event: string, handler: (...args: unknown[]) => void): MockReq;
  destroy(): void;
}

// Minimal IncomingMessage stub. The auth gate only reads url/method/headers,
// so 'data'/'end' handlers never fire on the 403 path. For the positive POST
// path we still need to simulate a body so readJsonBody can resolve — done
// via the data/end handler list captured here.
function makeReq(
  method: string,
  url: string,
  headers: Record<string, string | undefined>,
): MockReq & { _emitEnd(body?: string): void } {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  return {
    url,
    method,
    headers,
    on(event, handler) {
      (handlers[event] ??= []).push(handler);
      return this;
    },
    destroy() {},
    _emitEnd(body = '') {
      for (const h of handlers.data ?? []) h(body);
      for (const h of handlers.end ?? []) h();
    },
  };
}

class MockRes {
  statusCode = 0;
  body = '';
  finished = false;
  headers: Record<string, string> = {};
  setHeader(k: string, v: string): void {
    this.headers[k] = v;
  }
  end(s?: string): void {
    if (s !== undefined) this.body = s;
    this.finished = true;
  }
}

// Stubs that satisfy the path handlers we exercise — assembleSnapshot for
// GET /api/state, and hasActive/startNew for POST /api/start-new. Returning
// a sane default-shaped session keeps buildActiveStatusMap from blowing up
// on undefined fields.
function makeDeps(overrides: Partial<RouteDeps> = {}): RouteDeps {
  const session = {
    async assembleSnapshot() {
      return { session: makeDefaultSession('/tmp'), runs: {} };
    },
    async startNew() {},
  };
  const runManager = {
    getActiveStatus: () => 'idle',
    hasActive: () => false,
  };
  return {
    auth,
    session: session as unknown as RouteDeps['session'],
    runManager: runManager as unknown as RouteDeps['runManager'],
    webRoot: '/tmp/web',
    cwd: '/tmp/cwd',
    ...overrides,
  };
}

const queue: { name: string; run: () => void | Promise<void> }[] = [];
function scenario(name: string, run: () => void | Promise<void>): void {
  queue.push({ name, run });
}

async function runAllScenarios(): Promise<void> {
  for (const { name, run } of queue) {
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
}

async function callRouter(
  deps: RouteDeps,
  method: string,
  path: string,
  headers: Record<string, string | undefined>,
): Promise<MockRes> {
  const handle = createRouter(deps);
  const req = makeReq(method, path, headers);
  const res = new MockRes();
  // Fire 'end' on next tick so any readJsonBody await resolves with empty body.
  // Auth-rejection paths return before the handler reads the body, so this is
  // a no-op there; positive POST paths depend on it.
  setImmediate(() => req._emitEnd(''));
  await handle(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  return res;
}

const VALID_HOST = `127.0.0.1:${PORT}`;
const VALID_ORIGIN = `http://127.0.0.1:${PORT}`;

// --- GET /api/state ---------------------------------------------------------

scenario('GET /api/state with valid Host and NO Origin → auth gate passes', async () => {
  // Real-world prod scenario: SPA loaded from `http://127.0.0.1:6800/`,
  // browser issues a same-origin GET fetch. Some browsers omit Origin on
  // same-origin GETs (per Fetch spec). The gate must accept this.
  const res = await callRouter(makeDeps(), 'GET', '/api/state', { host: VALID_HOST });
  if (res.statusCode === 403) {
    throw new Error(`expected gate to pass on GET without Origin; got 403 body=${res.body}`);
  }
});

scenario('GET /api/state with bad Host → 403 bad host', async () => {
  // DNS-rebinding scenario: attacker's evil.com resolves to 127.0.0.1 but the
  // browser sends the address-bar host in the Host header.
  const res = await callRouter(makeDeps(), 'GET', '/api/state', {
    host: 'evil.com:6800',
    origin: VALID_ORIGIN,
  });
  if (res.statusCode !== 403) {
    throw new Error(`expected 403 on bad Host, got ${res.statusCode} ${res.body}`);
  }
  if (!res.body.includes('bad host')) {
    throw new Error(`expected "bad host" in body; got ${res.body}`);
  }
});

scenario('GET /api/state with valid Host but bad Origin → 403 bad origin', async () => {
  // Cross-origin GET that DID send Origin (Chrome behaviour). Even on a
  // non-mutating method, a non-empty wrong Origin is still hostile.
  const res = await callRouter(makeDeps(), 'GET', '/api/state', {
    host: VALID_HOST,
    origin: 'https://evil.com',
  });
  if (res.statusCode !== 403) {
    throw new Error(`expected 403 on bad Origin GET, got ${res.statusCode} ${res.body}`);
  }
  if (!res.body.includes('bad origin')) {
    throw new Error(`expected "bad origin" in body; got ${res.body}`);
  }
});

scenario('GET /api/state with no Host header → 403 bad host', async () => {
  // Defensive: a request that somehow arrives without a Host header should
  // be rejected (browsers always send it; absence implies hand-crafted).
  const res = await callRouter(makeDeps(), 'GET', '/api/state', {});
  if (res.statusCode !== 403) {
    throw new Error(`expected 403 on missing Host, got ${res.statusCode}`);
  }
});

// --- POST /api/start-new ----------------------------------------------------

scenario('POST /api/start-new with valid Host, NO Origin → 403 bad origin', async () => {
  // Mutating methods always include Origin per the Fetch spec, so a missing
  // Origin is a strong signal of a hand-crafted CSRF probe.
  const res = await callRouter(makeDeps(), 'POST', '/api/start-new', { host: VALID_HOST });
  if (res.statusCode !== 403) {
    throw new Error(`expected 403 on POST without Origin, got ${res.statusCode} ${res.body}`);
  }
  if (!res.body.includes('bad origin')) {
    throw new Error(`expected "bad origin" in body; got ${res.body}`);
  }
});

scenario('POST /api/start-new with valid Host + bad Origin → 403 bad origin', async () => {
  const res = await callRouter(makeDeps(), 'POST', '/api/start-new', {
    host: VALID_HOST,
    origin: 'https://evil.com',
  });
  if (res.statusCode !== 403) {
    throw new Error(`expected 403 on bad POST Origin, got ${res.statusCode} ${res.body}`);
  }
});

scenario('POST /api/start-new with valid Host + valid Origin → auth gate passes', async () => {
  // localhost-form Origin must also be accepted (the SPA is reachable via
  // either form; both are in allowedOrigins).
  const res = await callRouter(makeDeps(), 'POST', '/api/start-new', {
    host: VALID_HOST,
    origin: `http://localhost:${PORT}`,
  });
  if (res.statusCode === 403) {
    throw new Error(`expected gate to pass on valid POST Origin, got 403 body=${res.body}`);
  }
});

// --- /sse -------------------------------------------------------------------

scenario('GET /sse with bad Host → 403 bad host', async () => {
  // /sse is an authenticated route just like /api/*; the same gate applies.
  // EventSource does send Origin, so a bad Host in a rebinding attempt is
  // the realistic threat model.
  const res = await callRouter(makeDeps(), 'GET', '/sse', {
    host: 'evil.com:6800',
    origin: VALID_ORIGIN,
  });
  if (res.statusCode !== 403) {
    throw new Error(`expected 403 on bad SSE Host, got ${res.statusCode}`);
  }
});

// --- static / unauthenticated paths ----------------------------------------

scenario('GET /health (unauthenticated) bypasses Host/Origin gate', async () => {
  // /health is intentionally unauthenticated so curl-based liveness probes
  // work without forging headers. Verify the gate isn't accidentally applied
  // to non-/api/, non-/sse paths.
  const res = await callRouter(makeDeps(), 'GET', '/health', {
    host: 'evil.com:6800',
    origin: 'https://evil.com',
  });
  if (res.statusCode === 403) {
    throw new Error(`/health should not be subject to the auth gate; got 403`);
  }
});

await runAllScenarios();
console.log('\nAll routes scenarios passed.');

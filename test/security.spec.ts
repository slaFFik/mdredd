import { hostMatches, makeAuthContext, originMatches } from '../src/server/security.js';

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

const PORT = 6800;
const ctx = makeAuthContext(PORT);

// --- originMatches ----------------------------------------------------------

scenario('originMatches: 127.0.0.1 form passes', () => {
  if (!originMatches(ctx.allowedOrigins, 'http://127.0.0.1:6800')) throw new Error('expected pass');
});

scenario('originMatches: localhost form ALSO passes', () => {
  // Both forms are accepted now (review fix): the user may type either URL,
  // and rejecting one would silently break the SPA on a cosmetic UX choice.
  if (!originMatches(ctx.allowedOrigins, 'http://localhost:6800'))
    throw new Error('expected pass on localhost-form Origin');
});

scenario('originMatches: missing header rejected', () => {
  if (originMatches(ctx.allowedOrigins, undefined))
    throw new Error('expected reject on missing header');
});

scenario('originMatches: empty string rejected', () => {
  if (originMatches(ctx.allowedOrigins, '')) throw new Error('expected reject on empty header');
});

scenario('originMatches: different scheme rejected', () => {
  if (originMatches(ctx.allowedOrigins, 'https://127.0.0.1:6800'))
    throw new Error('expected reject on https');
});

scenario('originMatches: different port rejected', () => {
  if (originMatches(ctx.allowedOrigins, 'http://127.0.0.1:6801'))
    throw new Error('expected reject on diff port');
});

scenario('originMatches: trailing slash rejected', () => {
  if (originMatches(ctx.allowedOrigins, 'http://127.0.0.1:6800/'))
    throw new Error('expected reject on trailing slash');
});

scenario('originMatches: cross-origin website rejected', () => {
  if (originMatches(ctx.allowedOrigins, 'https://evil.com')) throw new Error('expected reject');
});

// --- hostMatches ------------------------------------------------------------

scenario('hostMatches: 127.0.0.1:port passes', () => {
  if (!hostMatches(ctx.allowedHosts, '127.0.0.1:6800')) throw new Error('expected pass');
});

scenario('hostMatches: localhost:port passes', () => {
  if (!hostMatches(ctx.allowedHosts, 'localhost:6800')) throw new Error('expected pass');
});

scenario('hostMatches: uppercase host normalised', () => {
  if (!hostMatches(ctx.allowedHosts, 'LOCALHOST:6800'))
    throw new Error('expected case-insensitive pass on hostname');
});

scenario('hostMatches: missing header rejected', () => {
  if (hostMatches(ctx.allowedHosts, undefined)) throw new Error('expected reject on missing');
});

scenario('hostMatches: bare hostname (no port) rejected', () => {
  // Browsers always include the port in Host when the URL has one. A bare
  // hostname suggests something hand-crafted; reject conservatively.
  if (hostMatches(ctx.allowedHosts, '127.0.0.1')) throw new Error('expected reject on no-port');
});

scenario('hostMatches: different port rejected', () => {
  if (hostMatches(ctx.allowedHosts, '127.0.0.1:6801'))
    throw new Error('expected reject on diff port');
});

scenario('hostMatches: rebound attacker domain rejected', () => {
  // The rebinding scenario: DNS resolves evil.com to 127.0.0.1, but the
  // browser's Host header reflects the address-bar host, not the resolved IP.
  if (hostMatches(ctx.allowedHosts, 'evil.com:6800')) throw new Error('expected reject');
});

scenario('hostMatches: ipv6 loopback NOT in allowlist (we only bind ipv4)', () => {
  // The server binds 127.0.0.1 (ipv4 only); it never receives requests on
  // [::1] under normal operation. If a future change adds ipv6 binding, the
  // allowlist needs to grow to include `[::1]:port` and this test becomes
  // a regression marker for the missing entry.
  if (hostMatches(ctx.allowedHosts, '[::1]:6800')) throw new Error('expected reject');
});

scenario('hostMatches: trailing-dot localhost rejected (known UX papercut)', () => {
  // RFC-correct trailing-dot FQDN is treated by the browser as a distinct
  // Host string. We don't normalise it, so `localhost.:6800` 403s. Documented
  // here so a future change either accepts it or stays explicit about not.
  if (hostMatches(ctx.allowedHosts, 'localhost.:6800')) throw new Error('expected reject');
});

await runAllScenarios();
console.log('\nAll security scenarios passed.');

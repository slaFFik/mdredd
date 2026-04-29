export interface AuthContext {
  port: number;
  // Allowed Origin values. The SPA may be served from either `http://127.0.0.1`
  // or `http://localhost`, so both must be accepted; Vite's dev proxy injects
  // the canonical 127.0.0.1 form when forwarding from :5173. An attacker-page
  // Origin (`https://evil.com`, etc.) is not in this set.
  allowedOrigins: ReadonlySet<string>;
  // Host header values we accept on protected routes. Browsers send
  // `Host: <host>:<port>` matching the address bar; an attacker-controlled
  // domain rebound to 127.0.0.1 arrives here as e.g. `evil.com:<port>` and
  // gets refused before any handler runs. Hostnames are case-insensitive,
  // so we match against lowercased values.
  allowedHosts: ReadonlySet<string>;
}

export function makeAuthContext(port: number): AuthContext {
  return {
    port,
    allowedOrigins: new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]),
    allowedHosts: new Set([`127.0.0.1:${port}`, `localhost:${port}`]),
  };
}

export function originMatches(allowed: ReadonlySet<string>, header: string | undefined): boolean {
  if (!header) return false;
  return allowed.has(header);
}

export function hostMatches(allowed: ReadonlySet<string>, header: string | undefined): boolean {
  if (!header) return false;
  return allowed.has(header.toLowerCase());
}

// Methods that the Fetch spec guarantees include the `Origin` header. We use
// this to enforce origin pinning ONLY on mutating requests. Same-origin GET/HEAD
// may legitimately omit Origin (per the Fetch spec — Chrome sends it, Firefox
// and Safari sometimes don't), so requiring Origin on those would 403 the SPA's
// own initial reads in prod where there is no Vite proxy to inject one.
export function isMutatingMethod(method: string | undefined): boolean {
  if (!method) return false;
  const m = method.toUpperCase();
  return m === 'POST' || m === 'PUT' || m === 'DELETE' || m === 'PATCH';
}

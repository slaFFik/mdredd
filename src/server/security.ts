import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export interface AuthContext {
  token: string;
  port: number;
  origin: string;
}

export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function makeAuthContext(port: number): AuthContext {
  const token = generateSessionToken();
  const origin = `http://127.0.0.1:${port}`;
  return { token, port, origin };
}

export function extractTokenFromRequest(req: IncomingMessage): string | null {
  const header = req.headers['x-mdredd-token'];
  if (typeof header === 'string' && header.length > 0) return header;
  const url = req.url ?? '';
  const qIndex = url.indexOf('?');
  if (qIndex < 0) return null;
  const params = new URLSearchParams(url.slice(qIndex + 1));
  return params.get('t');
}

export function tokenMatches(expected: string, actual: string | null): boolean {
  if (!actual) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function originMatches(expected: string, header: string | undefined): boolean {
  if (!header) return false;
  return header === expected;
}

export function isMutatingMethod(method: string | undefined): boolean {
  if (!method) return false;
  const m = method.toUpperCase();
  return m === 'POST' || m === 'PUT' || m === 'DELETE' || m === 'PATCH';
}

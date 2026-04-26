const LEVEL = (process.env.MDREDD_LOG_LEVEL ?? 'info').toLowerCase();
const LEVELS: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[LEVEL] ?? 20;

function fmt(level: string, msg: string, fields?: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  const extras = fields
    ? ' ' +
      Object.entries(fields)
        .map(([k, v]) => `${k}=${safe(v)}`)
        .join(' ')
    : '';
  return `${ts} ${level.padEnd(5)} ${msg}${extras}`;
}

function safe(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'string') return v.length > 200 ? `"${v.slice(0, 200)}…"` : JSON.stringify(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function emit(level: keyof typeof LEVELS, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level]! < threshold) return;
  const line = fmt(level, msg, fields);
  if (level === 'error' || level === 'warn') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
};

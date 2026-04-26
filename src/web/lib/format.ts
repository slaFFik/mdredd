import type { TranscriptFile } from '@shared/schemas/run.js';

export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${mm}:${String(ss).padStart(2, '0')}`;
}

export function pluralizeTurns(n: number): string {
  return n === 1 ? '1 turn' : `${n} turns`;
}

export function pluralizeToolCalls(n: number): string {
  return n === 1 ? '1 tool call' : `${n} tool calls`;
}

export function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * Elapsed from run start to the last emitted normalized event's timestamp.
 * "Time the model worked to return the results we display" — excludes the
 * subprocess finalization window (CLI emitting cost/usage before exit).
 */
export function modelWorkElapsedMs(transcript: TranscriptFile | null | undefined): number | null {
  if (!transcript || transcript.events.length === 0) return null;
  const startMs = Date.parse(transcript.startedAt);
  if (!Number.isFinite(startMs)) return null;
  let lastTs = 0;
  for (const e of transcript.events) {
    if (e.ts > lastTs) lastTs = e.ts;
  }
  if (lastTs <= 0) return null;
  return Math.max(0, lastTs - startMs);
}

import { useEffect, useMemo, useRef, type JSX } from 'react';
import type { JudgeFile } from '@shared/schemas/judge.js';
import type { RunConfig, TranscriptFile, OutputFile } from '@shared/schemas/run.js';
import type { ColumnLiveState } from '../App.js';
import type { NormalizedEvent } from '@shared/schemas/events.js';
import { Hint } from './Hint.js';

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

export function formatTokens(total: number): string {
  return `${formatTokenCount(total)} tokens`;
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
 * This is "time the model worked to return the results we display" — excludes
 * the subprocess finalization window (CLI emitting cost/usage before exit).
 */
export function modelWorkElapsedMs(
  transcript: TranscriptFile | null | undefined,
): number | null {
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

export function TranscriptView(props: {
  live: ColumnLiveState;
  runBundle: {
    config: RunConfig;
    transcript: TranscriptFile | null;
    judge: JudgeFile | null;
    outputs: OutputFile[];
  } | null;
  isStreaming: boolean;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!props.isStreaming) return;
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [props.live.events, props.isStreaming]);

  const hasLive = props.live.events.length > 0;

  const transcriptStartedMs = useMemo(() => {
    const iso = props.runBundle?.transcript?.startedAt;
    if (!iso) return 0;
    const parsed = Date.parse(iso);
    return Number.isFinite(parsed) ? parsed : 0;
  }, [props.runBundle?.transcript?.startedAt]);

  const liveTurnTools = useMemo(() => computeLiveTurnTools(props.live.events), [props.live.events]);
  const transcriptEvents = useMemo(
    () => collapseTranscriptEvents(props.runBundle?.transcript?.events ?? []),
    [props.runBundle?.transcript?.events],
  );
  const transcriptTurnTools = useMemo(
    () => computeNormalizedTurnTools(transcriptEvents),
    [transcriptEvents],
  );

  if (!hasLive && !props.runBundle?.transcript) {
    return <div className="transcript"><div className="empty-hint">No transcript yet.</div></div>;
  }

  // Render live events during streaming; transcript events from disk once terminal.
  if (props.isStreaming || hasLive) {
    let turnIdx = 0;
    return (
      <div className="transcript" ref={ref}>
        {props.live.events.map((e, i) => {
          if (e.kind === 'turn') {
            const toolsInTurn = liveTurnTools[turnIdx] ?? 0;
            turnIdx += 1;
            return <RenderLive key={i} event={e} toolsInTurn={toolsInTurn} />;
          }
          return <RenderLive key={i} event={e} toolsInTurn={0} />;
        })}
      </div>
    );
  }

  let turnIdx = 0;
  return (
    <div className="transcript" ref={ref}>
      {transcriptEvents.map((e, i) => {
        if (e.t === 'turn') {
          const toolsInTurn = transcriptTurnTools[turnIdx] ?? 0;
          turnIdx += 1;
          return (
            <RenderNormalized key={i} event={e} startedAtMs={transcriptStartedMs} toolsInTurn={toolsInTurn} />
          );
        }
        return <RenderNormalized key={i} event={e} startedAtMs={transcriptStartedMs} toolsInTurn={0} />;
      })}
    </div>
  );
}

/**
 * Match the live view's rendering by:
 *  - merging consecutive same-kind `partial` events into one chunk (the on-disk
 *    transcript stores one event per delta, but the live reducer in App.tsx
 *    collapses them — without this, each delta renders as its own block-level
 *    div with margin, producing visual line breaks mid-sentence);
 *  - dropping aggregate `message` events (intentional duplicates of partial
 *    content kept in the transcript for durability — see claudeStream.ts;
 *    rendering them too produces "[assistant] …" lines that repeat what the
 *    partials already showed, plus bare "[assistant]" labels for messages
 *    whose only content is `thinking` blocks).
 */
function collapseTranscriptEvents(events: NormalizedEvent[]): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  for (const e of events) {
    if (e.t === 'message') continue;
    if (e.t === 'partial') {
      const last = out[out.length - 1];
      if (last && last.t === 'partial' && last.kind === e.kind) {
        out[out.length - 1] = { ...last, chunk: last.chunk + e.chunk };
        continue;
      }
    }
    out.push(e);
  }
  return out;
}

/** For each turn index, count tool-use events that happened since the previous turn (or run start). */
function computeLiveTurnTools(events: ColumnLiveState['events']): number[] {
  const out: number[] = [];
  let running = 0;
  for (const e of events) {
    if (e.kind === 'tool-use') running += 1;
    else if (e.kind === 'turn') {
      out.push(running);
      running = 0;
    }
  }
  return out;
}

function computeNormalizedTurnTools(events: NormalizedEvent[]): number[] {
  const out: number[] = [];
  let running = 0;
  for (const e of events) {
    if (e.t === 'toolUse') running += 1;
    else if (e.t === 'turn') {
      out.push(running);
      running = 0;
    }
  }
  return out;
}

function RenderLive(props: {
  event: ColumnLiveState['events'][number];
  toolsInTurn: number;
}): JSX.Element {
  const e = props.event;
  switch (e.kind) {
    case 'partial':
      return <div className={`event ${e.streamKind}`}>{e.chunk}</div>;
    case 'tool-use':
      return (
        <div className="event tool-use">
          → {e.tool}({truncate(e.argsSummary, 120)})
        </div>
      );
    case 'tool-result':
      return (
        <div className={`event tool-result${e.isError ? ' err' : ''}`}>
          ← {e.tool}: {truncate(e.resultSummary, 180)}
        </div>
      );
    case 'permission-denied':
      return (
        <div className="event perm-denied">
          ⛔ permission denied: {e.tool} {e.path}
        </div>
      );
    case 'turn':
      return (
        <div className="event turn-marker">
          <span>turn {e.turn}</span>
          <span className="turn-sep"> · </span>
          <Hint content="Elapsed from run start to when this turn's final assistant message was emitted.">
            <span>{formatElapsed(e.elapsedMs)}</span>
          </Hint>
          <span className="turn-sep"> · </span>
          <Hint content={pluralizeToolCalls(props.toolsInTurn)}>
            <span>{props.toolsInTurn}T</span>
          </Hint>
        </div>
      );
  }
}

function RenderNormalized(props: {
  event: NormalizedEvent;
  startedAtMs: number;
  toolsInTurn: number;
}): JSX.Element {
  const e = props.event;
  switch (e.t) {
    case 'turn': {
      const elapsed = props.startedAtMs > 0 ? e.ts - props.startedAtMs : 0;
      return (
        <div className="event turn-marker">
          <span>turn {e.turn}</span>
          <span className="turn-sep"> · </span>
          <Hint content="Elapsed from run start to when this turn's final assistant message was emitted.">
            <span>{formatElapsed(elapsed)}</span>
          </Hint>
          <span className="turn-sep"> · </span>
          <Hint content={pluralizeToolCalls(props.toolsInTurn)}>
            <span>{props.toolsInTurn}T</span>
          </Hint>
        </div>
      );
    }
    case 'partial':
      return <div className={`event ${e.kind}`}>{e.chunk}</div>;
    case 'message':
      return <div className="event text">[{e.role}] {extractPlain(e.content)}</div>;
    case 'toolUse':
      return <div className="event tool-use">→ {e.tool}({truncate(e.argsSummary, 120)})</div>;
    case 'toolResult':
      return (
        <div className={`event tool-result${e.isError ? ' err' : ''}`}>
          ← {e.tool}: {truncate(e.resultSummary, 180)}
        </div>
      );
    case 'permissionDenied':
      return (
        <div className="event perm-denied">
          ⛔ permission denied: {e.tool} {e.path}
        </div>
      );
  }
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function extractPlain(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block: unknown) => {
        if (block && typeof block === 'object' && 'text' in (block as Record<string, unknown>)) {
          return String((block as Record<string, unknown>).text ?? '');
        }
        return '';
      })
      .join('');
  }
  return '';
}

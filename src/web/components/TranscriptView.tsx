import { useEffect, useRef, useState, type JSX } from 'react';
import type { JudgeFile } from '@shared/schemas/judge.js';
import type { RunConfig, TranscriptFile, OutputFile } from '@shared/schemas/run.js';
import type { ColumnLiveState } from '../App.js';
import type { NormalizedEvent } from '@shared/schemas/events.js';
import { formatElapsed, pluralizeToolCalls } from '../lib/format.js';
import { CollapseToggle } from './CollapseToggle.js';
import { Hint } from './Hint.js';
import { MarkdownToggle } from './MarkdownToggle.js';
import { MarkdownView } from './MarkdownView.js';

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
  const [rendered, setRendered] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (!props.isStreaming) return;
    if (collapsed) return;
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [props.live.events, props.isStreaming, collapsed]);

  const hasLive = props.live.events.length > 0;

  const transcriptStartedMs = (() => {
    const iso = props.runBundle?.transcript?.startedAt;
    if (!iso) return 0;
    const parsed = Date.parse(iso);
    return Number.isFinite(parsed) ? parsed : 0;
  })();

  const liveTurnTools = computeLiveTurnTools(props.live.events);
  const liveToolsByEventIdx = mapTurnToolsToEventIdx(
    props.live.events,
    (e) => e.kind === 'turn',
    liveTurnTools,
  );
  const transcriptEvents = collapseTranscriptEvents(props.runBundle?.transcript?.events ?? []);
  const transcriptTurnTools = computeNormalizedTurnTools(transcriptEvents);
  const transcriptToolsByEventIdx = mapTurnToolsToEventIdx(
    transcriptEvents,
    (e) => e.t === 'turn',
    transcriptTurnTools,
  );

  if (!hasLive && !props.runBundle?.transcript) {
    return (
      <div className="md-host transcript-host">
        <div className="transcript">
          <div className="empty-hint">No transcript yet.</div>
        </div>
      </div>
    );
  }

  const alwaysVisible = rendered || collapsed;
  const toolbar = (
    <div className={`toolbar-toggles${alwaysVisible ? ' always-visible' : ''}`}>
      <MarkdownToggle rendered={rendered} onToggle={() => setRendered((v) => !v)} />
      <CollapseToggle collapsed={collapsed} onToggle={() => setCollapsed((v) => !v)} />
    </div>
  );

  if (collapsed) {
    return (
      <div className="md-host transcript-host collapsed">
        <div className="transcript-collapsed">
          {buildCollapsedPreview({
            useLive: props.isStreaming || hasLive,
            liveEvents: props.live.events,
            transcriptEvents,
          })}
        </div>
        {toolbar}
      </div>
    );
  }

  // Render live events during streaming; transcript events from disk once terminal.
  if (props.isStreaming || hasLive) {
    return (
      <div className="md-host transcript-host">
        <div className="transcript" ref={ref}>
          {props.live.events.map((e, i) => (
            <RenderLive
              key={i}
              event={e}
              toolsInTurn={liveToolsByEventIdx[i] ?? 0}
              rendered={rendered}
            />
          ))}
        </div>
        {toolbar}
      </div>
    );
  }

  return (
    <div className="md-host transcript-host">
      <div className="transcript" ref={ref}>
        {transcriptEvents.map((e, i) => (
          <RenderNormalized
            key={i}
            event={e}
            startedAtMs={transcriptStartedMs}
            toolsInTurn={transcriptToolsByEventIdx[i] ?? 0}
            rendered={rendered}
          />
        ))}
      </div>
      {toolbar}
    </div>
  );
}

function buildCollapsedPreview(args: {
  useLive: boolean;
  liveEvents: ColumnLiveState['events'];
  transcriptEvents: NormalizedEvent[];
}): string {
  const raw = args.useLive
    ? firstTextLineLive(args.liveEvents)
    : firstTextLineNormalized(args.transcriptEvents);
  const flat = raw.replace(/\s+/g, ' ').trim();
  if (!flat) return '…';
  return `${flat.slice(0, 80)} …`;
}

function firstTextLineLive(events: ColumnLiveState['events']): string {
  for (const e of events) {
    const text = liveEventText(e);
    if (text) return text;
  }
  return '';
}

function liveEventText(e: ColumnLiveState['events'][number]): string {
  switch (e.kind) {
    case 'partial':
      return e.chunk;
    case 'tool-use':
      return `→ ${e.tool}(${e.argsSummary})`;
    case 'tool-result':
      return `← ${e.tool}: ${e.resultSummary}`;
    case 'permission-denied':
      return `⛔ permission denied: ${e.tool} ${e.path}`;
    case 'turn':
      return '';
  }
}

function firstTextLineNormalized(events: NormalizedEvent[]): string {
  for (const e of events) {
    const text = normalizedEventText(e);
    if (text) return text;
  }
  return '';
}

function normalizedEventText(e: NormalizedEvent): string {
  switch (e.t) {
    case 'partial':
      return e.chunk;
    case 'toolUse':
      return `→ ${e.tool}(${e.argsSummary})`;
    case 'toolResult':
      return `← ${e.tool}: ${e.resultSummary}`;
    case 'permissionDenied':
      return `⛔ permission denied: ${e.tool} ${e.path}`;
    case 'turn':
    case 'message':
      return '';
  }
}

/**
 * Build a per-event-index lookup of "tools-in-turn" so render can stay pure
 * (no in-render mutation of a running counter).
 */
function mapTurnToolsToEventIdx<T>(
  events: readonly T[],
  isTurn: (e: T) => boolean,
  turnTools: readonly number[],
): number[] {
  const out: number[] = new Array(events.length).fill(0);
  let turnIdx = 0;
  events.forEach((e, i) => {
    if (isTurn(e)) {
      out[i] = turnTools[turnIdx] ?? 0;
      turnIdx += 1;
    }
  });
  return out;
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
  rendered: boolean;
}): JSX.Element {
  const e = props.event;
  switch (e.kind) {
    case 'partial':
      return props.rendered ? (
        <MarkdownView content={e.chunk} className={`event ${e.streamKind}`} />
      ) : (
        <div className={`event ${e.streamKind}`}>{e.chunk}</div>
      );
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
  rendered: boolean;
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
      return props.rendered ? (
        <MarkdownView content={e.chunk} className={`event ${e.kind}`} />
      ) : (
        <div className={`event ${e.kind}`}>{e.chunk}</div>
      );
    case 'message':
      return (
        <div className="event text">
          [{e.role}] {extractPlain(e.content)}
        </div>
      );
    case 'toolUse':
      return (
        <div className="event tool-use">
          → {e.tool}({truncate(e.argsSummary, 120)})
        </div>
      );
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

import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import type { NormalizedEvent } from '@shared/schemas/events.js';
import { log } from './log.js';

/**
 * Parser for `claude -p --output-format stream-json --include-partial-messages` output.
 *
 * Real-claude events we normalize:
 *   {type: "stream_event", event: {type: "message_start", message: {role: "assistant", ...}}}
 *   {type: "stream_event", event: {type: "content_block_start", content_block: {type: "text"|"thinking"|"tool_use", ...}}}
 *   {type: "stream_event", event: {type: "content_block_delta", delta: {type: "text_delta"|"thinking_delta"|"input_json_delta", ...}}}
 *   {type: "stream_event", event: {type: "content_block_stop"}}
 *   {type: "stream_event", event: {type: "message_delta", delta: {stop_reason, ...}}}
 *   {type: "stream_event", event: {type: "message_stop"}}
 *   {type: "user", message: {content: [{type: "tool_result", tool_use_id, content, is_error}]}}
 *   {type: "assistant", message: {...}}             — aggregated partial/final assistant message
 *   {type: "result", subtype: "success", ...}       — authoritative end-of-run payload
 *   {type: "system", subtype: "init", ...}
 *
 * Turn counting (plan § Safety cap): increment on message_stop when the current message
 * role === "assistant" and stop_reason !== "tool_use". Partial/delta events never count.
 */

export interface ClaudeStreamParserEvents {
  normalized: (e: NormalizedEvent) => void;
  turn: (turnCount: number) => void;
  parseError: (raw: string, error: Error) => void;
  novelType: (type: string) => void;
  systemInit: (payload: Record<string, unknown>) => void;
  result: (payload: Record<string, unknown>) => void;
  rawStreamLine: (line: string) => void;
}

type Listener<E extends keyof ClaudeStreamParserEvents> = ClaudeStreamParserEvents[E];

export class ClaudeStreamParser extends EventEmitter {
  private turnCount = 0;
  private currentMessageRole: string | null = null;
  private currentStopReason: string | null = null;
  private currentToolName: string | null = null;
  private currentToolUseId: string | null = null;
  private currentToolInputBuffer = '';
  private currentContentBlockKind: 'text' | 'thinking' | 'tool_use' | null = null;
  // tool_use_id → tool name, populated when each tool_use block opens.
  // tool_result events arrive in a later (user) message and may be reordered
  // relative to their tool_use blocks; pair them by id rather than by which
  // tool_use happened to be most recent. Issue #5.
  private toolUseIdToName = new Map<string, string>();
  private seenNovelTypes = new Set<string>();

  override on<E extends keyof ClaudeStreamParserEvents>(event: E, listener: Listener<E>): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  override emit<E extends keyof ClaudeStreamParserEvents>(
    event: E,
    ...args: Parameters<Listener<E>>
  ): boolean {
    return super.emit(event, ...(args as unknown[]));
  }

  getTurnCount(): number {
    return this.turnCount;
  }

  consume(stream: Readable): Promise<void> {
    return new Promise((resolve, reject) => {
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      rl.on('line', (line) => this.parseLine(line));
      rl.on('close', () => resolve());
      rl.on('error', (err) => reject(err));
    });
  }

  parseLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    this.emit('rawStreamLine', trimmed);
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      this.emit('parseError', trimmed, err as Error);
      return;
    }
    if (!parsed || typeof parsed !== 'object') {
      this.emit('parseError', trimmed, new Error('top-level value is not an object'));
      return;
    }
    this.handleRaw(parsed as Record<string, unknown>);
  }

  private handleRaw(raw: Record<string, unknown>): void {
    const type = raw.type;
    switch (type) {
      case 'system':
        this.handleSystem(raw);
        return;
      case 'stream_event':
        this.handleStreamEvent(raw);
        return;
      case 'assistant':
      case 'user':
        this.handleAggregateMessage(raw);
        return;
      case 'result':
        this.emit('result', raw);
        return;
      case 'rate_limit_event':
        return;
      default:
        if (typeof type === 'string') {
          this.noteNovel(type);
        }
    }
  }

  private handleSystem(raw: Record<string, unknown>): void {
    if (raw.subtype === 'init') {
      this.emit('systemInit', raw);
    }
    // Other system subtypes (status, permission_denied at top level, etc.) fall through.
    if (raw.subtype === 'permission_denied') {
      this.emitNormalized({
        t: 'permissionDenied',
        tool: String(raw.tool_name ?? 'unknown'),
        path: String(raw.path ?? ''),
        ts: Date.now(),
      });
    }
  }

  private handleStreamEvent(raw: Record<string, unknown>): void {
    const ev = raw.event as Record<string, unknown> | undefined;
    if (!ev || typeof ev !== 'object') return;
    const evType = ev.type;
    switch (evType) {
      case 'message_start': {
        const message = ev.message as Record<string, unknown> | undefined;
        this.currentMessageRole = (message?.role as string | undefined) ?? null;
        this.currentStopReason = null;
        return;
      }
      case 'content_block_start': {
        const block = ev.content_block as Record<string, unknown> | undefined;
        const kind = (block?.type as string | undefined) ?? null;
        if (kind === 'text' || kind === 'thinking' || kind === 'tool_use') {
          this.currentContentBlockKind = kind;
        } else {
          this.currentContentBlockKind = null;
        }
        if (kind === 'tool_use') {
          this.currentToolName = (block?.name as string | undefined) ?? 'unknown';
          this.currentToolUseId =
            typeof block?.id === 'string' && block.id.length > 0 ? block.id : null;
          this.currentToolInputBuffer = '';
          if (this.currentToolUseId) {
            this.toolUseIdToName.set(this.currentToolUseId, this.currentToolName);
          }
        }
        return;
      }
      case 'content_block_delta': {
        const delta = ev.delta as Record<string, unknown> | undefined;
        const dtype = delta?.type;
        if (dtype === 'text_delta') {
          const text = (delta?.text as string | undefined) ?? '';
          if (text) this.emitNormalized({ t: 'partial', chunk: text, kind: 'text', ts: Date.now() });
        } else if (dtype === 'thinking_delta') {
          const text = (delta?.thinking as string | undefined) ?? '';
          if (text)
            this.emitNormalized({ t: 'partial', chunk: text, kind: 'thinking', ts: Date.now() });
        } else if (dtype === 'input_json_delta') {
          const partial = (delta?.partial_json as string | undefined) ?? '';
          this.currentToolInputBuffer += partial;
        }
        return;
      }
      case 'content_block_stop': {
        if (this.currentContentBlockKind === 'tool_use' && this.currentToolName) {
          const argsSummary = truncate(this.currentToolInputBuffer, 160);
          this.emitNormalized({
            t: 'toolUse',
            ...(this.currentToolUseId ? { id: this.currentToolUseId } : {}),
            tool: this.currentToolName,
            argsSummary,
            ts: Date.now(),
          });
        }
        this.currentContentBlockKind = null;
        this.currentToolUseId = null;
        return;
      }
      case 'message_delta': {
        const delta = ev.delta as Record<string, unknown> | undefined;
        const reason = delta?.stop_reason;
        if (typeof reason === 'string') this.currentStopReason = reason;
        return;
      }
      case 'message_stop': {
        if (
          this.currentMessageRole === 'assistant' &&
          this.currentStopReason !== 'tool_use'
        ) {
          this.turnCount += 1;
          this.emit('turn', this.turnCount);
          this.emitNormalized({ t: 'turn', turn: this.turnCount, ts: Date.now() });
        }
        this.currentMessageRole = null;
        this.currentStopReason = null;
        return;
      }
      case 'permission_denied': {
        this.emitNormalized({
          t: 'permissionDenied',
          tool: String((ev.tool_name as string | undefined) ?? 'unknown'),
          path: String((ev.path as string | undefined) ?? ''),
          ts: Date.now(),
        });
        return;
      }
      default: {
        if (typeof evType === 'string') this.noteNovel(`stream_event.${evType}`);
      }
    }
  }

  private handleAggregateMessage(raw: Record<string, unknown>): void {
    // Aggregated assistant/user messages. We emit one `message` normalized event per
    // top-level message emission so the transcript has durable records even if the
    // partial-delta stream is imperfect. The live UI renders from the partials.
    const role = raw.type === 'assistant' ? 'assistant' : 'user';
    const message = raw.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (role === 'user' && Array.isArray(content)) {
      for (const item of content as unknown[]) {
        if (!item || typeof item !== 'object') continue;
        const obj = item as Record<string, unknown>;
        if (obj.type === 'tool_result') {
          const id =
            typeof obj.tool_use_id === 'string' && obj.tool_use_id.length > 0
              ? obj.tool_use_id
              : undefined;
          // Pair by id when present; fall back to the most recent tool_use only
          // when the result lacks an id (defensive — real claude always sends one).
          const tool =
            (id && this.toolUseIdToName.get(id)) ?? this.currentToolName ?? 'unknown';
          if (id) this.toolUseIdToName.delete(id);
          const rawResult = obj.content;
          const resultSummary = truncate(stringifyResult(rawResult), 200);
          this.emitNormalized({
            t: 'toolResult',
            ...(id ? { id } : {}),
            tool,
            resultSummary,
            isError: Boolean(obj.is_error),
            ts: Date.now(),
          });
        }
      }
      return;
    }
    this.emitNormalized({ t: 'message', role, content, ts: Date.now() });
  }

  private emitNormalized(e: NormalizedEvent): void {
    this.emit('normalized', e);
  }

  private noteNovel(type: string): void {
    if (this.seenNovelTypes.has(type)) return;
    this.seenNovelTypes.add(type);
    log.warn('claude-stream: novel event type', { type });
    this.emit('novelType', type);
  }
}

function stringifyResult(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

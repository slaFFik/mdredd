import { extractFinalAssistantMessage } from '../src/server/judge.js';
import type { NormalizedEvent } from '@shared/schemas/events.js';
import type { TranscriptFile } from '@shared/schemas/run.js';

const NO_FINAL = '(no final message emitted)';

function makeTranscript(events: NormalizedEvent[]): TranscriptFile {
  return {
    runFolder: 'test',
    events,
    status: 'completed',
    startedAt: '2026-04-25T00:00:00Z',
    endedAt: '2026-04-25T00:00:01Z',
    turnCount: 0,
    wallClockMs: 1000,
    truncationReason: null,
  };
}

function partial(chunk: string, kind: 'text' | 'thinking' = 'text'): NormalizedEvent {
  return { t: 'partial', chunk, kind, ts: 0 };
}

function turn(n: number): NormalizedEvent {
  return { t: 'turn', turn: n, ts: 0 };
}

function assistantMessage(content: unknown): NormalizedEvent {
  return { t: 'message', role: 'assistant', content, ts: 0 };
}

function userMessage(content: unknown): NormalizedEvent {
  return { t: 'message', role: 'user', content, ts: 0 };
}

function textBlock(text: string): { type: string; text: string } {
  return { type: 'text', text };
}

function toolUseBlock(name: string): { type: string; name: string; input: unknown } {
  return { type: 'tool_use', name, input: {} };
}

function expect(actual: string, expected: string, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

function scenario(name: string, run: () => void): void {
  process.stdout.write(`• ${name} … `);
  try {
    run();
    process.stdout.write('PASS\n');
  } catch (err) {
    process.stdout.write('FAIL\n');
    console.error(err);
    process.exit(1);
  }
}

scenario('empty transcript returns sentinel', () => {
  const out = extractFinalAssistantMessage(makeTranscript([]));
  expect(out, NO_FINAL, 'empty');
});

scenario('aggregate-only single turn returns its text', () => {
  const out = extractFinalAssistantMessage(
    makeTranscript([
      turn(1),
      assistantMessage([textBlock('the answer is 42')]),
    ]),
  );
  expect(out, 'the answer is 42', 'aggregate-only');
});

scenario('partial-only (truncated, no aggregate emitted)', () => {
  // Wallclock cap fires after partials but before message_stop. No aggregate ever lands.
  const out = extractFinalAssistantMessage(
    makeTranscript([
      partial('hello '),
      partial('world'),
    ]),
  );
  expect(out, 'hello world', 'partial-only');
});

scenario('aggregate present discards partials that fed it', () => {
  // Real claude emits partials, then message_stop, then the aggregate. We should
  // prefer the aggregate (canonical) and drop the partial buffer.
  const out = extractFinalAssistantMessage(
    makeTranscript([
      partial('par'),
      partial('tial'),
      turn(1),
      assistantMessage([textBlock('aggregate')]),
    ]),
  );
  expect(out, 'aggregate', 'prefer-aggregate');
});

scenario('multi-turn aggregates: all turns visible to judge', () => {
  // Regression test for opus's critique: a long analysis across 3 turns followed
  // by a brief closer should not erase the analysis.
  const out = extractFinalAssistantMessage(
    makeTranscript([
      assistantMessage([textBlock('detailed analysis turn 1')]),
      turn(1),
      assistantMessage([textBlock('continuing analysis turn 2')]),
      turn(2),
      assistantMessage([textBlock('Done.')]),
      turn(3),
    ]),
  );
  expect(
    out,
    'detailed analysis turn 1\n\ncontinuing analysis turn 2\n\nDone.',
    'multi-turn',
  );
});

scenario('truncated last turn: earlier aggregates + trailing partials', () => {
  // Turn 1 completes with an aggregate. Turn 2 begins streaming partials and the
  // wallclock cap fires before message_stop. Both should reach the judge.
  const out = extractFinalAssistantMessage(
    makeTranscript([
      assistantMessage([textBlock('turn 1 final')]),
      turn(1),
      partial('turn 2 in '),
      partial('progress'),
    ]),
  );
  expect(out, 'turn 1 final\n\nturn 2 in progress', 'truncated-tail');
});

scenario('tool-using turn: only text block extracted, tool_use ignored', () => {
  const out = extractFinalAssistantMessage(
    makeTranscript([
      assistantMessage([textBlock('let me check the file'), toolUseBlock('Read')]),
      // tool_use turns do not emit a `turn` event (stop_reason='tool_use')
      userMessage([{ type: 'tool_result', tool_use_id: 'tu-0', content: 'file body' }]),
      assistantMessage([textBlock('the file contains foo')]),
      turn(1),
    ]),
  );
  expect(out, 'let me check the file\n\nthe file contains foo', 'tool-using');
});

scenario('thinking-only partials are ignored', () => {
  const out = extractFinalAssistantMessage(
    makeTranscript([
      partial('hidden reasoning', 'thinking'),
      partial('more thinking', 'thinking'),
    ]),
  );
  expect(out, NO_FINAL, 'thinking-only');
});

scenario('aggregate with no text content is skipped', () => {
  // Tool-only turn (no text block, just a tool_use). Aggregate emits but contributes
  // nothing. Falls through to sentinel when nothing else exists.
  const out = extractFinalAssistantMessage(
    makeTranscript([
      assistantMessage([toolUseBlock('Glob')]),
      turn(1),
    ]),
  );
  expect(out, NO_FINAL, 'tool-only-aggregate');
});

scenario('aggregate with string content (defensive) is handled', () => {
  // Older claude shapes occasionally pass `content` as a plain string rather than
  // an array of blocks. Don't break.
  const out = extractFinalAssistantMessage(
    makeTranscript([
      assistantMessage('legacy string content'),
      turn(1),
    ]),
  );
  expect(out, 'legacy string content', 'string-content');
});

scenario('user-role messages are ignored', () => {
  const out = extractFinalAssistantMessage(
    makeTranscript([
      userMessage([textBlock('user wrote this — must not appear in judge input')]),
      assistantMessage([textBlock('assistant response')]),
      turn(1),
    ]),
  );
  expect(out, 'assistant response', 'user-role-ignored');
});

scenario('regression: turn marker no longer resets buffer', () => {
  // Previously, a `turn` event cleared the partial buffer, dropping all content
  // from earlier turns. With aggregates present, the bug manifested as "(no final
  // message emitted)" because aggregates land *after* the turn marker and the
  // partial-only path was the only one that worked. With this fix, both aggregate
  // and partial paths capture the full content.
  const partialOnly = extractFinalAssistantMessage(
    makeTranscript([
      partial('first turn text'),
      turn(1),
      partial('second turn text'),
      turn(2),
    ]),
  );
  expect(partialOnly, 'first turn textsecond turn text', 'no-reset-on-turn');
});

console.log('\nAll judge scenarios passed.');

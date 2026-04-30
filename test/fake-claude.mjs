#!/usr/bin/env node
/**
 * Fake claude CLI for mdredd tests.
 * Emits stream-json that mimics real `claude -p --output-format stream-json --include-partial-messages`.
 *
 * Scenario selection:
 *   FAKE_CLAUDE_SCENARIO=happy          (default)  — 1 turn, short text
 *   FAKE_CLAUDE_SCENARIO=many-turns     FAKE_CLAUDE_TURNS=N  — emit N turns
 *   FAKE_CLAUDE_SCENARIO=tool-use       — 1 turn with a tool call + result
 *   FAKE_CLAUDE_SCENARIO=parallel-tool-use — 2 parallel tool_use blocks, results returned out of order
 *   FAKE_CLAUDE_SCENARIO=malformed      — inject one unparseable line mid-stream
 *   FAKE_CLAUDE_SCENARIO=auth-error     — non-zero exit + stderr auth error
 *   FAKE_CLAUDE_SCENARIO=long           FAKE_CLAUDE_DELAY_MS=N  — sleep N ms before any output
 *   FAKE_CLAUDE_SCENARIO=novel          — emit an unknown top-level event type
 *   FAKE_CLAUDE_SCENARIO=permission-denied — emit a permission denial event
 *   FAKE_CLAUDE_SCENARIO=write-output   FAKE_CLAUDE_OUTPUT_NAME=N FAKE_CLAUDE_OUTPUT_BODY=B
 *                                       — synthesize a Write tool_use targeting ../outputs/<N> and
 *                                         actually create that file (the real claude would have
 *                                         done it via its Write tool implementation)
 *
 * Flags are intentionally ignored (except --json-schema which causes an early JSON result).
 */

import { argv, exit, env, stdout, stderr } from 'node:process';

const scenario = env.FAKE_CLAUDE_SCENARIO ?? 'happy';
const args = argv.slice(2);

// Respond to preflight probes before anything else.
if (args.includes('--version') || args[0] === '-v') {
  stdout.write('fake-claude 0.0.1\n');
  exit(0);
}
if (args.includes('--help') || args[0] === '-h') {
  stdout.write(
    [
      'Usage: fake-claude [options] prompt',
      'Options:',
      '  -p, --print',
      '  --output-format <format>',
      '  --include-partial-messages',
      '  --tools <tools...>',
      '  --allowedTools <tools...>',
      '  --strict-mcp-config',
      '  --setting-sources <sources>',
      '  --model <model>',
      '  --effort <level>',
      '  --disable-slash-commands',
      '  --json-schema <schema>',
      '  --verbose',
    ].join('\n') + '\n',
  );
  exit(0);
}

function findFlagValue(name) {
  const i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  return null;
}

// Optional argv dump for tests that want to assert on the spawn flags.
// Writes the full argv (one arg per line) to the path in FAKE_CLAUDE_DUMP_ARGS,
// then continues normally.
if (env.FAKE_CLAUDE_DUMP_ARGS) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(env.FAKE_CLAUDE_DUMP_ARGS, args.join('\n'));
}

const jsonSchemaRaw = findFlagValue('--json-schema');
const outputFormat = findFlagValue('--output-format') ?? 'stream-json';
const model = findFlagValue('--model') ?? 'haiku';

// `auth-error` simulates an unauthenticated CLI and must take precedence over
// the --json-schema bypass below; preflight's auth smoke test exercises that
// path with --output-format json + --json-schema, so the bypass alone would
// hide the failure mode we need to test.
if (scenario === 'auth-error') {
  stderr.write('Authentication required. Run `claude login` to authenticate.\n');
  exit(1);
}

// When the caller asks for --output-format json with a --json-schema, bypass scenarios
// and emit a best-effort conforming response. Used by the judge subprocess.
if (outputFormat === 'json' && jsonSchemaRaw) {
  const body = conformToSchema(jsonSchemaRaw);
  stdout.write(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: JSON.stringify(body),
      num_turns: 0,
    }) + '\n',
  );
  exit(0);
}

function conformToSchema(schemaRaw) {
  try {
    const schema = JSON.parse(schemaRaw);
    return synth(schema);
  } catch {
    return {
      rationale: 'fake judge: schema unreadable',
      scores: { accuracy: 50, completeness: 50, adherence: 50, clarity: 50 },
    };
  }
}

function synth(schema) {
  if (!schema || typeof schema !== 'object') return null;
  const t = schema.type;
  if (t === 'object') {
    const out = {};
    const props = schema.properties ?? {};
    const required = schema.required ?? Object.keys(props);
    for (const key of required) {
      out[key] = synth(props[key]);
    }
    return out;
  }
  if (t === 'integer' || t === 'number') {
    if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
    return 0;
  }
  if (t === 'string') return schema.enum?.[0] ?? 'fake';
  if (t === 'array') return [];
  if (t === 'boolean') return false;
  return null;
}

// Prompt is the first non-flag positional (after -p).
let prompt = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-p' || args[i] === '--print') {
    if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
      prompt = args[i + 1] ?? '';
      break;
    }
  }
}
if (!prompt && args.length > 0 && !args[args.length - 1].startsWith('--')) {
  prompt = args[args.length - 1];
}

const sessionId = `fake-${Math.random().toString(36).slice(2, 10)}`;

function emit(obj) {
  stdout.write(JSON.stringify(obj) + '\n');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function emitSystemInit() {
  const payload = {
    type: 'system',
    subtype: 'init',
    cwd: env.PWD ?? '',
    session_id: sessionId,
    tools: ['Read', 'Glob', 'Grep'],
    model,
    permissionMode: 'default',
    claude_code_version: 'fake-0.0.1',
    uuid: `init-${sessionId}`,
  };
  // Allow the smoke test to inject a memory_paths.auto so we can exercise the
  // runner's context-leak detection without needing a real claude.
  if (env.FAKE_CLAUDE_AUTO_MEMORY) {
    payload.memory_paths = { auto: env.FAKE_CLAUDE_AUTO_MEMORY };
  }
  emit(payload);
}

function emitMessageStart() {
  emit({
    type: 'stream_event',
    event: {
      type: 'message_start',
      message: {
        id: `msg-${Math.random().toString(36).slice(2, 8)}`,
        model,
        type: 'message',
        role: 'assistant',
        content: [],
        stop_reason: null,
      },
    },
    session_id: sessionId,
    parent_tool_use_id: null,
  });
}

function emitTextBlock(text, index = 0) {
  emit({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index,
      content_block: { type: 'text', text: '' },
    },
    session_id: sessionId,
  });
  for (const chunk of chunkText(text, 10)) {
    emit({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: chunk },
      },
      session_id: sessionId,
    });
  }
  emit({
    type: 'stream_event',
    event: { type: 'content_block_stop', index },
    session_id: sessionId,
  });
}

function emitToolUse(toolName, input, index = 0) {
  emit({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id: `tu-${index}`, name: toolName, input: {} },
    },
    session_id: sessionId,
  });
  emit({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
    },
    session_id: sessionId,
  });
  emit({
    type: 'stream_event',
    event: { type: 'content_block_stop', index },
    session_id: sessionId,
  });
}

function emitMessageEnd(stopReason = 'end_turn') {
  emit({
    type: 'stream_event',
    event: {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { input_tokens: 10, output_tokens: 20 },
    },
    session_id: sessionId,
  });
  emit({
    type: 'stream_event',
    event: { type: 'message_stop' },
    session_id: sessionId,
  });
}

function emitUserToolResult(toolUseId, content, isError = false) {
  emit({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content,
          is_error: isError,
        },
      ],
    },
    session_id: sessionId,
  });
}

function emitResult({ numTurns, stopReason = 'end_turn', result = '' }) {
  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: numTurns,
    result,
    stop_reason: stopReason,
    session_id: sessionId,
    total_cost_usd: 0,
    usage: { input_tokens: 10, output_tokens: 20 },
    permission_denials: [],
    terminal_reason: 'completed',
  });
}

function chunkText(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

async function runHappy() {
  emitSystemInit();
  emitMessageStart();
  emitTextBlock(`ok: ${prompt.slice(0, 40)}`);
  emitMessageEnd('end_turn');
  emitResult({ numTurns: 1, result: `ok: ${prompt.slice(0, 40)}` });
}

async function runManyTurns(n) {
  const perTurnDelay = Number(env.FAKE_CLAUDE_PER_TURN_DELAY_MS ?? '5');
  emitSystemInit();
  for (let i = 1; i <= n; i++) {
    emitMessageStart();
    emitTextBlock(`turn ${i}`);
    emitMessageEnd('end_turn');
    await sleep(perTurnDelay);
  }
  emitResult({ numTurns: n, result: `completed ${n} turns` });
}

async function runToolUse() {
  emitSystemInit();
  emitMessageStart();
  emitToolUse('Read', { path: '/tmp/x' });
  emitMessageEnd('tool_use'); // stop_reason: tool_use → NOT a counted turn
  emitUserToolResult('tu-0', 'file contents here');
  emitMessageStart();
  emitTextBlock('read the file');
  emitMessageEnd('end_turn');
  emitResult({ numTurns: 1, result: 'read the file' });
}

// Two parallel tool_use blocks in one assistant message; results returned in
// reverse order (Grep first, Glob second). Pairing is only correct when the
// parser threads tool_use_id through to toolResult events. Issue #5.
async function runParallelToolUse() {
  emitSystemInit();
  emitMessageStart();
  emitToolUse('Glob', { pattern: '**/*.ts' }, 0); // tu-0
  emitToolUse('Grep', { pattern: 'foo' }, 1); // tu-1
  emitMessageEnd('tool_use');
  emitUserToolResult('tu-1', 'grep result body');
  emitUserToolResult('tu-0', 'glob result body');
  emitMessageStart();
  emitTextBlock('searched');
  emitMessageEnd('end_turn');
  emitResult({ numTurns: 1, result: 'searched' });
}

async function runMalformed() {
  emitSystemInit();
  emitMessageStart();
  stdout.write('this is not valid json\n');
  emitTextBlock('recovered');
  emitMessageEnd('end_turn');
  emitResult({ numTurns: 1, result: 'recovered' });
}

async function runAuthError() {
  stderr.write('Authentication required. Run `claude login` to authenticate.\n');
  exit(1);
}

async function runLong() {
  const delayMs = Number(env.FAKE_CLAUDE_DELAY_MS ?? '60000');
  emitSystemInit();
  await sleep(delayMs);
  emitMessageStart();
  emitTextBlock('eventually');
  emitMessageEnd('end_turn');
  emitResult({ numTurns: 1, result: 'eventually' });
}

async function runNovel() {
  emitSystemInit();
  emit({ type: 'novel_event_type_from_the_future', data: { foo: 'bar' } });
  emitMessageStart();
  emitTextBlock('hello despite novelty');
  emitMessageEnd('end_turn');
  emitResult({ numTurns: 1, result: 'hello despite novelty' });
}

async function runWriteOutput() {
  // Real claude's Write tool would create the file as a side effect of the
  // tool_use; we mimic that here so the test can verify the file lands at
  // mdredd's reported outputsDir. cwd is <run>/project/, so '../outputs/<name>'
  // resolves to <run>/outputs/<name>.
  const name = env.FAKE_CLAUDE_OUTPUT_NAME ?? 'result.txt';
  const body = env.FAKE_CLAUDE_OUTPUT_BODY ?? 'hello from fake claude';
  const target = `../outputs/${name}`;
  const { mkdir, writeFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const absTarget = path.resolve(process.cwd(), target);
  await mkdir(path.dirname(absTarget), { recursive: true });
  await writeFile(absTarget, body, 'utf8');

  emitSystemInit();
  emitMessageStart();
  emitToolUse('Write', { file_path: target, content: body });
  emitMessageEnd('tool_use');
  emitUserToolResult('tu-0', `wrote ${body.length} bytes to ${target}`);
  emitMessageStart();
  emitTextBlock(`wrote ${name}`);
  emitMessageEnd('end_turn');
  emitResult({ numTurns: 1, result: `wrote ${name}` });
}

async function runPermissionDenied() {
  emitSystemInit();
  emitMessageStart();
  emit({
    type: 'stream_event',
    event: {
      type: 'permission_denied',
      tool_name: 'Write',
      path: '../project/README.md',
    },
    session_id: sessionId,
  });
  emitTextBlock('could not write');
  emitMessageEnd('end_turn');
  emitResult({ numTurns: 1, result: 'could not write' });
}

async function main() {
  try {
    switch (scenario) {
      case 'happy':
        await runHappy();
        break;
      case 'many-turns':
        await runManyTurns(Number(env.FAKE_CLAUDE_TURNS ?? '5'));
        break;
      case 'tool-use':
        await runToolUse();
        break;
      case 'parallel-tool-use':
        await runParallelToolUse();
        break;
      case 'malformed':
        await runMalformed();
        break;
      case 'auth-error':
        await runAuthError();
        return;
      case 'long':
        await runLong();
        break;
      case 'novel':
        await runNovel();
        break;
      case 'permission-denied':
        await runPermissionDenied();
        break;
      case 'write-output':
        await runWriteOutput();
        break;
      default:
        stderr.write(`fake-claude: unknown scenario "${scenario}"\n`);
        exit(2);
    }
  } catch (err) {
    stderr.write(`fake-claude: ${err?.message ?? err}\n`);
    exit(1);
  }
}

main();

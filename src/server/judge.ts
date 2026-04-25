import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSON5 from 'json5';
import {
  JUDGE_MODEL,
  JUDGE_PROMPT_CAP_BYTES,
  JUDGE_VARIANT_CAP_BYTES,
  JUDGE_FINAL_MESSAGE_CAP_BYTES,
  JUDGE_TOOL_SUMMARY_CAP_CHARS,
} from '@shared/constants.js';
import {
  JUDGE_MODEL_JSON_SCHEMA,
  JudgeModelOutputSchema,
  type JudgeFile,
  type JudgeModelOutput,
} from '@shared/schemas/judge.js';
import type { TranscriptFile } from '@shared/schemas/run.js';
import type { OutputFile, RunConfig } from '@shared/schemas/run.js';
import { atomicWriteJson } from './fsUtil.js';
import { log } from './log.js';

export interface JudgeInput {
  claudeBin: string;
  runDir: string;
  runConfig: RunConfig;
  transcript: TranscriptFile;
  variantContent: string;
  outputs: OutputFile[];
}

export async function runJudge(input: JudgeInput): Promise<JudgeFile> {
  const inputSummary = buildJudgePrompt(input);
  try {
    const parsed = await invokeJudge(input.claudeBin, inputSummary, input.runDir);
    const file: JudgeFile = {
      runFolder: input.runConfig.runFolder,
      createdAt: new Date().toISOString(),
      judgeModel: JUDGE_MODEL,
      status: 'ok',
      scores: parsed.scores,
      rationale: parsed.rationale,
    };
    await atomicWriteJson(join(input.runDir, 'judge.json'), file);
    return file;
  } catch (err) {
    const file: JudgeFile = {
      runFolder: input.runConfig.runFolder,
      createdAt: new Date().toISOString(),
      judgeModel: JUDGE_MODEL,
      status: 'errored',
      error: (err as Error).message,
    };
    await atomicWriteJson(join(input.runDir, 'judge.json'), file);
    return file;
  }
}

const RUBRIC_DEFINITION = `
Score each criterion using this 5-band anchor scale:
  0   = criterion is not satisfied at all
  25  = barely satisfied; major gaps
  50  = partially satisfied; meaningful gaps a reviewer would flag
  75  = largely satisfied; minor gaps at most
  100 = fully satisfied with no observable gaps

Criteria:
- Accuracy       — Are factual or technical claims correct? Score Accuracy conservatively:
                    you do NOT have ground truth about the user's codebase. If you cannot verify
                    correctness from the evidence in the transcript, score Accuracy ≤ 50 and
                    explain the uncertainty in the rationale.
- Completeness   — Does the response address all parts of the prompt?
- Adherence      — Does the response follow the instructions in the variant's CLAUDE.md / skill / agent?
- Clarity        — Is the response well-organized, concise, and easy to follow?

Output strictly a JSON object of the shape:
  { "scores": { "accuracy": N, "completeness": N, "adherence": N, "clarity": N },
    "rationale": "one paragraph, ≤ 600 characters, calling out what drove each score" }
where each N is one of 0, 25, 50, 75, 100.
`.trim();

function buildJudgePrompt(input: JudgeInput): string {
  const { runConfig, transcript, variantContent, outputs } = input;
  const lines: string[] = [];
  lines.push(
    'You are an impartial judge scoring a single Claude Code run against a rubric.',
  );
  lines.push('');
  lines.push(RUBRIC_DEFINITION);
  lines.push('');
  lines.push('## Prompt given to the variant');
  lines.push(bytesCap(runConfig.prompt, JUDGE_PROMPT_CAP_BYTES));
  lines.push('');
  lines.push(`## Variant (${runConfig.variantType}${runConfig.skillOrAgentName ? `: ${runConfig.skillOrAgentName}` : ''})`);
  lines.push(bytesCap(variantContent, JUDGE_VARIANT_CAP_BYTES));
  lines.push('');
  const finalMessage = extractFinalAssistantMessage(transcript);
  lines.push('## Final assistant message');
  lines.push(midEllipsis(finalMessage, JUDGE_FINAL_MESSAGE_CAP_BYTES));
  lines.push('');
  const tools = extractToolSummary(transcript);
  lines.push('## Tool calls (summary)');
  lines.push(tools.length === 0 ? '(none)' : tools.join('\n'));
  lines.push('');
  if (runConfig.mode === 'write') {
    lines.push('## Files the variant produced (manifest only; no content)');
    if (outputs.length === 0) {
      lines.push('(no files produced)');
    } else {
      for (const f of outputs) {
        lines.push(`- ${f.path} (${f.bytes} bytes)`);
      }
    }
    lines.push('');
  }
  lines.push(`## Run metadata`);
  lines.push(`- status: ${runConfig.status}`);
  if (runConfig.truncationReason) lines.push(`- truncated_reason: ${runConfig.truncationReason}`);
  lines.push(`- turn_count: ${runConfig.turnCount}`);
  lines.push('');
  lines.push('Respond with the JSON object only. No prose outside the object.');
  return lines.join('\n');
}

// Aggregate `assistant` messages from real claude come after each `message_stop` and
// carry a `content` array of blocks like `[{type:"text", text:"…"}, {type:"tool_use", …}]`.
// Pull out the text blocks and concatenate.
function extractTextFromMessageContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const obj = block as { type?: unknown; text?: unknown };
    if (obj.type === 'text' && typeof obj.text === 'string') {
      parts.push(obj.text);
    }
  }
  return parts.join('');
}

export function extractFinalAssistantMessage(transcript: TranscriptFile): string {
  // Prefer aggregate `message` events with role==='assistant' — they are the canonical
  // assistant text emitted by claude after each `message_stop`. Concatenate across
  // turns so multi-turn analyses are visible to the judge (a brief "Done" closer
  // should not erase the analysis that came before it). Fall back to the partial
  // stream only when an aggregate never arrived — typically the wallclock-truncated
  // last turn, where partials were emitted but `message_stop` never fired.
  const segments: string[] = [];
  let pendingPartials: string[] = [];

  for (const e of transcript.events) {
    if (e.t === 'message' && e.role === 'assistant') {
      const text = extractTextFromMessageContent(e.content);
      if (text) {
        pendingPartials = [];
        segments.push(text);
      }
    } else if (e.t === 'partial' && e.kind === 'text') {
      pendingPartials.push(e.chunk);
    }
  }
  if (pendingPartials.length > 0) {
    const tail = pendingPartials.join('');
    if (tail) segments.push(tail);
  }
  return segments.length === 0 ? '(no final message emitted)' : segments.join('\n\n');
}

function extractToolSummary(transcript: TranscriptFile): string[] {
  const out: string[] = [];
  let pendingTool: { tool: string; argsSummary: string } | null = null;
  for (const e of transcript.events) {
    if (e.t === 'toolUse') {
      pendingTool = { tool: e.tool, argsSummary: e.argsSummary };
    } else if (e.t === 'toolResult') {
      const tool = pendingTool?.tool ?? e.tool;
      const args = pendingTool?.argsSummary ?? '';
      const res = truncate(e.resultSummary, JUDGE_TOOL_SUMMARY_CAP_CHARS);
      out.push(`${tool}(${truncate(args, JUDGE_TOOL_SUMMARY_CAP_CHARS)}) → ${res}${e.isError ? ' [error]' : ''}`);
      pendingTool = null;
    }
  }
  // Unmatched pending tool (no result captured): still emit.
  if (pendingTool) out.push(`${pendingTool.tool}(${truncate(pendingTool.argsSummary, JUDGE_TOOL_SUMMARY_CAP_CHARS)}) → (no result observed)`);
  return out;
}

function bytesCap(s: string, cap: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.byteLength <= cap) return s;
  return buf.subarray(0, cap).toString('utf8') + '\n…[truncated]';
}

function midEllipsis(s: string, cap: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.byteLength <= cap) return s;
  const half = Math.floor(cap / 2) - 10;
  const head = buf.subarray(0, half).toString('utf8');
  const tail = buf.subarray(buf.byteLength - half).toString('utf8');
  return `${head}\n…[truncated ${buf.byteLength - cap} bytes]…\n${tail}`;
}

function truncate(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return s.slice(0, cap - 1) + '…';
}

async function invokeJudge(
  claudeBin: string,
  prompt: string,
  runDir: string,
): Promise<JudgeModelOutput> {
  const firstAttempt = await spawnJudge(claudeBin, prompt, { jsonSchema: true });
  await writeRawResponse(runDir, 'first', firstAttempt);
  const firstParsed = tryParseJudgeOutput(firstAttempt);
  if (firstParsed.ok) return firstParsed.value;

  log.warn('judge.first-attempt-invalid', { error: firstParsed.error });
  const retryPrompt =
    `${prompt}\n\n# Retry required\n` +
    `Your previous response did not match the required shape. Parser said: "${firstParsed.error}"\n` +
    `Emit ONLY the JSON object described above — no markdown, no prose, no code fences. ` +
    `The first character MUST be "{" and the last MUST be "}". Include all four score keys (accuracy, completeness, adherence, clarity) and the rationale field.`;
  const secondAttempt = await spawnJudge(claudeBin, retryPrompt, { jsonSchema: true });
  await writeRawResponse(runDir, 'retry', secondAttempt);
  const secondParsed = tryParseJudgeOutput(secondAttempt);
  if (secondParsed.ok) return secondParsed.value;

  throw new Error(
    `judge output invalid after retry: ${secondParsed.error}. Raw responses saved to ${join(runDir, 'judge.raw-response.log')}.`,
  );
}

async function writeRawResponse(runDir: string, label: string, raw: string): Promise<void> {
  const header = `\n===== ${label} @ ${new Date().toISOString()} =====\n`;
  const { appendFile } = await import('node:fs/promises');
  try {
    await appendFile(join(runDir, 'judge.raw-response.log'), header + raw + '\n');
  } catch (err) {
    log.warn('judge.raw-persist-failed', { error: (err as Error).message });
  }
}

interface SpawnJudgeOptions {
  jsonSchema: boolean;
}

function spawnJudge(claudeBin: string, prompt: string, opts: SpawnJudgeOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      prompt,
      '--model',
      JUDGE_MODEL,
      '--output-format',
      'json',
      '--tools',
      '',
      '--allowedTools',
      '',
      '--strict-mcp-config',
      '--setting-sources',
      'user',
      '--disable-slash-commands',
    ];
    if (opts.jsonSchema) {
      args.push('--json-schema', JSON.stringify(JUDGE_MODEL_JSON_SCHEMA));
    }
    // Spawn from os.tmpdir() so the judge never inherits the user's project cwd.
    // Combined with `--setting-sources user`, this prevents project `.claude/settings.json`,
    // hooks, and tool overrides from silently contaminating judge scores (issue #3).
    // Strip NODE_OPTIONS for the same reason runner.ts does — keep the harness from
    // injecting debuggers/loaders into the judge child.
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const proc = spawn(claudeBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: tmpdir(),
      env,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`judge subprocess timed out after 120s`));
    }, 120_000);
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`judge subprocess exited ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function tryParseJudgeOutput(
  raw: string,
): { ok: true; value: JudgeModelOutput } | { ok: false; error: string } {
  // The --output-format json wrapper returns a top-level { result: "…json body…", … }.
  // Real haiku occasionally wraps the judge object in markdown fences or adds prose,
  // so we try several extraction strategies in order.
  let outerParsed: unknown;
  try {
    outerParsed = JSON.parse(raw);
  } catch {
    const direct = extractAndValidate(raw);
    if (direct.ok) return direct;
    return { ok: false, error: 'judge output was not valid JSON' };
  }

  const outer = outerParsed as { result?: unknown };
  if (typeof outer?.result === 'string') {
    const fromResult = extractAndValidate(outer.result);
    if (fromResult.ok) return fromResult;
  }

  const asEnvelope = JudgeModelOutputSchema.safeParse(outerParsed);
  if (asEnvelope.success) return { ok: true, value: asEnvelope.data };

  if (typeof outer?.result === 'string') {
    const lastTry = extractAndValidate(outer.result);
    if (!lastTry.ok) return lastTry;
    return lastTry;
  }
  return {
    ok: false,
    error: asEnvelope.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; '),
  };
}

function extractAndValidate(
  body: string,
): { ok: true; value: JudgeModelOutput } | { ok: false; error: string } {
  const candidates = extractJsonCandidates(body);
  let lastIssues: string | null = null;
  let anyParsed = false;
  for (const c of candidates) {
    const parsed = tryParseLenient(c);
    if (parsed === PARSE_FAILED) continue;
    anyParsed = true;
    const validated = JudgeModelOutputSchema.safeParse(parsed);
    if (validated.success) return { ok: true, value: validated.data };
    lastIssues = validated.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; ');
  }
  if (lastIssues) return { ok: false, error: lastIssues };
  if (anyParsed) return { ok: false, error: 'judge output parsed but did not match schema' };
  // Include a preview so the error itself is diagnostic even without the raw log.
  const preview = body.trim().slice(0, 200).replace(/\s+/g, ' ');
  return {
    ok: false,
    error: `no parseable JSON object found. preview: ${preview || '(empty response)'}`,
  };
}

const PARSE_FAILED = Symbol('parse-failed');

function tryParseLenient(raw: string): unknown | typeof PARSE_FAILED {
  // Strict JSON first — matches what --json-schema should enforce.
  try {
    return JSON.parse(raw);
  } catch {
    /* fall through to lenient */
  }
  // JSON5 handles trailing commas, unquoted keys, single-quoted strings, comments —
  // common failure modes when a model emits "JSON-ish" output.
  try {
    return JSON5.parse(raw);
  } catch {
    return PARSE_FAILED;
  }
}

function extractJsonCandidates(body: string): string[] {
  const out: string[] = [];
  const trimmed = body.trim();
  if (trimmed) out.push(trimmed);

  // Strip markdown code fences like ```json ... ``` or ``` ... ```.
  const fenceMatch = /```(?:json|JSON)?\s*([\s\S]*?)\s*```/.exec(body);
  if (fenceMatch && fenceMatch[1]) out.push(fenceMatch[1].trim());

  // First balanced object in the body, ignoring braces inside strings.
  const braceStart = body.indexOf('{');
  if (braceStart >= 0) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = braceStart; i < body.length; i++) {
      const ch = body.charAt(i);
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          out.push(body.slice(braceStart, i + 1));
          break;
        }
      }
    }
  }

  return out;
}

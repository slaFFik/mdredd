export const STORAGE_DIR_NAME = '.mdredd';
// Per-project subdirectory under STORAGE_DIR_NAME. Each cwd gets its own
// folder keyed by a hash of its absolute path so two mdredds in different
// projects can run simultaneously without sharing a lock or session.
export const PROJECTS_DIR_NAME = 'projects';
export const PROJECT_INFO_FILE = 'project.json';
export const LOCK_FILE = '.lock';
export const SESSION_FILE = 'session.json';
export const GITIGNORE_FILE = '.gitignore';

// Per-run filenames inside `<storageRoot>/<runFolder>/`. Writers
// (runner.ts, runManager.ts, sandbox.ts) and readers (session.ts,
// preflight.ts, judge.ts) all import from here so renaming any of these
// is a one-line change. `init.json`, `stream.jsonl`, and `stderr.log` are
// only written by runner.ts and never read elsewhere — left as literals.
export const RUN_CONFIG_FILE = 'config.json';
export const RUN_TRANSCRIPT_FILE = 'transcript.json';
export const RUN_TRANSCRIPT_NDJSON_FILE = 'transcript.ndjson';
export const RUN_JUDGE_FILE = 'judge.json';
export const RUN_VARIANT_FILE = 'variant.md';

// Per-run safety caps. A healthy A/B variant probe finishes in well under
// either limit; the caps exist to stop pathological runs (a model stuck in a
// retry loop, a runaway tool-call cycle) from burning tokens indefinitely.
// Whichever cap fires first marks the run `truncated` with the matching
// truncationReason, and the judge still grades the partial transcript.
export const DEFAULT_TURN_CAP = 50;
export const DEFAULT_WALLCLOCK_CAP_MS = 10 * 60 * 1000;

// Heartbeat cadence for SSE; also acts as a liveness signal for reconnect logic.
export const HEARTBEAT_INTERVAL_MS = 15_000;

export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];
export const WRITE_TOOLS = [...READ_ONLY_TOOLS, 'Write', 'Edit'];

// Appended to the child's system prompt via `--append-system-prompt` whenever
// `mode === 'write'`. The sandbox's `.claude/settings.json` already denies
// Write/Edit outside `../outputs/**`, but without this nudge models often
// recognize the deny rule and bail out ("I cannot apply these fixes") instead
// of writing modified copies into the outputs dir. The text directs them to
// mirror the source path under `../outputs/` and write FULL files, so the user
// can diff the outputs tree against the source after the run.
export const WRITE_MODE_SYSTEM_PROMPT = [
  'You are running in a sandboxed A/B testing harness. Write and Edit are denied for any path inside your cwd; only `../outputs/` is writable. Do not attempt in-place edits to files in cwd — they will fail.',
  'To "modify" a file at relative path REL (e.g. `src/foo.ts`), write the FULL modified contents to `../outputs/REL` (e.g. `../outputs/src/foo.ts`). Mirror the source path exactly so the user can diff `../outputs/` against the source tree after the run.',
  'Always write complete files, never patches or diffs. Read freely from cwd; write only under `../outputs/`.',
].join('\n\n');

// Pin to a concrete model ID, not the `haiku` CLI alias: aliases can be
// repointed to a future generation or removed, which would silently shift
// score baselines or break the judge entirely (issue #13). Bump manually
// when a new Haiku ships and rebaselining is acceptable.
export const JUDGE_MODEL = 'claude-haiku-4-5';

// Models offered to the user in the topbar judge popover. Same pinning rule
// as JUDGE_MODEL: only concrete IDs, never aliases. Order = display order.
export const JUDGE_MODEL_OPTIONS = [
  { id: 'claude-haiku-4-5', label: 'Haiku' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet' },
  { id: 'claude-opus-4-7', label: 'Opus' },
] as const;

// Stream-time per-tool truncation. Applied in `claudeStream.ts` when the
// transcript event is built, so these caps bound what ever reaches disk and
// the judge. Larger values mean richer tool detail at the cost of bigger
// stream.jsonl / transcript.json files.
export const STREAM_TOOL_ARGS_CAP_CHARS = 1024;
export const STREAM_TOOL_RESULT_CAP_CHARS = 1024;

// Judge input budgets (plan § Judge flow step 2).
export const JUDGE_PROMPT_CAP_BYTES = 4 * 1024;
export const JUDGE_VARIANT_CAP_BYTES = 8 * 1024;
export const JUDGE_FINAL_MESSAGE_CAP_BYTES = 4 * 1024;
// Per-tool re-cap at judge time. Equal to STREAM_TOOL_*_CAP_CHARS so this is
// effectively a no-op for individual values, but kept as a separate constant
// so the judge-side budget can diverge from the stream cap if needed.
export const JUDGE_TOOL_SUMMARY_CAP_CHARS = 1024;
// Aggregate cap on the joined tool-summary section. Drops the oldest tool
// calls first when over budget so the most recent (closest to the final
// message) survive, since those are most informative for scoring.
export const JUDGE_TOOL_SUMMARY_TOTAL_CAP_BYTES = 32 * 1024;
// Write-mode output file content caps. Per-file uses mid-ellipsis to keep
// head + tail; aggregate drops later files entirely once over budget.
export const JUDGE_OUTPUT_FILE_CAP_BYTES = 4 * 1024;
export const JUDGE_OUTPUTS_TOTAL_CAP_BYTES = 16 * 1024;

// Effort levels accepted by `claude --effort`. Used as the Zod enum universe;
// each model exposes its own subset below.
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

// Per-model effort menus. xhigh is opus-only (Sonnet 4.6 rejects it). Haiku
// has no effort support — its empty array tells the UI to hide the dropdown.
export const OPUS_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly Effort[];
export const SONNET_EFFORTS = ['low', 'medium', 'high', 'max'] as const satisfies readonly Effort[];
export const HAIKU_EFFORTS = [] as const satisfies readonly Effort[];

// Default effort pre-selected when each model is chosen. Haiku is null →
// spawn omits --effort entirely.
export const OPUS_EFFORT_DEFAULT: Effort = 'xhigh';
export const SONNET_EFFORT_DEFAULT: Effort = 'high';
export const HAIKU_EFFORT_DEFAULT: Effort | null = null;

// Judge subprocess timeout. Sized for the slowest expected case (Opus xhigh on
// a long transcript) since there is no retry path to fall back on — a too-tight
// timeout would surface as a hard failure instead of a slow-but-correct score.
export const JUDGE_TIMEOUT_MS = 600_000;

// Length caps the judge model output is held to. Three places must agree —
// the Zod schema (post-parse rejection), the JSON schema sent to the CLI
// (pre-emit enforcement), and the prompt text the judge model reads. Drift
// silently rejects valid output (Zod tighter than JSON schema) or surfaces
// invalid output (Zod looser).
export const JUDGE_RATIONALE_PER_CRITERION_MAX = 300;
export const JUDGE_RATIONALE_UMBRELLA_MAX = 1200;
export const JUDGE_WARNING_MESSAGE_MAX = 200;

// Maps either a CLI alias (`opus`, `sonnet`, `haiku`) or a concrete pinned ID
// (`claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`) onto its
// model family. Variant columns store aliases; the judge popover stores
// concrete IDs (JUDGE_MODEL_OPTIONS) — both call effort helpers below, so
// both shapes have to resolve.
export type ModelFamily = 'opus' | 'sonnet' | 'haiku';

export function modelFamily(model: string): ModelFamily | null {
  if (model === 'opus' || model.startsWith('claude-opus-')) return 'opus';
  if (model === 'sonnet' || model.startsWith('claude-sonnet-')) return 'sonnet';
  if (model === 'haiku' || model.startsWith('claude-haiku-')) return 'haiku';
  return null;
}

export function effortLevelsForModel(model: string): readonly Effort[] {
  const family = modelFamily(model);
  if (family === 'opus') return OPUS_EFFORTS;
  if (family === 'sonnet') return SONNET_EFFORTS;
  if (family === 'haiku') return HAIKU_EFFORTS;
  return [];
}

export function defaultEffortForModel(model: string): Effort | null {
  const family = modelFamily(model);
  if (family === 'opus') return OPUS_EFFORT_DEFAULT;
  if (family === 'sonnet') return SONNET_EFFORT_DEFAULT;
  if (family === 'haiku') return HAIKU_EFFORT_DEFAULT;
  return null;
}

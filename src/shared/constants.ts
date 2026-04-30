export const STORAGE_DIR_NAME = '.mdredd';
// Per-project subdirectory under STORAGE_DIR_NAME. Each cwd gets its own
// folder keyed by a hash of its absolute path so two mdredds in different
// projects can run simultaneously without sharing a lock or session.
export const PROJECTS_DIR_NAME = 'projects';
export const PROJECT_INFO_FILE = 'project.json';
export const LOCK_FILE = '.lock';
export const SESSION_FILE = 'session.json';
export const GITIGNORE_FILE = '.gitignore';

export const DEFAULT_TURN_CAP = 50;
export const DEFAULT_WALLCLOCK_CAP_MS = 5 * 60 * 1000;

// Heartbeat cadence for SSE; also acts as a liveness signal for reconnect logic.
export const HEARTBEAT_INTERVAL_MS = 15_000;

export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];
export const WRITE_TOOLS = [...READ_ONLY_TOOLS, 'Write', 'Edit'];

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

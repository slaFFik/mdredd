export const STORAGE_DIR_NAME = '.mdredd';
export const LOCK_FILE = '.lock';
export const SESSION_FILE = 'session.json';
export const GITIGNORE_FILE = '.gitignore';

export const DEFAULT_TURN_CAP = 50;
export const DEFAULT_WALLCLOCK_CAP_MS = 5 * 60 * 1000;

// Heartbeat cadence for SSE; also acts as a liveness signal for reconnect logic.
export const HEARTBEAT_INTERVAL_MS = 15_000;

export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];
export const WRITE_TOOLS = [...READ_ONLY_TOOLS, 'Write', 'Edit'];

export const PROJECT_MARKERS = [
  '.git',
  'package.json',
  'composer.json',
  'Cargo.toml',
  'pyproject.toml',
];

// Pin to a concrete model ID, not the `haiku` CLI alias: aliases can be
// repointed to a future generation or removed, which would silently shift
// score baselines or break the judge entirely (issue #13). Bump manually
// when a new Haiku ships and rebaselining is acceptable.
export const JUDGE_MODEL = 'claude-haiku-4-5';

// Model used to auto-generate run-folder slugs from variant content. Kept
// separate from JUDGE_MODEL so the slug generator can move independently —
// slugs are non-critical (they fall back gracefully) and don't anchor any
// historical comparison the way judge scores do.
export const SLUG_MODEL = 'claude-haiku-4-5';

// Judge input budgets (plan § Judge flow step 2).
export const JUDGE_PROMPT_CAP_BYTES = 4 * 1024;
export const JUDGE_VARIANT_CAP_BYTES = 8 * 1024;
export const JUDGE_FINAL_MESSAGE_CAP_BYTES = 4 * 1024;
export const JUDGE_TOOL_SUMMARY_CAP_CHARS = 200;

// Effort levels accepted by `claude --effort`. Order matches the CLI help.
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

// Default effort to pre-select when a model is chosen. Haiku does not support
// effort, so it returns null and the spawn omits --effort entirely.
export function defaultEffortForModel(model: string): Effort | null {
  if (model === 'opus') return 'xhigh';
  if (model === 'sonnet') return 'high';
  if (model === 'haiku') return null;
  return null;
}

export function modelSupportsEffort(model: string): boolean {
  return model !== 'haiku';
}

export const STORAGE_ROOT_REL = 'agents/mdredd';
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

export const JUDGE_MODEL = 'haiku';

// Judge input budgets (plan § Judge flow step 2).
export const JUDGE_PROMPT_CAP_BYTES = 4 * 1024;
export const JUDGE_VARIANT_CAP_BYTES = 8 * 1024;
export const JUDGE_FINAL_MESSAGE_CAP_BYTES = 4 * 1024;
export const JUDGE_TOOL_SUMMARY_CAP_CHARS = 200;

import { readdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import type { Mode, VariantType } from '@shared/schemas/types.js';
import { atomicWriteJson, ensureDir, pathExists } from './fsUtil.js';
import { log } from './log.js';

export interface SandboxInput {
  cwd: string;                     // user's project cwd
  storageRoot: string;             // ~/.mdredd in production; tests may pass a cwd-rooted path
  runFolder: string;               // folder name only
  variantType: VariantType;
  skillOrAgentName: string | null; // required for skill/agent, ignored for CLAUDE.md
  variantContent: string;
  mode: Mode;
}

export interface SandboxResult {
  runDir: string;                  // absolute
  projectDir: string;              // absolute — child claude's cwd
  outputsDir: string;              // absolute — model-produced files land here
  settingsPath: string | null;     // path of written settings.json (write mode only)
  mirroredTopLevel: string[];      // names symlinked from user's cwd
  skippedTopLevel: Array<{ name: string; reason: string }>;
}

/**
 * Lay out the per-run sandbox:
 *
 *   <storageRoot>/<runFolder>/
 *     project/           ← child claude's cwd
 *       <top-levels symlinked from user's cwd, minus conflicts/ignored>
 *       CLAUDE.md or .claude/skills/<name>/SKILL.md or .claude/agents/<name>.md
 *       .claude/settings.json  (write mode only)
 *     outputs/           ← write target for write mode; empty in read-only
 *
 * Hard-excluded regardless of gitignore:
 *   - .git                (keep variant runs away from git state; we plant a fresh
 *                          sandbox .git below so child claude can't walk upward
 *                          and rediscover the host project's .git)
 *   - .claude             (skill/agent variants create a fresh .claude; CLAUDE.md variant
 *                          still skips user .claude to ensure a clean A/B baseline)
 *   - any entry whose realpath is or contains the storage root (defense-in-depth;
 *                          in production storage is `~/.mdredd` so this never fires,
 *                          but tests/legacy layouts may put storage inside cwd)
 *   - the variant's own canonical path (we write it ourselves below)
 */
export async function buildSandbox(input: SandboxInput): Promise<SandboxResult> {
  const runDir = join(input.storageRoot, input.runFolder);
  const projectDir = join(runDir, 'project');
  const outputsDir = join(runDir, 'outputs');

  await ensureDir(projectDir);
  await ensureDir(outputsDir);
  await plantSandboxGitDir(projectDir);

  const ig = await loadRootGitignore(input.cwd);
  const cwdReal = await realpath(input.cwd);

  const variantConflictTop = conflictTopLevel(input.variantType);

  const entries = await readdir(input.cwd, { withFileTypes: true });
  const mirrored: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];

  for (const entry of entries) {
    const name = entry.name;

    if (HARD_EXCLUDED_TOP.has(name)) {
      skipped.push({ name, reason: 'hard-excluded' });
      continue;
    }
    if (isStorageRootDescendant(input.cwd, name, input.storageRoot)) {
      skipped.push({ name, reason: 'storage root' });
      continue;
    }
    if (variantConflictTop && name === variantConflictTop) {
      skipped.push({ name, reason: 'variant conflict' });
      continue;
    }
    // gitignore matches paths relative to repo root; add trailing slash for dirs so patterns
    // like "node_modules/" match properly.
    const relForIgnore = entry.isDirectory() ? `${name}/` : name;
    if (ig.ignores(relForIgnore)) {
      skipped.push({ name, reason: 'gitignored' });
      continue;
    }

    const source = join(input.cwd, name);
    // Guard against symlink cycles: if <cwd>/<name> resolves to a path that is <cwd>
    // itself or an ancestor of it, refuse.
    try {
      const real = await realpath(source);
      if (real === cwdReal || cwdReal.startsWith(real + '/')) {
        throw new Error(`symlink cycle detected at ${source} → ${real}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ELOOP') {
        throw new Error(`symlink loop at ${source}`);
      }
      // ENOENT on dangling symlinks → still try to symlink; child claude will see a dangling link.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    const target = join(projectDir, name);
    await symlink(source, target);
    mirrored.push(name);
  }

  await placeVariant(projectDir, input);
  // Durable snapshot of the exact bytes we ran against, for judge input and audit.
  await writeFile(join(runDir, 'variant.md'), input.variantContent, 'utf8');

  let settingsPath: string | null = null;
  if (input.mode === 'write') {
    settingsPath = await writeSettings(projectDir);
  }

  log.info('sandbox.built', {
    runDir,
    mirrored: mirrored.length,
    skipped: skipped.length,
    mode: input.mode,
  });

  return { runDir, projectDir, outputsDir, settingsPath, mirroredTopLevel: mirrored, skippedTopLevel: skipped };
}

const HARD_EXCLUDED_TOP = new Set<string>(['.git', '.claude', 'node_modules', '.DS_Store']);

function conflictTopLevel(variantType: VariantType): string | null {
  if (variantType === 'CLAUDE.md') return 'CLAUDE.md';
  // skill/agent variants land under .claude/ which is already hard-excluded.
  return null;
}

function isStorageRootDescendant(cwd: string, topEntryName: string, storageRoot: string): boolean {
  const candidate = resolve(cwd, topEntryName);
  const storageRootResolved = resolve(storageRoot);
  return candidate === storageRootResolved || storageRootResolved.startsWith(candidate + '/');
}

async function loadRootGitignore(cwd: string): Promise<Ignore> {
  const ig = ignore();
  const gitignorePath = join(cwd, '.gitignore');
  try {
    const raw = await readFile(gitignorePath, 'utf8');
    ig.add(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('sandbox.gitignore-read-failed', { error: (err as Error).message });
    }
  }
  return ig;
}

async function placeVariant(projectDir: string, input: SandboxInput): Promise<void> {
  const rel = canonicalVariantRelPath(input);
  const target = join(projectDir, rel);
  await ensureDir(target.slice(0, target.lastIndexOf('/')));
  await writeFile(target, input.variantContent, 'utf8');
}

export function canonicalVariantRelPath(input: {
  variantType: VariantType;
  skillOrAgentName: string | null;
}): string {
  if (input.variantType === 'CLAUDE.md') return 'CLAUDE.md';
  const name = input.skillOrAgentName;
  if (!name) {
    throw new Error(`variant type ${input.variantType} requires a skillOrAgentName`);
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`invalid skill/agent name: ${name}`);
  }
  if (input.variantType === 'skill') return `.claude/skills/${name}/SKILL.md`;
  return `.claude/agents/${name}.md`;
}

/**
 * Plant a minimal, self-contained `.git/` inside the sandbox project dir.
 *
 * Claude Code's CLI walks up from cwd looking for `.git/` to determine the project
 * root, which it then uses for two things that leak host context: auto-injected
 * git status/branch/recent-commits, and the per-project auto-memory path
 * (`~/.claude/projects/<encoded-project-path>/memory/`). Without this guard the
 * upward walk could reach a real `.git` and treat the run as if it were the
 * surrounding project.
 *
 * Planting a sandbox-local `.git/` here terminates that walk inside the run dir.
 * The repo is intentionally empty (no commits) so `git status` / `git log` from
 * the child see a neutral fresh state instead of host history.
 */
async function plantSandboxGitDir(projectDir: string): Promise<void> {
  const gitDir = join(projectDir, '.git');
  await ensureDir(gitDir);
  await ensureDir(join(gitDir, 'objects'));
  await ensureDir(join(gitDir, 'refs', 'heads'));
  await writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/sandbox\n', 'utf8');
  await writeFile(
    join(gitDir, 'config'),
    '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n',
    'utf8',
  );
}

async function writeSettings(projectDir: string): Promise<string> {
  // Per plan: the claude cwd is <run>/project/, and outputs/ sits at <run>/outputs/
  // (one level up). The `../outputs/**` pattern is what actually works there.
  const settings = {
    permissions: {
      allow: ['Write(../outputs/**)', 'Edit(../outputs/**)'],
      deny: ['Write(**)', 'Edit(**)'],
    },
  };
  const settingsPath = join(projectDir, '.claude', 'settings.json');
  if (!(await pathExists(join(projectDir, '.claude')))) {
    await ensureDir(join(projectDir, '.claude'));
  }
  await atomicWriteJson(settingsPath, settings);
  return settingsPath;
}

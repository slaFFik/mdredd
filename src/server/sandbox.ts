import { lstat, readdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import type { Mode, VariantType } from '@shared/schemas/types.js';
import { atomicWriteJson, ensureDir, loadGitignore, pathExists } from './fsUtil.js';
import { log } from './log.js';

export interface SandboxInput {
  cwd: string; // user's project cwd
  storageRoot: string; // ~/.mdredd in production; tests may pass a cwd-rooted path
  runFolder: string; // folder name only
  variantType: VariantType;
  skillOrAgentName: string | null; // required for skill/agent, ignored for CLAUDE.md
  variantContent: string;
  mode: Mode;
}

export interface SandboxResult {
  runDir: string; // absolute
  projectDir: string; // absolute — child claude's cwd
  outputsDir: string; // absolute — model-produced files land here
  settingsPath: string | null; // path of written settings.json (write mode only)
  mirroredTopLevel: string[]; // names of top-level entries that were mirrored
  skippedTopLevel: Array<{ name: string; reason: string }>;
}

/**
 * Lay out the per-run sandbox:
 *
 *   <storageRoot>/<runFolder>/
 *     project/           ← child claude's cwd
 *       <user's cwd mirrored as a tree of real dirs + per-file symlinks>
 *       CLAUDE.md or .claude/skills/<name>/SKILL.md or .claude/agents/<name>.md
 *       .claude/settings.json  (write mode only)
 *     outputs/           ← write target for write mode; empty in read-only
 *
 * The mirror walks the source tree recursively, creating real directories on
 * the sandbox side and symlinking only individual files. This lets us apply
 * filtering (gitignore, hard-exclude, symlink-target validation) at every
 * level, not just at the top.
 *
 * Filtered at every level:
 *   - HARD_EXCLUDED entries (`.git`, `.claude`, `node_modules`, `.DS_Store`)
 *   - paths matched by the project's `.gitignore` (root + nested) and the
 *     user's global git excludes file (`~/.config/git/ignore` or
 *     `$XDG_CONFIG_HOME/git/ignore`)
 *   - symlinks whose realpath escapes `cwd` (defense against attacker- or
 *     user-placed links pointing at host secrets like `~/.aws`, `/etc`, etc.)
 *   - symlinks that form a cycle with one of their ancestor directories on
 *     the current walk path
 *
 * Filtered only at the top level (existing behavior preserved):
 *   - the variant's own canonical path (we write it ourselves below)
 *   - any entry whose realpath is or contains the storage root (defense in
 *     depth; production storage is `~/.mdredd` so this never fires, but
 *     tests/legacy layouts may put storage inside cwd)
 */
export async function buildSandbox(input: SandboxInput): Promise<SandboxResult> {
  const runDir = join(input.storageRoot, input.runFolder);
  const projectDir = join(runDir, 'project');
  const outputsDir = join(runDir, 'outputs');

  await ensureDir(projectDir);
  await ensureDir(outputsDir);
  await plantSandboxGitDir(projectDir);

  const cwdReal = await realpath(input.cwd);
  const storageRootReal = await realpath(input.storageRoot);
  const ignoreChain: IgnoreLayer[] = [];
  const globalIgnore = await loadGlobalGitignore();
  if (globalIgnore) ignoreChain.push({ prefix: '', ig: globalIgnore });
  const rootIgnore = await loadGitignore(input.cwd);
  if (rootIgnore) ignoreChain.push({ prefix: '', ig: rootIgnore });

  const mirror = new Mirror({
    cwdReal,
    storageRootReal,
    variantConflictTop: conflictTopLevel(input.variantType),
  });
  await mirror.walk(input.cwd, projectDir, '', ignoreChain, [cwdReal], true);

  await placeVariant(projectDir, input);
  // Durable snapshot of the exact bytes we ran against, for judge input and audit.
  await writeFile(join(runDir, 'variant.md'), input.variantContent, 'utf8');

  let settingsPath: string | null = null;
  if (input.mode === 'write') {
    settingsPath = await writeSettings(projectDir);
  }

  log.info('sandbox.built', {
    runDir,
    mirrored: mirror.mirroredTopLevel.length,
    skipped: mirror.skippedTopLevel.length,
    mode: input.mode,
  });

  return {
    runDir,
    projectDir,
    outputsDir,
    settingsPath,
    mirroredTopLevel: mirror.mirroredTopLevel,
    skippedTopLevel: mirror.skippedTopLevel,
  };
}

const HARD_EXCLUDED = new Set<string>(['.git', '.claude', 'node_modules', '.DS_Store']);

interface IgnoreLayer {
  /** Repo-root-relative directory the rules are anchored at; '' for root/global. */
  prefix: string;
  ig: Ignore;
}

interface MirrorContext {
  cwdReal: string;
  storageRootReal: string;
  variantConflictTop: string | null;
}

class Mirror {
  readonly mirroredTopLevel: string[] = [];
  readonly skippedTopLevel: Array<{ name: string; reason: string }> = [];
  private readonly ctx: MirrorContext;

  constructor(ctx: MirrorContext) {
    this.ctx = ctx;
  }

  async walk(
    src: string,
    dest: string,
    rel: string,
    chain: IgnoreLayer[],
    ancestors: string[],
    isTopLevel: boolean,
  ): Promise<void> {
    const localChain = await maybeAddLocalIgnore(chain, src, rel);

    let entries;
    try {
      entries = await readdir(src, { withFileTypes: true });
    } catch (err) {
      // Directory disappeared between caller's check and now; nothing to mirror.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }

    for (const entry of entries) {
      await this.handleEntry(entry.name, src, dest, rel, localChain, ancestors, isTopLevel);
    }
  }

  private async handleEntry(
    name: string,
    src: string,
    dest: string,
    parentRel: string,
    chain: IgnoreLayer[],
    ancestors: string[],
    isTopLevel: boolean,
  ): Promise<void> {
    const rel = parentRel ? `${parentRel}/${name}` : name;

    if (HARD_EXCLUDED.has(name)) {
      this.recordSkip(isTopLevel, name, 'hard-excluded');
      return;
    }

    if (isTopLevel) {
      if (this.ctx.variantConflictTop && name === this.ctx.variantConflictTop) {
        this.recordSkip(isTopLevel, name, 'variant conflict');
        return;
      }
    }

    const source = join(src, name);
    const classified = await classifyEntry(source, this.ctx.cwdReal, ancestors);
    if (classified.kind === 'gone') return;
    if (classified.kind === 'rejected') {
      this.recordSkip(isTopLevel, name, classified.reason);
      return;
    }

    if (isTopLevel) {
      // Storage-root exclusion is checked on the validated realpath of the
      // entry, not the entry's path string. A top-level symlink such as
      // `alias -> .storage` would otherwise pass a name-based guard and then
      // resolve back inside cwd, letting the mirror walk the sandbox's own
      // state into the run dir. For non-symlinks the realpath is just
      // `<cwdReal>/<name>`.
      const real = classified.realTarget ?? join(this.ctx.cwdReal, name);
      if (this.realIsStorageRoot(real)) {
        this.recordSkip(isTopLevel, name, 'storage root');
        return;
      }
    }

    if (matchesIgnoreChain(chain, rel, classified.isDir)) {
      this.recordSkip(isTopLevel, name, 'gitignored');
      return;
    }

    if (classified.isDir) {
      const subDest = join(dest, name);
      await ensureDir(subDest);
      // Track every directory we descend into by realpath, not just symlink
      // targets. Otherwise a symlink that points back at a real ancestor
      // (e.g. a/b/loop -> a) wouldn't be flagged on first encounter — its
      // realpath would only land in ancestors after we'd already started
      // mirroring the cycle one level deep.
      const walkSource = classified.realTarget ?? source;
      const walkedReal = classified.realTarget ?? (await realpath(walkSource));
      const nextAncestors = [...ancestors, walkedReal];
      await this.walk(walkSource, subDest, rel, chain, nextAncestors, false);
      this.recordMirror(isTopLevel, name);
    } else if (classified.isFile) {
      // Symlink the file itself. For symlink-to-file entries we point at the
      // realpath rather than re-creating an indirect chain — the realpath was
      // already verified to be inside cwd above.
      await symlink(classified.realTarget ?? source, join(dest, name));
      this.recordMirror(isTopLevel, name);
    } else {
      this.recordSkip(isTopLevel, name, 'unsupported file type');
    }
  }

  private recordSkip(isTopLevel: boolean, name: string, reason: string): void {
    if (isTopLevel) this.skippedTopLevel.push({ name, reason });
  }

  private recordMirror(isTopLevel: boolean, name: string): void {
    if (isTopLevel) this.mirroredTopLevel.push(name);
  }

  private realIsStorageRoot(real: string): boolean {
    const root = this.ctx.storageRootReal;
    return real === root || real.startsWith(root + sep) || root.startsWith(real + sep);
  }
}

type Classified =
  | { kind: 'ok'; isDir: boolean; isFile: boolean; realTarget: string | null }
  | { kind: 'rejected'; reason: string }
  | { kind: 'gone' };

/**
 * Inspect an entry's stat/symlink state and validate it against the sandbox
 * boundary. Symlinks whose target escapes cwd or forms a cycle with an
 * ancestor on the current walk path are rejected. Dangling/loop symlinks are
 * rejected with a specific reason. Non-symlinks pass through unchanged.
 */
async function classifyEntry(
  source: string,
  cwdReal: string,
  ancestors: string[],
): Promise<Classified> {
  let lst;
  try {
    lst = await lstat(source);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'gone' };
    throw err;
  }

  if (!lst.isSymbolicLink()) {
    return { kind: 'ok', isDir: lst.isDirectory(), isFile: lst.isFile(), realTarget: null };
  }

  let realTarget: string;
  try {
    realTarget = await realpath(source);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'rejected', reason: 'dangling symlink' };
    if (code === 'ELOOP') return { kind: 'rejected', reason: 'symlink loop' };
    throw err;
  }

  if (realTarget !== cwdReal && !realTarget.startsWith(cwdReal + sep)) {
    return { kind: 'rejected', reason: 'symlink escapes cwd' };
  }
  if (ancestors.includes(realTarget)) {
    return { kind: 'rejected', reason: 'symlink cycle' };
  }

  let tStat;
  try {
    tStat = await lstat(realTarget);
  } catch {
    return { kind: 'gone' };
  }
  return { kind: 'ok', isDir: tStat.isDirectory(), isFile: tStat.isFile(), realTarget };
}

function conflictTopLevel(variantType: VariantType): string | null {
  if (variantType === 'CLAUDE.md') return 'CLAUDE.md';
  // skill/agent variants land under .claude/ which is already hard-excluded.
  return null;
}

async function loadGlobalGitignore(): Promise<Ignore | null> {
  // Honor the most common locations git uses for the global excludes file.
  // We don't shell out to git config, but $XDG_CONFIG_HOME and ~/.config/git
  // cover the typical setup.
  const candidates: string[] = [];
  if (process.env.XDG_CONFIG_HOME) {
    candidates.push(join(process.env.XDG_CONFIG_HOME, 'git', 'ignore'));
  }
  candidates.push(join(homedir(), '.config', 'git', 'ignore'));
  for (const path of candidates) {
    try {
      const raw = await readFile(path, 'utf8');
      if (raw.trim() === '') return null;
      return ignore().add(raw);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      log.warn('sandbox.global-gitignore-read-failed', { path, error: (err as Error).message });
      return null;
    }
  }
  return null;
}

async function maybeAddLocalIgnore(
  chain: IgnoreLayer[],
  dir: string,
  prefix: string,
): Promise<IgnoreLayer[]> {
  // Skip the root: we've already loaded `<cwd>/.gitignore` upfront and put it
  // at the head of the chain.
  if (prefix === '') return chain;
  const local = await loadGitignore(dir);
  if (!local) return chain;
  return [...chain, { prefix, ig: local }];
}

/**
 * Match an entry against the layered ignore chain. Each layer's rules apply
 * to paths under its `prefix`, expressed relative to that prefix — the same
 * way git evaluates a per-directory `.gitignore`.
 *
 * Layers are walked from most-specific (deepest prefix) to least-specific
 * (root/global) so a nested `!keep.log` can override a broader `*.log` rule
 * one layer up. `Ignore.test()` returns both `ignored` and `unignored`, so a
 * negation hit at the deeper layer short-circuits before the outer layer's
 * rule can re-ignore the entry.
 */
function matchesIgnoreChain(chain: IgnoreLayer[], relPath: string, isDir: boolean): boolean {
  const tail = isDir ? `${relPath}/` : relPath;
  for (let i = chain.length - 1; i >= 0; i--) {
    const layer = chain[i]!;
    let relToLayer: string;
    if (layer.prefix === '') {
      relToLayer = tail;
    } else if (relPath === layer.prefix) {
      // A nested .gitignore can't ignore the directory it's anchored at.
      continue;
    } else if (relPath.startsWith(layer.prefix + '/')) {
      relToLayer = tail.slice(layer.prefix.length + 1);
    } else {
      continue;
    }
    const result = layer.ig.test(relToLayer);
    if (result.unignored) return false;
    if (result.ignored) return true;
  }
  return false;
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

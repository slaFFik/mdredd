# MDredd

> A/B test your Claude Code instruction files.

Evaluate different versions of your `CLAUDE.md`, skills, and agent files side-by-side using Claude Code itself. Iterate on your instructions with evidence instead of vibes.

## The problem

You edit `CLAUDE.md` hoping Claude will follow instructions better. You run a prompt. The response seems... different? Hard to tell if it's actually better — Claude varies from run to run, and you're comparing today's output against a fuzzy memory of yesterday's.

Without a structured way to compare variants, every instruction tweak is a guess.

## What MDredd does

MDredd runs two or three versions of the same instruction file in parallel — each with its own prompt — and shows you the full results side by side. An optional judge model scores each variant independently on a rubric (Accuracy, Completeness, Adherence, Clarity) so you can compare them at a glance.

## What you can do with it

- Compare two or three versions of your project's `CLAUDE.md`, each with a tailored prompt
- See whether a skill you wrote actually shapes the output the way you expect
- A/B test different wordings in an agent definition
- Inspect full transcripts — tool calls, reasoning, final answer — for every variant
- Get structured rubric scores for each variant from a judge model

## How it fits your workflow

- Run `mdredd` from any project directory
- A browser UI opens locally with two variant columns (add a third with `+`)
- Paste or pick instruction-file variants; write a prompt per column; click Run
- Variants run with a read-only tool allowlist by default — your source files stay untouched. A Write mode lets variants produce files into a per-run folder, still without modifying your source
- Results stream live; judge scores appear once runs complete

## Requirements

- [Claude Code](https://www.anthropic.com/claude-code) installed and authenticated (`claude` available in your shell)
- Node.js 22.13+
- macOS or Linux

You don't need an API key — MDredd piggybacks on your existing Claude Code auth.

## Install

```bash
npm install -g mdredd
```

Once installed, run `mdredd` from any project directory. To update later, re-run the same command.

## How isolation works

Each variant run gets its own sandbox under `~/.mdredd/projects/<projectKey>/<run-folder>/`. Storage is scoped per project — `<projectKey>` is hashed from the directory you ran `mdredd` from — so two mdredd instances launched from different projects run simultaneously without overlap. Storage lives in your home directory, not inside the project being analyzed, which keeps the host project path out of the child's cwd so the child can't trivially derive the host root and walk back into it. The child `claude` process is spawned with `cwd` set to `<run-folder>/project/`, so everything below describes what that working directory looks like — and what state from your machine reaches the child.

### Per-run sandbox layout

```
~/.mdredd/projects/<projectKey>/<run-folder>/
├── project/                     ← child claude's cwd
│   ├── .git/                    ← planted; empty repo on a `sandbox` branch
│   ├── CLAUDE.md                ← (CLAUDE.md variants) the variant being tested
│   ├── .claude/skills/<name>/SKILL.md   ← (skill variants)
│   ├── .claude/agents/<name>.md         ← (agent variants)
│   └── <top-level entries>      ← hardlinked from your project, see below
├── outputs/                     ← write target in Write mode; empty in read-only
├── variant.md                   ← exact bytes of the variant we ran
├── config.json                  ← run config + token usage + cost
├── init.json                    ← child's `system init` payload (audit trail)
├── stream.jsonl                 ← raw Claude Code stream
├── transcript.json              ← normalized event log
└── judge.json                   ← rubric scores (after judge runs)
```

### What the child claude sees

- **The variant file**, written at its canonical path (`CLAUDE.md`, `.claude/skills/<name>/SKILL.md`, or `.claude/agents/<name>.md`).
- **A mirror of every top-level entry of your project** that isn't excluded: directories are recreated, individual files are hardlinked back to your sources (copy fallback when source and `~/.mdredd` live on different filesystems). `Read`, `Glob`, and `Grep` therefore see real files at every leaf — Claude Code's ripgrep-backed `Glob`/`Grep` skip symlinks without `--follow`, so hardlinks rather than symlinks are required for glob discovery to work at all. Stack detection stays realistic: skills like `pest-testing`, `inertia-react-development`, etc. that Claude Code auto-suggests from `composer.json` / `package.json` still load the way they would in a real session.
- **Your global Claude Code auth** (`HOME` / `CLAUDE_CONFIG_DIR` are passed through unmodified) so the child can talk to the API.
- **Your user-global instructions at `~/.claude/CLAUDE.md`** and any user-global skills/agents/plugins/MCP servers you have installed — these are part of "how Claude behaves on your machine" and are deliberately not stripped.

### What the child claude does **not** see

- **Your project's real `.git/`.** A self-contained empty `.git/` is planted in the sandbox before any files are mirrored, so Claude Code's upward project-root walk terminates inside the run folder. Result: `git status` is clean, `git branch --show-current` returns `sandbox`, `git log` reports no commits — none of your branch name, working-tree status, or recent commit subjects can be auto-injected into the child's system prompt.
- **Your project's auto-memory.** Because Claude Code derives the per-project memory directory (`~/.claude/projects/<encoded-cwd>/memory/`) from where it found `.git`, the planted sandbox `.git/` redirects this lookup to a per-run path that's empty by default. Your project's accumulated `feedback_*.md` / `project_*.md` notes do not bleed in.
- **Your project's `.claude/` directory.** Hard-excluded so an on-disk skill or agent file with the same name can't shadow the variant under test.
- **mdredd's own storage** (`~/.mdredd/`), to keep variant runs out of each other's sandboxes.
- **Anything matched by your project's `.gitignore`** — `node_modules`, build outputs, etc.
- **Inherited git/Claude env vars.** `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR`, `GIT_CEILING_DIRECTORIES`, `CLAUDE_PROJECT_DIR`, `CLAUDE_PROJECT_NAME` are stripped from the spawn environment so an inherited shell can't override the planted sandbox. `NODE_OPTIONS` is also stripped.

### Verifying isolation on a real run

Two artifacts make this auditable:

1. **`<run>/init.json`** — the full `system init` payload the child reported (cwd, tools, skills, MCP servers, `memory_paths.auto`, etc.). This is what was actually true at the start of the run, not what we hoped was true.
2. **`runner.context-leak.auto-memory` warn log.** If the child's reported `memory_paths.auto` doesn't include the run-folder name, mdredd writes a warning to its server stderr. That's the smoke alarm: it means Claude Code somehow resolved a project root outside the sandbox and is loading host auto-memory.

### Known limits

- A baseline ~5–10k cache-creation tokens still come from Claude Code's own system prompt, tool schemas, and your user-global config (`~/.claude/CLAUDE.md`, user-level skills). That overhead is the same for every variant in a session, so it cancels out in A/B comparisons — but it's not zero.
- Hardlinks share an inode with your source files. The planted `.claude/settings.json` deny rules (`Write(**)`, `Edit(**)` with a single `../outputs/**` allow) keep the child from writing to anything but the per-run outputs directory, so this isolation is path-based and survives the inode sharing — but if you ever loosen those rules in your fork, writes through the sandbox path will modify the underlying source file.

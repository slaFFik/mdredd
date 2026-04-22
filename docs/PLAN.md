# mdredd — Agent Eval Tool Implementation Plan

## Context

Build a local CLI + browser UI for comparing variants of Claude Code instruction files (`CLAUDE.md`, skills, agents). The user runs `mdredd` in any working directory; a Node server picks a free port, launches a React UI in the default browser, and lets them iterate on instruction-file variants side-by-side. Each column spawns its own `claude -p` subprocess against a per-column prompt and streams the transcript live. An optional judge model then scores the columns on a fixed rubric and picks a winner. No API-key management — the tool piggybacks on the user's existing `claude` auth. Persistence is flat JSON on disk. v1 is Claude-only; macOS and Linux.

The repo currently contains only README.md and LICENSE. Everything below is new code.

---

## Decisions locked during interview

- **Scope**: `CLAUDE.md` + `.claude/skills/<name>/SKILL.md` + `.claude/agents/<name>.md`.
- **Variant sources**: file picker (from disk) + paste/edit in UI textarea.
- **Injection**: sandbox temp dir per run; variant written to the correct path inside the sandbox.
- **Project exposure**: user's cwd symlinked into the sandbox with gitignore-style excludes.
- **Write policy**: redirect writes to a per-run `scratch/` subdir via claude permission rules; source files never modified.
- **Concurrency**: variants run in parallel (all at once).
- **Turn model**: single prompt per column, natural agentic loop.
- **Output capture**: full transcript (messages + tool calls + tool results).
- **Columns**: 2 by default, `+` button to add more; each column has independent Run/Stop.
- **Prompt**: per-column prompt field (each variant has its own).
- **Model**: default-model dropdown with per-variant override.
- **Judge**: toggle per eval (default on); rubric = Accuracy, Completeness, Instruction Adherence, Clarity; + winner + short rationale; judge model = Opus; re-fires automatically after every variant completion.
- **Storage**: one directory per eval under `./agents/mdredd/evals/<eval-id>/`.
- **History UI**: none; past evals live on disk only.
- **Startup**: each session starts blank.
- **Safety cap**: 50-turn hard cap per run, enforced by our runner via stream-json event counting (see note below).
- **Cancel**: per-column Stop button kills the subprocess.
- **Progress UI**: live streaming via `claude -p --output-format stream-json --include-partial-messages`.
- **Stack**: TypeScript + Vite + npm; React 18; small Node HTTP server; `open` + `get-port`.

### Note on the safety cap

We agreed on `max-turns=50` during the interview, and we explicitly rejected cost-based caps (no basis for picking a dollar value without workload data). Running `claude --help` confirms `--max-turns` is not a flag in the current `claude` CLI. So we enforce the cap ourselves: `claude -p --output-format stream-json` emits one assistant-message event per turn; the runner keeps a counter and sends SIGTERM to the subprocess when it reaches 50. Same intent (emergency brake for runaway variants), implemented in our wrapper — no `claude` flag needed, and no USD guessing.

---

## Code architecture

```
mdredd/
├── bin/mdredd.js                 # CLI entry: resolves port, starts server, launches browser
├── src/server/
│   ├── index.ts                  # bootstrap, port selection (get-port), static serve
│   ├── routes.ts                 # /api endpoints; SSE stream for run events
│   ├── runner.ts                 # spawn claude subprocess, parse stream-json, count turns, forward events
│   ├── sandbox.ts                # build sandbox dir, place variant, symlink project, write permissions settings
│   ├── judge.ts                  # build judge prompt, spawn judge claude with --json-schema, store result
│   └── storage.ts                # read/write eval directory under ./agents/mdredd/evals/
├── src/web/
│   ├── App.tsx                   # top-level layout; global judge toggle; column row
│   ├── components/
│   │   ├── VariantColumn.tsx     # settings (variant source, model, name) + prompt + Run/Stop + transcript
│   │   ├── VariantEditor.tsx     # file picker or inline textarea
│   │   ├── PromptField.tsx
│   │   ├── TranscriptView.tsx    # renders messages / tool calls / tool results with collapsibles
│   │   └── JudgePanel.tsx        # rubric scores × columns, winner highlight, rationale
│   └── lib/api.ts                # fetch + EventSource client
├── dist/                         # prebuilt web bundle (shipped via npm)
├── package.json                  # name "mdredd", bin entry, files whitelist
├── vite.config.ts
├── tsconfig.json
└── README.md                     # existing; update with usage later
```

### Dependencies

- Runtime: `express` (tiny HTTP + SSE), `get-port`, `open`, `ignore` (gitignore matching).
- Dev: `vite`, `@vitejs/plugin-react`, `typescript`, `react`, `react-dom`, `@types/*`.

---

## Per-variant execution flow

1. User clicks **Run** on column N.
2. Server assigns `eval-id` (ISO timestamp slug) on first Run of the session; writes/updates `config.json` with per-column state.
3. Server creates sandbox: `./agents/mdredd/evals/<eval-id>/runs/<variant-slug>/sandbox/`.
4. Server places the variant file at the right path in the sandbox:
   - CLAUDE.md variant → `<sandbox>/CLAUDE.md`
   - Skill variant → `<sandbox>/.claude/skills/<name>/SKILL.md`
   - Agent variant → `<sandbox>/.claude/agents/<name>.md`
5. Server symlinks user's cwd into `<sandbox>/project/`, filtered through `.gitignore` (via `ignore` package) + a hard exclusion of `./agents/mdredd/` to prevent recursion.
6. Server writes `<sandbox>/.claude/settings.json` to redirect writes to scratch:
   ```json
   {
     "permissions": {
       "allow": ["Write(./scratch/**)", "Edit(./scratch/**)"],
       "deny": ["Write(**)", "Edit(**)", "NotebookEdit"]
     }
   }
   ```
7. Server spawns:
   ```
   claude -p "<prompt>" \
     --output-format stream-json \
     --include-partial-messages \
     --model <chosen-model> \
     --setting-sources project
   ```
   with `cwd = <sandbox>`.
8. Server parses stream-json line-by-line; forwards each event over SSE to the column. Counts assistant-message events; if the count reaches 50, sends SIGTERM to the subprocess and marks the run "truncated" in the transcript metadata.
9. On subprocess exit, server writes the full transcript to `runs/<variant-slug>.json` with metadata (model, duration, exit code, turn count, truncated flag).
10. If the eval's judge toggle is on and ≥2 columns now have completed runs, trigger the judge (see below).

### Cancel semantics

Stop button sends SIGTERM to the subprocess; server waits briefly, then SIGKILL if needed. Partial transcript is written with `status: "cancelled"`. Column UI shows "Cancelled at turn N". Does not trigger the judge.

---

## Judge flow

1. Server assembles a judge prompt: the per-column prompts, each column's final message + tool-call summary, and the four rubric criteria.
2. Spawns judge:
   ```
   claude -p "<judge-prompt>" --model opus --output-format json \
     --json-schema '<rubric-schema>'
   ```
   where the JSON schema enforces `{ columns: [{ name, scores: { accuracy, completeness, adherence, clarity } }], winner, rationale }`.
3. Parses the structured output; stores at `./agents/mdredd/evals/<eval-id>/judge.json`.
4. Server pushes a "judge updated" event over SSE; JudgePanel re-renders.
5. Every subsequent variant completion triggers a fresh judge invocation (auto re-score). Previous `judge.json` is overwritten (history is via the fact that old evals are frozen directories).

---

## UI shape

Single scrollable page:

- **Top bar**: current `eval-id`, **New eval** button (clears state to blank), **Judge ON/OFF** toggle.
- **Column row** (horizontally scrollable if >3):
  - Header: variant name input, variant source selector (file-picker or textarea), model dropdown (default + per-column override), variant-type indicator (CLAUDE.md / skill / agent, inferred from file or user-selected for paste).
  - Prompt textarea (per column — each variant has its own prompt).
  - **Run / Stop** button (toggles by state). Progress readout when running: `turn N · mm:ss · last tool: <Name>`.
  - Transcript below: live streaming, with collapsible sections for thinking blocks, tool calls, tool results; final message shown expanded. Truncation badge if the turn cap fired.
- **Judge panel** (below columns): 4×N rubric table, winner highlighted, rationale text. Hidden until the judge has produced output for the current state.

---

## Persistence layout

```
./agents/mdredd/
└── evals/
    └── <eval-id>/                         # ISO-ish slug, e.g. 2026-04-22T15-30-12
        ├── config.json                    # per-column prompt/variant ref/model; judge toggle
        ├── variants/
        │   ├── <variant-slug>.md          # snapshot at run time
        │   └── ...
        ├── runs/
        │   ├── <variant-slug>.json        # full transcript + metadata + status
        │   └── ...
        └── judge.json                     # current rubric scores + winner + rationale
```

Sandbox directories (`runs/<variant-slug>/sandbox/`) live alongside but are ephemeral — they can be cleaned up on a toggle later; v1 keeps them for debuggability.

---

## Files to create (critical paths)

All are new. Highest implementation risk in:

- `src/server/runner.ts` — subprocess spawn, stream-json parsing, turn-cap enforcement, cancel handling, error surfaces.
- `src/server/sandbox.ts` — correct variant placement, symlink traversal with gitignore honoring, settings.json emission.
- `src/server/judge.ts` — judge prompt construction, JSON schema for structured output, integration with per-variant completion events.
- `src/web/components/TranscriptView.tsx` — rendering live streaming transcripts at readable density.

---

## Verification

1. `npm install && npm run build` completes cleanly. Type-check clean.
2. `npm link` exposes `mdredd` globally.
3. In a test directory containing some `.ts` source files and a `CLAUDE.md`: run `mdredd`. Browser opens to the UI on a dynamic port.
4. Paste two CLAUDE.md variants (A: "be extremely concise"; B: "be thorough and explain reasoning"), same prompt in both columns ("describe the structure of this project"), click Run on both columns.
5. Confirm: both subprocesses start within seconds; transcripts stream live side-by-side; turn counters increment.
6. After both complete, judge auto-fires; rubric table + winner + rationale appear.
7. `git status` in the test dir shows **no modifications** (write policy held).
8. Cancel test: start a run, hit Stop mid-stream. Subprocess dies, column shows "Cancelled at turn N", source untouched.
9. Per-column re-run: edit variant 2's text, click Run on column 2 only. Column 1's transcript remains untouched, judge re-fires with new column-2 result + cached column-1 result.
10. Inspect `./agents/mdredd/evals/<eval-id>/`: verify `config.json`, `variants/`, `runs/`, `judge.json` structure.
11. Skill variant test: pick a skill file as the variant; confirm it lands at `.claude/skills/<name>/SKILL.md` in the sandbox and the agent actually picks it up at runtime.
12. Agent variant test: same, but for `.claude/agents/<name>.md`.
13. Write-redirect test: craft a variant that instructs "write a summary to notes.md"; confirm the file appears under `runs/<variant>/sandbox/scratch/notes.md`, never in the user's project.
14. Turn cap test: lower the cap to 3 in a dev build; run a prompt that requires more than 3 turns (e.g. "grep the codebase, summarize, then propose a refactor"); confirm the subprocess is terminated after the 3rd turn and the run is marked "truncated" with a UI badge.
15. Run on both macOS and Linux; confirm parity. (WSL: print URL if `open` fails, defer.)

---

## Deferred to v2

- Wall-clock timeout and loop-pattern "stuck" detection.
- Rubric customization (today: fixed 4 criteria; later: library + user-defined).
- Prompt library / prompt suites / multi-turn conversation scripts.
- History UI (browsable past evals from within the app).
- Parallel-run concurrency ceiling (today: unlimited).
- Auto-load most-recent eval on launch / "Open eval" file picker.
- "Copy prompt to all columns" helper (per-column prompts can drift silently today).
- Hard enforcement of write policy beyond claude's permission rules (e.g. tool-call interception).
- Gemini CLI / Codex support; WSL first-class support.

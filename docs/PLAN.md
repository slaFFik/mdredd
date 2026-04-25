# mdredd — Agent Eval Tool Implementation Plan

## Context

Build a local CLI + browser UI for comparing variants of Claude Code instruction files (`CLAUDE.md`, skills, agents). The user runs `mdredd` in any working directory; a Node server picks a free port, launches a React UI in the default browser, and lets them iterate on instruction-file variants side-by-side. Each column spawns its own `claude -p` subprocess against a per-column prompt and streams the transcript live. A per-variant judge scores each completed run on a rubric. No API-key management — the tool piggybacks on the user's existing `claude` auth. Persistence is flat JSON on disk under `~/.mdredd/`. v1 is Claude-only; macOS and Linux.

**Safety model.** Read-only mode is the default and uses a claude CLI tool allowlist (`Read,Glob,Grep,WebSearch,WebFetch`) that simply doesn't include any write/execute tool — so nothing can mutate the user's project, full stop. Write mode additionally includes `Write,Edit` constrained by `.claude/settings.json` permission rules to a per-run `outputs/` directory. `Bash`, `Task`, `NotebookEdit`, and MCP are absent from both allowlists in v1. The "your source files stay untouched" promise is delivered by the allowlist, not by polite instructions to the model.

The repo currently contains only README.md, LICENSE, and docs/PLAN.md. Everything below is new code.

---

## Decisions locked

- **Scope**: `CLAUDE.md` + `.claude/skills/<name>/SKILL.md` + `.claude/agents/<name>.md`.
- **Variant source**: paste/edit in UI textarea is primary; an upload button reads a file and drops its content into the textarea.
- **Mode toggle (per-eval)**: **Read-only** (default, counselors-parity) or **Write**. Applies to all columns in the current UI state.
- **Tool allowlist**:
  - Read-only: `Read,Glob,Grep,WebSearch,WebFetch`.
  - Write: `Read,Glob,Grep,WebSearch,WebFetch,Write,Edit` + per-run `settings.json` restricting `Write`/`Edit` to `../outputs/**` (relative to claude's cwd; verified working).
  - `Bash`, `Task`, `NotebookEdit`, MCP: not in either allowlist in v1. Expert-mode Bash toggle deferred to v2.
- **Concurrency**: all columns run in parallel. Hard column cap is 3; no queue.
- **Columns**: 2 default, `+` adds up to 3; each column has independent Run/Stop.
- **Prompt**: per-column prompt field, independent per variant.
- **Model**: default-model dropdown with per-column override.
- **Judge (per-variant)**: toggle per eval (default on). Fires once per `completed` or `truncated` run against that run's transcript. Rubric = **Accuracy, Completeness, Adherence, Clarity**, each scored 0–100 on a 5-band anchor scale (0/25/50/75/100). No "winner" — each variant gets an independent scorecard; the human compares. **Judge model = Haiku** (mirrors the pattern in claude's own `code-review` skill: Haiku is cheap, fast, and consistent for rubric-driven scoring). Judgment stored at `<run>/judge.json`.
- **Storage root**: `~/.mdredd/` (out-of-project; keeps the host project path out of the child's cwd).
- **History UI**: none; run folders are chronologically sorted on disk. Within a session, re-running a column creates a new run folder rather than overwriting.
- **State restoration**: on boot, the server reads `session.json` + each referenced run folder and restores the full UI (prompts, variant text, transcripts, outputs, judge scores) from disk. Nothing is lost on server restart or browser refresh. A **Start new** top-bar button (confirmation dialog) wipes every run folder and `session.json` under `~/.mdredd/` (preserves `.gitignore` and `.lock`), returning to a blank slate.
- **Editing lock while running**: while any column is in a non-terminal state (`preparing`, `streaming`), all editable surfaces are disabled — variant textareas, prompt fields, model dropdowns, mode toggle, judge toggle, and idle columns' Run buttons. Only active columns' Stop buttons and Start new remain clickable. Unlocks as soon as every column reaches a terminal state.
- **Safety cap**: defense-in-depth — two independent caps (turns, wall-clock). See § Safety cap.
- **Cancel**: per-column Stop kills the subprocess (SIGTERM, 2s grace, SIGKILL).
- **Progress UI**: live streaming via `claude -p --output-format stream-json --include-partial-messages`.
- **Stack**: TypeScript + Vite + npm; React 18; small Node HTTP server bound to `127.0.0.1`; `open` + `get-port` + `ignore` + `ajv`.

### Safety cap

Two independent caps; on any trip → SIGTERM + 2s grace + SIGKILL → `status: "truncated"` with `truncationReason` recorded.

| Cap | Default | Source |
|-----|---------|--------|
| Turns | 50 | Exact event, below |
| Wall clock | 5 min | Subprocess start time |

**Turn counting**: increment on `{"type":"message_stop"}` when the corresponding `message_start` had `role: "assistant"` and `stop_reason !== "tool_use"` (a completed non-tool turn). Partial/delta events do not count. Novel event types → one warning per type per run, not counted.

`--max-turns` is not a flag on the current `claude` CLI, so the runner parses stream-json and enforces the turn cap itself. Wall-clock is defense-in-depth against event-schema drift.

---

## Code architecture

```
mdredd/
├── bin/mdredd.js                 # CLI entry: port, server, browser launch
├── src/server/
│   ├── index.ts                  # bootstrap, get-port, 127.0.0.1 bind, static serve
│   ├── preflight.ts              # detect claude CLI, auth, required flags, cwd guard
│   ├── security.ts               # Origin check, session token
│   ├── routes.ts                 # /api endpoints; SSE stream
│   ├── runner.ts                 # spawn claude, parse stream-json, enforce caps
│   ├── sandbox.ts                # build run folder, mirror project, place variant, settings.json
│   ├── slug.ts                   # Haiku-summary + content-hash slug derivation
│   ├── judge.ts                  # spawn per-variant judge (Haiku), ajv-validate, store
│   └── session.ts                # session state + boot-time state restoration
├── src/shared/
│   └── schemas/                  # TS types + ajv validators, shared by server + client
├── src/web/
│   ├── App.tsx                   # layout; mode toggle; judge toggle; Start new
│   ├── components/
│   │   ├── VariantColumn.tsx
│   │   ├── VariantEditor.tsx     # textarea + upload button
│   │   ├── PromptField.tsx
│   │   ├── TranscriptView.tsx
│   │   └── JudgeCard.tsx         # single-variant scorecard (no winner logic)
│   └── lib/api.ts                # fetch + EventSource client with Last-Event-ID
├── dist/                         # prebuilt web bundle
├── package.json
├── vite.config.ts
├── tsconfig.json
└── README.md
```

### Dependencies

- Runtime: `express`, `get-port`, `open`, `ignore`, `ajv`, `proper-lockfile`.
- Dev: `vite`, `@vitejs/plugin-react`, `typescript`, `react`, `react-dom`, `@types/*`.

---

## Preflight & security

### Preflight (server startup)

1. `claude --version` — fail fast if not installed.
2. `claude --help` parsed for required flags: `--output-format stream-json`, `--include-partial-messages`, `--tools`, `--allowedTools`, `--strict-mcp-config`, `--setting-sources`, `--model`.
3. Auth smoke: trivial cap-bounded `claude -p`. On failure, UI shows a pointer to `claude login`.
4. **cwd guard**: refuse if cwd is `$HOME`, `/`, or at-or-under `~/.mdredd/`. Require cwd to contain a project marker (`.git/`, `package.json`, `composer.json`, `Cargo.toml`, `pyproject.toml`) or `--force`.
5. **Instance lock**: only one `mdredd` per machine (`.lock` file at `~/.mdredd/.lock` with pid + port; stale-lock recovery if pid is gone).
6. **Auto-gitignore**: if `~/.mdredd/.gitignore` doesn't exist, write `*\n!.gitignore\n`. (No-op outside a git repo, kept as a safety belt.)
7. **Abandoned-run recovery**: scan existing run folders; any with `status ∈ {"preparing","streaming"}` and no live PID get rewritten to `status: "abandoned"` before the UI boots.

### Security

- HTTP server binds `127.0.0.1` only, never `0.0.0.0`.
- State-mutating POSTs require `Origin: http://127.0.0.1:<port>` → 403 on mismatch.
- 32-byte random session token generated at startup, embedded in the launched URL as `?t=<token>`, required on every API call.

---

## Column state machine

```
idle
  → (Run clicked)            → preparing     (slug resolution, sandbox build)
  → (subprocess spawned)     → streaming
    → (natural completion)   → completed     → judge fires
    → (cap trips, SIGTERM)   → truncated     → judge fires
    → (Stop clicked)         → cancelled     (no judge)
    → (spawn/parse fatal / exit != 0) → errored  (no judge)
  → (variant reset / column removed) → idle
  → (server restart observed mid-run) → abandoned  (terminal; set on disk at boot)
```

Illegal transitions are runtime errors. Re-running a column in `preparing`/`streaming` → 409.

---

## Slug derivation

Per-run folder name: `<timestamp-ms>-<slug-base>-<content-hash>`.

- **Timestamp-ms**: ISO-ish with millisecond precision, e.g. `2026-04-23T15-30-12-345`. Filesystem-safe chars only.
- **Slug base**:
  1. If the column's "variant name" field is filled → kebab-case it (≤32 chars).
  2. Else → spawn Haiku with *"Produce a 2–4 word kebab-case slug summarizing this variant. Output only the slug."* against the variant content. ~1s, blocking on Run.
  3. If Haiku fails (network/auth/error) → literal `variant`.
- **Content hash**: 6-char SHA-256 over UTF-8 LF-normalized variant content.
- **Collision (same full folder name already exists)**: append `-1`, `-2`. Expected never to trigger with ms-precision timestamps.
- Path-traversal guard: reject slug bases containing `..`, `/`, or leading `.` before assembly.

---

## Per-variant execution flow

1. User clicks **Run** on column N.
2. Server validates: prompt non-empty; variant content non-whitespace; column not already running; no column is in a non-terminal state if editing was locked at click time; total columns ≤ 3.
3. Resolve slug (see § Slug derivation). Block briefly if Haiku is required.
4. Create run folder `~/.mdredd/<timestamp>-<slug-base>-<hash>/`. Write `config.json` (initial state, prompt hash, variant hash, mode, model, status=`preparing`). Write `variant.md` snapshot.
5. Build sandbox inside the run folder:
   - `<run>/project/` — claude's cwd for this run
   - `<run>/outputs/` — write target (created even in read-only mode; stays empty)
6. Mirror user's cwd into `<run>/project/` with per-top-level-entry symlinks, filtered by the user's `.gitignore`, plus a defense-in-depth skip of any entry whose realpath contains the storage root, plus the variant's own canonical path. Refuse on symlink cycles.
7. Place variant at its canonical path inside `<run>/project/`:
   - CLAUDE.md → `<run>/project/CLAUDE.md`
   - Skill → `<run>/project/.claude/skills/<name>/SKILL.md`
   - Agent → `<run>/project/.claude/agents/<name>.md`

   Skill/agent name comes from the uploaded file's path when available, otherwise from an explicit name field in the column header.
8. **Write mode only**: write `<run>/project/.claude/settings.json`:
   ```json
   {
     "permissions": {
       "allow": ["Write(../outputs/**)", "Edit(../outputs/**)"],
       "deny":  ["Write(**)", "Edit(**)"]
     }
   }
   ```
   Verified: the `../outputs/**` rule works when claude's cwd is `<run>/project/`. Policy denials do not surface in the result JSON's `permission_denials` field — the runner observes denials via stream-json events instead.
9. Spawn:
   ```
   claude -p "<prompt>" \
     --output-format stream-json \
     --include-partial-messages \
     --model <chosen-model> \
     --tools        "<allowlist-for-mode>" \
     --allowedTools "<allowlist-for-mode>" \
     --strict-mcp-config \
     --setting-sources project
   ```
   - `cwd` = `<run>/project/`
   - `env` = `process.env` with `CLAUDE_*` overrides and `NODE_OPTIONS` stripped
   - `stdin` closed (kill after 15s if the process blocks on stdin — likely an interactive auth re-challenge)
   - `stderr` captured to `<run>/stderr.log`
10. Parse stream-json line-by-line into normalized events, forwarded over SSE with a monotonic `seq`. Raw lines mirrored to `<run>/stream.jsonl`. Unparseable lines → `<run>/parse-errors.log`; runner continues. Novel event types logged once per type per run.
11. Turn counter + wall-clock timer run in parallel. Any trip → SIGTERM + 2s grace + SIGKILL → `status: "truncated"` with `truncationReason ∈ {"turns","wallclock"}`.
12. On subprocess exit, write `<run>/transcript.json` (normalized events + metadata). Transition column to terminal state.
13. If status is `completed` or `truncated` AND judge is enabled → fire judge for this run (see § Judge flow).

### Cancel semantics

Stop button → SIGTERM → 2s wait → SIGKILL if still alive. Partial transcript persisted with `status: "cancelled"`. Column shows "Cancelled at turn N". Cancel does not trigger the judge.

---

## Judge flow

The judge is **per-variant**, powered by **Haiku**. It runs independently for each completed/truncated run; no debouncing, no generation IDs, no cross-column awareness.

1. When a run reaches `completed` or `truncated`, fire a judge subprocess for that run.
2. Judge input (explicit caps to avoid context blowouts):
   - The prompt (verbatim, capped at 4 KB).
   - The variant content (verbatim, capped at 8 KB).
   - Final assistant message (capped at 4 KB with mid-body ellipsis).
   - Tool-call summary: one line per tool use, `tool_name(arg_summary) → result_summary`, each summary capped at 200 chars.
   - Write mode: a manifest of files in `<run>/outputs/` (paths + sizes; no content).
   - Rubric: **Accuracy, Completeness, Adherence, Clarity**, each scored 0–100 using the 5-band anchor scale below.
3. The judge prompt includes a verbatim scoring rubric (mirroring claude's `code-review` skill pattern) plus an explicit instruction: *"Score Accuracy conservatively. You do not have ground truth about the user's codebase; if you cannot verify correctness from the evidence in the transcript, score Accuracy ≤ 50 and explain the uncertainty in the rationale."* Anchor points:
   - **0** — Criterion is not satisfied at all.
   - **25** — Barely satisfied; major gaps.
   - **50** — Partially satisfied; meaningful gaps that a reviewer would flag.
   - **75** — Largely satisfied; minor gaps at most.
   - **100** — Fully satisfied with no observable gaps.
4. Spawn:
   ```
   claude -p "<judge-prompt>" --model haiku \
     --output-format json \
     --tools        "" \
     --allowedTools "" \
     --strict-mcp-config \
     --setting-sources user
   ```
   - `cwd` = `os.tmpdir()` (the judge must NOT inherit the user's project cwd, or it would walk up applying their `.claude/settings.json`, hooks, and project-scoped tool overrides — silent score contamination).
   - `--setting-sources user` keeps the source explicit and predictable across projects.

   Judge uses no tools — it reads its inputs from the prompt and emits structured JSON. Output shape enforced via prompt + ajv validation (with `--json-schema` fallback if supported by the installed CLI).
5. On schema failure, retry once with an error-explaining follow-up. Still invalid → `judge.json.status = "errored"` with the error surfaced in the UI; the column's run results are untouched.
6. Write `<run>/judge.json`. Push `judge.updated` (or `judge.errored`) for that column over SSE.

UI: the JudgeCard for each column renders 4 numeric scores (0–100) + short rationale. There is no "winner highlight" — the human compares scorecards visually.

---

## UI shape

Single scrollable page.

**Top bar**: **Mode: Read-only / Write** (disabled while any column is running), **Judge ON/OFF** (disabled while any column is running), **Start new** (confirm dialog → cancels running columns, then deletes every run folder + `session.json` under `~/.mdredd/`, preserving `.gitignore` and `.lock`).

**Column row** (up to 3 columns; `+` button hidden at cap and hidden while any column is running):
- Header: variant name input (empty triggers Haiku slug), variant source (textarea + upload button), variant-type indicator (CLAUDE.md / skill / agent, inferred or explicit), skill/agent name field when applicable, model dropdown.
- Prompt textarea.
- **Run / Stop** button. Run is disabled when (a) this column is not idle, or (b) any other column is in a non-terminal state. Stop is enabled only while this column is running. Progress readout: `turn N · mm:ss · last tool: <Name>`.
- Transcript: live streaming; collapsible sections for thinking, tool calls, tool results; final message expanded. Badges for truncation (with reason) and cancellation.
- Outputs list (Write mode only): files in `<run>/outputs/` with paths + sizes; clicking opens content.
- Scorecard (after judge fires): 4 rubric scores (0–100) + rationale.

**Editing lock**: all editable fields (variant textareas, prompt fields, model dropdowns, variant name, mode/judge toggles, + button) become read-only whenever any column is in `preparing` or `streaming`. Only Stop buttons on active columns and Start new remain interactive. Lock releases as soon as every column is in a terminal state (`completed`/`cancelled`/`truncated`/`errored`/`abandoned`/`idle`).

**State restoration**: on initial page load and after any SSE reconnect, the client `GET /api/state` returns the full session: column configs, each column's current-run folder path, transcript events, outputs file list, and judge payload (all reassembled from disk — `session.json` + each run folder). SSE reconnects via `Last-Event-ID` for delta updates only; the initial snapshot always comes from disk.

---

## Persistence layout

```
~/.mdredd/
├── .gitignore                              # auto-written: "*" plus "!.gitignore" (no-op outside a git repo)
├── .lock                                   # pid + port of running instance
├── session.json                            # column → run mapping, mode, judge toggle, variant name/content/prompt/model for each column
└── 2026-04-23T15-30-12-345-concise-style-a1b2c3/   # one run
    ├── config.json                         # prompt/variant ref/model/mode/status/timestamps/truncation
    ├── variant.md                          # variant content snapshot
    ├── transcript.json                     # normalized events + metadata
    ├── stream.jsonl                        # raw stream-json for post-mortem
    ├── stderr.log
    ├── parse-errors.log                    # any unparseable lines (may be empty)
    ├── judge.json                          # per-variant judgment (present when judge fired)
    ├── project/                            # claude's cwd for this run
    │   ├── CLAUDE.md                       # the variant (or skill/agent path)
    │   ├── .claude/settings.json           # write mode only
    │   ├── src → <cwd>/src                 # per-top-level symlinks (gitignore-filtered)
    │   ├── package.json → <cwd>/package.json
    │   └── …
    └── outputs/                            # model-produced files (present in both modes; empty in read-only)
```

Atomic writes via `*.tmp` + `rename`. File-level locks via `proper-lockfile` where multiple processes touch the same file.

**Start new**: confirms with the user, cancels all running runs, then removes every entry under `~/.mdredd/` except `.gitignore` and `.lock`. Server rewrites a fresh `session.json` with default column defaults.

---

## Data schemas

TS types + ajv validators live under `src/shared/schemas/`. JSON Schemas are generated from these.

### `session.json`
```ts
{
  mode: "read-only" | "write";
  judgeEnabled: boolean;
  defaultModel: string;
  cwd: string;                               // absolute
  columns: Array<{
    id: string;                              // "col-1"
    variantName: string;                     // user-entered; empty → Haiku summary at run time
    variantType: "CLAUDE.md" | "skill" | "agent";
    skillOrAgentName: string | null;
    variantContent: string;                  // current draft; restored on reload
    prompt: string;                          // current draft; restored on reload
    model: string;
    currentRunFolder: string | null;         // run folder name under ~/.mdredd/
  }>;
}
```

### `config.json` (per-run)
```ts
{
  runFolder: string;                         // the folder name itself
  columnId: string;
  variantName: string;
  variantType: "CLAUDE.md" | "skill" | "agent";
  skillOrAgentName: string | null;
  variantContentSha256: string;
  promptSha256: string;
  model: string;
  mode: "read-only" | "write";
  status: "preparing" | "streaming" | "completed" | "cancelled" | "truncated" | "errored" | "abandoned";
  startedAt: string;
  endedAt: string | null;
  turnCount: number;
  wallClockMs: number;
  truncationReason: "turns" | "wallclock" | null;
  exitCode: number | null;
  signal: string | null;
}
```

### `transcript.json` (per-run)
```ts
{
  runFolder: string;
  events: NormalizedEvent[];                 // shape matches § SSE event schema payloads
  status: Status;
  startedAt: string;
  endedAt: string | null;
  turnCount: number;
  wallClockMs: number;
  truncationReason: "turns" | "wallclock" | null;
}
```

### `judge.json` (per-run)
```ts
{
  runFolder: string;
  createdAt: string;
  judgeModel: string;                        // "haiku"
  status: "ok" | "errored";
  error?: string;
  scores: {                                  // present when status = "ok"
    accuracy: number;                        // 0–100 integer, snapped to 0/25/50/75/100
    completeness: number;
    adherence: number;
    clarity: number;
  };
  rationale: string;                         // ≤ 600 chars; present when status = "ok"
}
```

---

## SSE event schema

```ts
type ServerEvent =
  | { t: "run.started",     col: string, runFolder: string, seq: number }
  | { t: "run.turn",        col: string, turn: number, seq: number }
  | { t: "run.partial",     col: string, chunk: string, seq: number }
  | { t: "run.message",     col: string, role: "assistant"|"user"|"tool", content: unknown, seq: number }
  | { t: "run.toolUse",     col: string, tool: string, argsSummary: string, seq: number }
  | { t: "run.toolResult",  col: string, tool: string, resultSummary: string, seq: number }
  | { t: "run.permissionDenied", col: string, tool: string, path: string, seq: number }
  | { t: "run.ended",       col: string, status: "completed"|"cancelled"|"truncated"|"errored"|"abandoned", reason?: string, seq: number }
  | { t: "run.outputs",     col: string, files: Array<{path: string, bytes: number}>, seq: number }
  | { t: "judge.started",   col: string, seq: number }
  | { t: "judge.updated",   col: string, payload: JudgeJson, seq: number }
  | { t: "judge.errored",   col: string, error: string, seq: number }
  | { t: "server.heartbeat", seq: number };
```

`seq` is monotonic across server lifetime and survives restart (persisted). Clients reconnect via `Last-Event-ID` and the server replays from disk. Heartbeat every 15 s.

---

## Files to create (critical paths)

- `src/server/runner.ts` — subprocess spawn, stream-json parse, two-cap enforcement, parse-error logging.
- `src/server/sandbox.ts` — run folder creation, project mirror (per-top-level symlinks with gitignore + hard-exclude), variant placement, settings.json emission.
- `src/server/judge.ts` — per-variant Haiku invocation with conservative-scoring rubric, ajv validation, retry-once.
- `src/server/slug.ts` — Haiku slug generation, fallback, hashing, collision handling.
- `src/server/session.ts` — session state, disk-authoritative state restoration, abandoned-run recovery on boot, Start-new reset.
- `src/shared/schemas/` — single source of truth for types + validators.
- `src/web/components/TranscriptView.tsx` — streaming transcript at readable density.

---

## Verification

1. `npm install && npm run build` — clean; type-check clean.
2. `npm link` exposes `mdredd` globally.
3. **Preflight negatives**: missing / unauthenticated claude → actionable UI error before any column renders.
4. **Happy read-only**: in a test dir with `.git/` and `.ts` sources, paste two CLAUDE.md variants (A: "be concise"; B: "be thorough"), different prompts, Run both. Transcripts stream live; turn counts increment.
5. **git status stays clean**: after step 4, `git status` in cwd is unchanged — mdredd writes nothing into the user's project.
6. **Read-only safety**: prompt variant with "edit README.md to add a line" → `run.permissionDenied` events surface in the transcript; user's real README.md is unmodified; `<run>/outputs/` is empty.
7. **Write-mode happy path**: switch to Write; prompt "write a summary to summary.md" → `summary.md` lands in `<run>/outputs/`; user's real project untouched.
8. **Write-mode deny bites**: Write-mode prompt "write to project root / README.md" → `run.permissionDenied` surfaces; no file created outside `<run>/outputs/`.
9. **Per-variant judge (Haiku)**: after any column completes, a Haiku judge fires for that column only; `judge.json` appears in its run folder with `judgeModel: "haiku"` and 4 scores in {0,25,50,75,100}; other columns' scorecards unaffected.
10. **Judge conservatism**: prompt where ground truth is unverifiable → `scores.accuracy` ≤ 50 with the uncertainty called out in `rationale`.
11. **Cancel**: Stop mid-stream → subprocess dies in ≤2 s; status = `cancelled`; no judge fires.
12. **Rerun**: edit column 2's variant, Run → new run folder appears with new timestamp; column 2 shows the latest; column 1's existing run remains.
13. **Editing lock**: while any column is running, all variant/prompt/model/mode/judge fields and `+` are disabled; idle columns' Run is disabled. After every column reaches a terminal state, the UI unlocks.
14. **State restoration**: stop the server mid-eval, start it again; UI reloads with the same variant text, prompts, transcripts, outputs, and judge scores for every run that completed; any in-flight column reloads as `abandoned`.
15. **Start new**: click Start new → confirmation dialog → after confirm, every run folder and `session.json` are removed; `.gitignore` and `.lock` remain; UI returns to two blank columns.
16. **Skill variant**: variant lands at `<run>/project/.claude/skills/<name>/SKILL.md`; subprocess picks it up at runtime.
17. **Agent variant**: same for `.claude/agents/<name>.md`.
18. **Turn cap**: dev-build cap = 3; prompt requires >3 turns → `truncated` with `truncationReason: "turns"`; judge still fires.
19. **Wall-clock cap**: dev-build cap = 10 s; long prompt → `truncationReason: "wallclock"`.
20. **Parse resilience**: fake-claude harness (V28) emits a malformed line → `parse-errors.log` has it; runner continues.
21. **Parallel**: Run all 3 columns at once; all 3 subprocesses start within a few seconds; transcripts stream concurrently.
22. **Column cap**: UI `+` hidden at 3; server POST for a 4th column → 400.
23. **Tab close mid-run**: close tab → run continues; reopen → UI reconnects via `Last-Event-ID` and resumes streaming.
24. **Duplicate folder name**: contrived collision on timestamp + slug + hash → `-1` suffix applied cleanly.
25. **Already running**: server POST /run on a streaming column → 409.
26. **Empty prompt / whitespace variant**: client rejects; server fallback → 400.
27. **cwd guard**: run from `$HOME` or at-or-under `~/.mdredd/` → refused with clear error.
28. **Security**: `curl` without session token → 401; with wrong `Origin` → 403; server never binds `0.0.0.0`.
29. **Judge schema failure**: inject a judge response missing a field → retry once; still invalid → `judge.status = "errored"`, column's run results intact.
30. **Fake-claude harness**: test binary emits valid stream-json, invalid JSON, partial chunks, stderr auth errors, long-running output, non-zero exits. Runner handles all without crashing. Primary test vehicle during dev.
31. **Haiku slug offline fallback**: simulate Haiku failure → slug base = `variant`; run proceeds.
32. **Recursion guard**: cwd entry whose realpath contains the storage root → mirror skips it cleanly; no symlink cycle.
33. **macOS + Linux parity**: run both; symlink semantics match. (WSL: print URL if `open` fails, defer.)

---

## Deferred to v2

- Wall-clock extension / "stuck" pattern detection.
- Expert-mode Bash (and Task) toggle per eval with UI safety warning.
- Rubric customization (library + user-defined).
- Prompt-lock toggle (copy a master column's prompt to the others).
- Prompt library / suites / multi-turn conversation scripts.
- History UI (browsable past runs within the app beyond the current session's columns).
- Sandbox cleanup (`mdredd gc`).
- Selection-time variant snapshotting.
- Gemini CLI / Codex support; WSL first-class support.

---

## Open questions

All v1 decisions are locked.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

MDredd is a CLI that A/B tests Claude Code instruction files. It boots a local HTTP server + browser UI that runs two or three variants of a `CLAUDE.md`, skill (`.claude/skills/<name>/SKILL.md`), or agent (`.claude/agents/<name>.md`) in parallel by spawning child `claude` processes — one per variant — each in its own per-run sandbox under `~/.mdredd/<run-folder>/`. Results stream live via SSE; an optional Haiku judge scores each variant on a 0/25/50/75/100 rubric (Accuracy, Completeness, Adherence, Clarity).

The tool relies on the user's existing Claude Code auth — there is no separate API key handling. The user-facing flow and isolation guarantees are documented in detail in `README.md`; read it before changing anything in `src/server/sandbox.ts` or `src/server/runner.ts`.

## Common commands

```bash
npm run dev           # concurrently runs dev:server (tsx watch) + dev:web (Vite @ :5173 → proxies to :6800)
npm run dev:server    # tsx watch src/server/index.ts
npm run dev:web       # Vite dev server only

npm run build         # build:web + build:server (required before `bin/mdredd.js` will run)
npm run build:server  # tsc → dist/, then tsc-alias rewrites @shared/* imports to relative paths
npm run build:web     # Vite → dist/web

npm run typecheck     # tsc --noEmit against tsconfig.json (covers both server + web)
npm run lint          # eslint .
npm run format        # prettier --write .
npm run format:check  # prettier --check .

npm test              # judge + preflight + runner + sandbox + security specs (in that order)
npm run test:judge        # tsx test/judge.spec.ts
npm run test:preflight    # tsx test/preflight.spec.ts
npm run test:runner       # tsx test/runner.smoke.ts
npm run test:sandbox      # tsx test/sandbox.spec.ts
```

### Environment and CLI flags

- `CLAUDE_BIN` — path to the `claude` binary. Defaults to `claude` (resolved via PATH). Point this at `test/fake-claude.mjs` to drive the runner deterministically without spending tokens.
- `MDREDD_LOG_LEVEL` — `debug` | `info` (default) | `warn` | `error`. Server-only; logs go to stdout (info/debug) or stderr (warn/error).
- `bin/mdredd.js` flags: `--force` (skip the project-marker check from `cwdGuard` — useful when running mdredd from a directory without `.git`/`package.json`/etc.); `--no-open` (don't auto-open the browser).

Tests are plain tsx scripts, not a framework. Each file declares scenarios via a local `scenario(name, fn)` helper and exits non-zero on failure. To run a single scenario, edit the file's queue or comment out the others — there's no `--grep`. Most server tests use `test/fake-claude.mjs` (a stand-in for the real `claude` CLI) selected via `FAKE_CLAUDE_SCENARIO` env vars.

## Architecture

### Layout

- `bin/mdredd.js` — published entry point. Refuses to run without `dist/`; tells users to `npm run build`.
- `src/server/` — Node `http` server (no Express/Fastify). Owns preflight, sandboxing, child-process spawning, stream parsing, judge runs, SSE fan-out, and the static-asset fallback for the SPA.
- `src/web/` — React 19 + Vite SPA. Communicates with the server over REST + an `EventSource` SSE stream. Same-origin only — no token plumbing; the server enforces auth via the Host + Origin headers (see "Authentication" below).
- `src/shared/` — Zod schemas (`schemas/`) and constants used by both. Imported as `@shared/*` (path alias).
- `test/` — flat tsx scripts. `test/fake-claude.mjs` is the deterministic stand-in for `claude` used by the runner, preflight, and judge specs.
- `agents/` — gitignored locally (see `.gitignore`); written by mdredd when run from this repo against itself. Don't commit anything from here.

### Build and the `@shared/*` alias

`@shared/*` maps to `src/shared/*` (see `tsconfig.json` paths). At build time, `tsc-alias` rewrites these import specifiers in the emitted server bundle — without it, the compiled server would crash with unresolved `@shared/...` paths. Vite handles the same rewrite for the web bundle via its `tsconfigPaths` resolver. If you add a new top-level shared subdirectory, no config change is needed; if you change the alias, update **both** `tsconfig.json` and `vite.config.ts`.

### Server-side data flow (per run)

1. **Preflight** (`src/server/preflight.ts`) — verifies the `claude` binary is on PATH and supports the required CLI flags (offline checks: `--version` + `--help` parsing). No live API ping — auth issues surface in the first run's stderr via SSE, which is more diagnosable than a gate-zero blocker on transient API hiccups. Acquires `~/.mdredd/.lock` via `proper-lockfile` (single-instance guarantee); writes a `.lock.meta.json` sidecar with pid/port for human debugging. Mass-marks any `preparing`/`streaming` runs from a previous boot as `abandoned` and ensures a `~/.mdredd/.gitignore` exists.
2. **Sandbox** (`src/server/sandbox.ts`) — for each run, builds `~/.mdredd/<runFolder>/project/` as the child `claude` cwd. **This is the central isolation primitive — read its file-level docstring before changing anything.** Key invariants:
   - An **empty `.git/`** is planted on a `sandbox` branch so Claude Code's upward project-root walk terminates inside the run dir. This prevents host git status, branch, recent commits, and per-project auto-memory from leaking into the child's system prompt.
   - Top-level entries of the user's project are mirrored by recursively walking the source tree, creating real directories on the sandbox side and **symlinking only individual files**. Filtering applies at every level: `HARD_EXCLUDED` (`.git`, `.claude`, `node_modules`, `.DS_Store`), root + nested `.gitignore`, the user's global git excludes file, symlinks whose realpath escapes `cwd`, and symlink cycles.
   - In `write` mode, a `.claude/settings.json` allows `Write`/`Edit` only against `../outputs/**` (the per-run outputs dir, one level above the child's cwd). Read-only mode passes a tools allowlist of `Read,Glob,Grep,WebSearch,WebFetch`; write mode adds `Write,Edit`.
3. **Spawn** (`src/server/runner.ts`) — invokes `claude -p <prompt> --output-format stream-json --include-partial-messages --verbose --model <m> --tools <list> --allowedTools <list> --strict-mcp-config --setting-sources project --disable-slash-commands`. The runner **strips** `NODE_OPTIONS`, `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR`, `GIT_CEILING_DIRECTORIES`, `CLAUDE_PROJECT_DIR`, `CLAUDE_PROJECT_NAME` from the spawn environment so a parent shell can't override the planted sandbox. `HOME` / `CLAUDE_CONFIG_DIR` are kept so the child reads the user's auth.
4. **Stream parsing** (`src/server/claudeStream.ts`) — line-buffers stdout into Anthropic stream events. Normalizes them into `NormalizedEvent`s (see `src/shared/schemas/events.ts`). Two non-obvious rules:
   - **Turn counting:** increment on `message_stop` only when `currentMessageRole === 'assistant'` and `stop_reason !== 'tool_use'`. Partial deltas never count.
   - **Tool result pairing:** `tool_result` events arrive in a later (user) message and may be reordered relative to their `tool_use` blocks. Pair by `tool_use_id`, not by recency (issue #5).
5. **Persistence** — each run dir holds `config.json`, `init.json` (the child's first `system init` payload, used as the audit trail and the auto-memory leak detector), `stream.jsonl` (raw), `transcript.ndjson` (append-only normalized log; lets `/api/state` replay an in-flight run after a refresh), `transcript.json` (canonical, written at finalize), `variant.md` (exact bytes the run was given), `outputs/` (only populated in write mode), `judge.json` (after the judge runs).
6. **Judge** (`src/server/judge.ts`) — subprocess invocation with `--json-schema`. Default model is Haiku 4.5 but user-selectable via the topbar popover and persisted as `session.judgeModel`; effort flag is sourced from `defaultEffortForModel` (none for Haiku, `high` for Sonnet, `xhigh` for Opus). The rubric is built per-run from `runConfig` (`buildRubric`) so harness limits — `toolAllowlist`, mode, `STREAM_TOOL_*_CAP_CHARS` — appear verbatim in the prompt; criteria the judge can't evaluate from inside the sandbox are flagged via `ungradeable.<criterion>=true` and rendered as `—` instead of a low band. Each transcript section is byte-capped (`JUDGE_*_CAP_*` in `src/shared/constants.ts`). On timeout, retries once with halved caps (issue #12). A per-run **canary token** is embedded in the prompt; if the judge's response contains it, the run is treated as poisoned by prompt injection and rejected.
7. **SSE fan-out** (`src/server/runManager.ts`) — every event gets a monotonic `seq`. `/sse` honors `Last-Event-ID` and replays from a 2000-event ring buffer. The `seq` counter persists to `~/.mdredd/.seq` (debounced; min 250ms between writes). On restart it advances past `RING_BUFFER_LIMIT` so post-crash seqs cannot collide with values clients still hold (issue #10).

### Web-side

`src/web/App.tsx` owns the global reducer and the SSE subscription. The page boot fetches `/api/state` (a snapshot of `session.json` + every run bundle on disk) and reconciles it with live SSE events keyed by column id. `liveStateFromTranscript` projects a persisted normalized transcript onto the in-memory live-event shape so a mid-run page refresh still surfaces the prefix; the projection mirrors the SSE reducer's collapsing rules — keep them in sync if you change either.

Authentication is same-origin only — no per-launch session token. Every `/api/*` and `/sse` request must arrive with `Host` matching `127.0.0.1:<port>` or `localhost:<port>` (blocks DNS rebinding) AND `Origin` matching the bound `http://127.0.0.1:<port>` (blocks cross-origin fetches). Static assets are unauthenticated so top-level navigations (no `Origin` header) can load the SPA. In dev mode, Vite's proxy rewrites `Origin` and `Host` so the server only ever sees its own values; if you change the Vite proxy config, keep `changeOrigin: true` + the explicit `Origin` header rewrite or the SPA will start getting 403s.

In dev (`tsx watch`), the URL is stable across server restarts (no token to regenerate), so we only auto-open the browser on the **first** launch within a given `tsx watch` session. The `~/.mdredd/.dev-open-marker` file records the parent pid (the watcher); a launch with a matching parent pid skips `open()`. A fresh `npm run dev` invocation has a new parent pid → opens once → subsequent file-change restarts under the same watcher do not.

### React Compiler is on

`vite.config.ts` and `eslint.config.js` enable the React Compiler (`babel-plugin-react-compiler` + `eslint-plugin-react-compiler`). Don't reach for `useMemo`/`useCallback` for render-perf reasons — the compiler memoizes for you, and the lint rule (`react-compiler/react-compiler: error`) will fail CI if a component violates the compiler's assumptions. Use `useCallback` only when the identity is needed by an external API (e.g. an effect dependency or a stable child prop).

### Single instance and lock semantics

There can be at most one mdredd process per machine because the `~/.mdredd/` storage root is shared. The lock is `proper-lockfile` with a 5-minute stale window. Bind failures (`EADDRINUSE`), lock-meta-write failures, and any thrown error during startup all release the lock before exiting — without that, a botched startup would block restart for 5 minutes. If you add a new failure path between `acquireLock` and the `server.listen` callback, make sure `releaseLock` runs.

## Conventions

- TypeScript everywhere. `strict: true`, plus `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`. Server uses NodeNext modules, web uses ESNext + bundler resolution.
- Prettier: 2 spaces, single quotes, trailing commas, 100 col print width, semicolons.
- Validation at boundaries: persisted JSON is parsed through Zod (`SessionFileSchema`, `NormalizedEventSchema`). When something fails to parse on load, log a warning and reset to a sane default — do not crash the harness.
- Don't add a logging library; use `src/server/log.ts` (level-gated, key=value formatted, `MDREDD_LOG_LEVEL=debug` to enable verbose). Web side uses plain `console`.

## CI

`.github/workflows/ci.yml` runs four jobs in parallel on Node 22.13.x: `lint` (eslint + prettier check), `typecheck`, `build`, `test` (preflight, judge, runner, sandbox specs). All four must pass for the `ci-success` gate. CI only triggers when paths under `src/`, `test/`, `bin/`, build configs, or the workflow itself change — README/doc-only commits skip CI.

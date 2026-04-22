## Agent Eval Tool — High-Level Plan

### What it is
A local CLI tool for evaluating and comparing different versions of `CLAUDE.md` / skill files against the same prompt, using Claude Code as the underlying agent.

### How it works
- User runs `comparator` (or final name) from their project directory
- A Node.js server starts, opens `http://localhost:<PORT>` in the default browser
- The UI lets them configure and run evaluations, results persist as local JSON files

---

### Stack
- **Runtime:** Node.js
- **CLI entry:** single `bin` script, published to npm as a global install
- **Frontend:** React (bundled into the package as `dist/`, served statically by the Node server)
- **Browser launch:** `open` package
- **Port selection:** dynamic (avoid hardcoded 3000)
- **Persistence:** flat JSON files in the working directory (no database)
- **Agent execution:** spawns `claude` subprocesses, captures stdout/stderr

---

### Core features (v1 scope)
- Auto-detect `CLAUDE.md` and skill files in the current working directory
- UI to pick model, enter prompt, select which instruction file variants to test
- Run variants sequentially (temp dir approach — each run gets its own dir with the variant file placed as `CLAUDE.md`)
- Capture and display outputs side by side
- Optional: judge model run (a separate Claude call that scores/compares the two outputs)

---

### Key constraints
- Claude Code must already be installed on the machine (`claude` available in PATH)
- No API key management — piggybacks on the user's existing Claude auth
- Works on macOS and Linux; WSL is a known edge case (print URL as fallback)
- Claude-only at first (no Gemini CLI or Codex support yet)

---

### Open questions to revisit
- Final package name (check npm availability)
- Whether to support parallel runs or sequential-only in v1
- How much of the Claude Code system prompt to preserve vs. replace when injecting variants (`--bare` + `--system-prompt-file` vs. temp dir approach)
- Judge model UX — automatic after each run, or manually triggered?

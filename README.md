# mdredd

> A/B test your Claude Code instruction files.

Evaluate different versions of your `CLAUDE.md`, skills, and agent files side-by-side using Claude Code itself. Iterate on your instructions with evidence instead of vibes.

## The problem

You edit `CLAUDE.md` hoping Claude will follow instructions better. You run a prompt. The response seems... different? Hard to tell if it's actually better — Claude varies from run to run, and you're comparing today's output against a fuzzy memory of yesterday's.

Without a structured way to compare variants, every instruction tweak is a guess.

## What mdredd does

mdredd runs two (or more) versions of the same instruction file against the same prompt, in parallel, and shows you the full results side by side. An optional judge model scores them on a rubric (Accuracy, Completeness, Instruction Adherence, Clarity) and picks a winner.

## What you can do with it

- Compare two versions of your project's `CLAUDE.md` on the same prompt
- See whether a skill you wrote actually shapes the output the way you expect
- A/B test different wordings in an agent definition
- Inspect full transcripts — tool calls, reasoning, final answer — for every variant
- Get a structured rubric score and winner from a judge model

## How it fits your workflow

- Run `mdredd` from any project directory
- A browser UI opens locally with two variant columns (add more with `+`)
- Paste or pick instruction-file variants; write a prompt per column; click Run
- Each variant runs in an isolated sandbox — your source files stay untouched
- Results stream live; judge scores appear once runs complete

## Requirements

- [Claude Code](https://www.anthropic.com/claude-code) installed and authenticated (`claude` available in your shell)
- Node.js
- macOS or Linux

You don't need an API key — mdredd piggybacks on your existing Claude Code auth.

## Status

Early development.

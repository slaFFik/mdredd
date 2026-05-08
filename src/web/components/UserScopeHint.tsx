import type { JSX } from 'react';

export function UserScopeHint(): JSX.Element {
  return (
    <div className="user-scope-hint">
      <p>
        <strong>Off (default)</strong> — Project-scope only. Variants run without your user-level
        settings, skills, plugins, or CLAUDE.md.
      </p>
      <p>
        <strong>On</strong> — Adds the user setting source:
      </p>
      <ul>
        <li>~/.claude/CLAUDE.md</li>
        <li>~/.claude/skills/* (slash commands)</li>
        <li>Enabled plugins (skills, hooks, agents)</li>
        <li>Permissions + env from settings.json</li>
      </ul>
      <p className="dim">Per-user reproducible only.</p>
    </div>
  );
}

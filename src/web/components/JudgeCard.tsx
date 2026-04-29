import type { JudgeFile, JudgeWarning } from '@shared/schemas/judge.js';
import type { TokenUsage } from '@shared/schemas/run.js';
import type { JSX, ReactNode } from 'react';
import { Hint } from './Hint.js';
import { formatCost, formatTokenCount } from '../lib/format.js';

function renderRationale(text: string): ReactNode[] {
  return text.split(/(`[^`]+`)/g).map((part, i) => {
    if (part.length > 1 && part.startsWith('`') && part.endsWith('`')) {
      return <code key={i}>{part.slice(1, -1)}</code>;
    }
    return part;
  });
}

function ScoreRow(props: {
  label: string;
  score: number;
  rationale?: string;
  ungradeable?: boolean;
  // Self-consistency warning attached to this criterion — score/rationale
  // mismatch flagged by the post-parse heuristic.
  warning?: JudgeWarning;
}): JSX.Element {
  const display = props.ungradeable ? '—' : props.score;
  const title = props.ungradeable ? 'Ungradeable: harness limit prevented evaluation' : undefined;
  const row: ReactNode = (
    <tr>
      <td>{props.label}</td>
      <td className="score" title={title}>
        {display}
        {props.warning && <WarningBadge warning={props.warning} />}
      </td>
    </tr>
  );
  if (!props.rationale) return row as JSX.Element;
  return (
    <Hint content={renderRationale(props.rationale)} side="left" align="center">
      {row}
    </Hint>
  );
}

function WarningBadge(props: { warning: JudgeWarning }): JSX.Element {
  return (
    <span className="judge-warning" title={props.warning.message}>
      ⚠
    </span>
  );
}

export function JudgeCard(
  props: { judge: JudgeFile; judging?: never } | { judge?: never; judging: true },
): JSX.Element {
  if (props.judging) {
    return (
      <div className="judge-card">
        <strong>
          <span className="judge-spinner" aria-hidden="true" /> Judging…
        </strong>
      </div>
    );
  }
  const j = props.judge;
  if (j.status === 'errored') {
    return (
      <div className="judge-card">
        <strong>Judge failed</strong>
        <div style={{ color: 'var(--err)', marginTop: 4, fontSize: 12 }}>{j.error}</div>
      </div>
    );
  }
  if (!j.scores)
    return (
      <div className="judge-card">
        <em>Judge pending…</em>
      </div>
    );
  const s = j.scores;
  const r = j.scoreRationales;
  const u = j.ungradeable;
  const warningsByCriterion = indexWarnings(j.warnings);
  return (
    <div className="judge-card">
      <strong>Judge</strong>
      <table>
        <tbody>
          <ScoreRow
            label="Accuracy"
            score={s.accuracy}
            rationale={r?.accuracy}
            ungradeable={u?.accuracy}
            warning={warningsByCriterion.accuracy}
          />
          <ScoreRow
            label="Completeness"
            score={s.completeness}
            rationale={r?.completeness}
            ungradeable={u?.completeness}
            warning={warningsByCriterion.completeness}
          />
          <ScoreRow
            label="Adherence"
            score={s.adherence}
            rationale={r?.adherence}
            ungradeable={u?.adherence}
            warning={warningsByCriterion.adherence}
          />
          <ScoreRow
            label="Clarity"
            score={s.clarity}
            rationale={r?.clarity}
            ungradeable={u?.clarity}
            warning={warningsByCriterion.clarity}
          />
        </tbody>
      </table>
      {j.rationale && <div className="rationale">{renderRationale(j.rationale)}</div>}
      <JudgeUsageFooter tokenUsage={j.tokenUsage} costUsd={j.costUsd} />
    </div>
  );
}

// Index warnings by criterion for fast lookup in ScoreRow. The heuristic
// returns at most one per criterion, but we keep the latest defensively.
function indexWarnings(
  warnings: JudgeWarning[] | undefined,
): Partial<Record<JudgeWarning['criterion'], JudgeWarning>> {
  const out: Partial<Record<JudgeWarning['criterion'], JudgeWarning>> = {};
  if (!warnings) return out;
  for (const w of warnings) out[w.criterion] = w;
  return out;
}

function JudgeUsageFooter(props: {
  tokenUsage?: TokenUsage | null;
  costUsd?: number | null;
}): JSX.Element | null {
  const u = props.tokenUsage ?? null;
  const cost = typeof props.costUsd === 'number' ? props.costUsd : null;
  const parts: string[] = [];
  let tokensTitle: string | undefined;
  if (u) {
    const input = u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens;
    const output = u.outputTokens;
    if (input > 0 || output > 0) {
      parts.push(`${formatTokenCount(input)} in / ${formatTokenCount(output)} out`);
      tokensTitle =
        `Input = new + cache-read + cache-creation (new=${u.inputTokens}, ` +
        `cache-read=${u.cacheReadTokens}, cache-creation=${u.cacheCreationTokens}). ` +
        `Output = generated tokens. Numbers from the judge subprocess.`;
    }
  }
  if (cost !== null && cost > 0) parts.push(formatCost(cost));
  if (parts.length === 0) return null;
  return (
    <div className="judge-usage" title={tokensTitle}>
      {parts.join(' · ')}
    </div>
  );
}

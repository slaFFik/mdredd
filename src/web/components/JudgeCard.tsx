import type { JudgeFile, JudgeScores, JudgeWarning } from '@shared/schemas/judge.js';
import type { TokenUsage } from '@shared/schemas/run.js';
import type { JSX, ReactNode } from 'react';
import { Hint } from './Hint.js';
import { formatCost, formatTokenCount } from '../lib/format.js';

type Confidence = 'high' | 'medium' | 'low';

function renderRationale(text: string): ReactNode[] {
  return text.split(/(`[^`]+`)/g).map((part, i) => {
    if (part.length > 1 && part.startsWith('`') && part.endsWith('`')) {
      return <code key={i}>{part.slice(1, -1)}</code>;
    }
    return part;
  });
}

// Confidence in a per-criterion score derived from inter-judge agreement (M5).
// Bands are 0/25/50/75/100, so the gap between two scores is always a multiple
// of 25. "Same band" = exact match. "Adjacent" = one band apart (gap = 25).
// "Two+ apart" = gap ≥ 50.
function bandConfidence(scores: number[]): Confidence | null {
  if (scores.length < 2) return null;
  let maxGap = 0;
  for (let i = 0; i < scores.length; i++) {
    for (let j = i + 1; j < scores.length; j++) {
      const gap = Math.abs(scores[i]! - scores[j]!);
      if (gap > maxGap) maxGap = gap;
    }
  }
  if (maxGap === 0) return 'high';
  if (maxGap <= 25) return 'medium';
  return 'low';
}

function ScoreRow(props: {
  label: string;
  score: number;
  rationale?: string;
  ungradeable?: boolean;
  // Other judges' scores for this criterion (M5). Excludes the primary score
  // already shown in `score`. Used to compute and render the agreement badge.
  otherScores?: { model: string; score: number; ungradeable?: boolean }[];
  // Self-consistency warning attached to this criterion (M6) — score/rationale
  // mismatch flagged by the post-parse heuristic.
  warning?: JudgeWarning;
}): JSX.Element {
  const display = props.ungradeable ? '—' : props.score;
  const title = props.ungradeable ? 'Ungradeable: harness limit prevented evaluation' : undefined;
  const gradeable =
    props.ungradeable !== true && (props.otherScores ?? []).every((o) => o.ungradeable !== true);
  const allScores = gradeable
    ? [props.score, ...(props.otherScores ?? []).map((o) => o.score)]
    : [];
  const conf = bandConfidence(allScores);
  const row: ReactNode = (
    <tr>
      <td>{props.label}</td>
      <td className="score" title={title}>
        {display}
        {conf && (props.otherScores?.length ?? 0) > 0 && (
          <ConfidenceBadge confidence={conf} primary={props.score} others={props.otherScores!} />
        )}
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

function ConfidenceBadge(props: {
  confidence: Confidence;
  primary: number;
  others: { model: string; score: number; ungradeable?: boolean }[];
}): JSX.Element {
  const breakdown = props.others
    .map((o) => `${o.model}: ${o.ungradeable ? '—' : o.score}`)
    .join(', ');
  const tooltip =
    props.confidence === 'high'
      ? `All judges scored ${props.primary} (${breakdown}).`
      : props.confidence === 'medium'
        ? `Adjacent bands: primary=${props.primary}, others=${breakdown}.`
        : `Disagreement ≥2 bands: primary=${props.primary}, others=${breakdown}. Treat this score with skepticism.`;
  return (
    <span className={`judge-confidence judge-confidence--${props.confidence}`} title={tooltip}>
      {props.confidence === 'high' ? '✓' : props.confidence === 'medium' ? '~' : '!'}
    </span>
  );
}

export function JudgeCard(
  props:
    | { judge: JudgeFile; judgesByModel?: Record<string, JudgeFile>; judging?: never }
    | { judge?: never; judgesByModel?: never; judging: true },
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
  const others = collectOtherJudges(j, props.judgesByModel);
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
            otherScores={others.map((o) => ({
              model: o.label,
              score: o.scores.accuracy,
              ungradeable: o.ungradeable?.accuracy,
            }))}
            warning={warningsByCriterion.accuracy}
          />
          <ScoreRow
            label="Completeness"
            score={s.completeness}
            rationale={r?.completeness}
            ungradeable={u?.completeness}
            otherScores={others.map((o) => ({
              model: o.label,
              score: o.scores.completeness,
              ungradeable: o.ungradeable?.completeness,
            }))}
            warning={warningsByCriterion.completeness}
          />
          <ScoreRow
            label="Adherence"
            score={s.adherence}
            rationale={r?.adherence}
            ungradeable={u?.adherence}
            otherScores={others.map((o) => ({
              model: o.label,
              score: o.scores.adherence,
              ungradeable: o.ungradeable?.adherence,
            }))}
            warning={warningsByCriterion.adherence}
          />
          <ScoreRow
            label="Clarity"
            score={s.clarity}
            rationale={r?.clarity}
            ungradeable={u?.clarity}
            otherScores={others.map((o) => ({
              model: o.label,
              score: o.scores.clarity,
              ungradeable: o.ungradeable?.clarity,
            }))}
            warning={warningsByCriterion.clarity}
          />
        </tbody>
      </table>
      {j.rationale && <div className="rationale">{renderRationale(j.rationale)}</div>}
      <JudgeUsageFooter tokenUsage={j.tokenUsage} costUsd={j.costUsd} />
    </div>
  );
}

// Index warnings by criterion for fast lookup in ScoreRow. Multiple warnings
// per criterion are unlikely (the heuristic returns at most one per criterion)
// but we still keep the latest if it ever happens.
function indexWarnings(
  warnings: JudgeWarning[] | undefined,
): Partial<Record<JudgeWarning['criterion'], JudgeWarning>> {
  const out: Partial<Record<JudgeWarning['criterion'], JudgeWarning>> = {};
  if (!warnings) return out;
  for (const w of warnings) out[w.criterion] = w;
  return out;
}

interface OtherJudge {
  label: string;
  scores: JudgeScores;
  ungradeable?: JudgeFile['ungradeable'];
}

// Pull every per-family judge file *other than* the one currently rendered as
// the primary, returning only those with an `ok` status + a complete scores
// block. The label uses the family name (`haiku`/`sonnet`/`opus`) since that
// is what `judgesByModel` is keyed by — short and readable in the tooltip.
function collectOtherJudges(
  primary: JudgeFile,
  byModel: Record<string, JudgeFile> | undefined,
): OtherJudge[] {
  if (!byModel) return [];
  const out: OtherJudge[] = [];
  for (const [family, file] of Object.entries(byModel)) {
    if (file.status !== 'ok' || !file.scores) continue;
    if (file.judgeModel === primary.judgeModel) continue;
    out.push({ label: family, scores: file.scores, ungradeable: file.ungradeable });
  }
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

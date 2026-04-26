import type { JudgeFile } from '@shared/schemas/judge.js';
import type { JSX, ReactNode } from 'react';
import { Hint } from './Hint.js';

function ScoreRow(props: { label: string; score: number; rationale?: string }): JSX.Element {
  const row: ReactNode = (
    <tr>
      <td>{props.label}</td>
      <td className="score">{props.score}</td>
    </tr>
  );
  if (!props.rationale) return row as JSX.Element;
  return (
    <Hint content={props.rationale} side="left" align="center">
      {row}
    </Hint>
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
  return (
    <div className="judge-card">
      <strong>Judge ({j.judgeModel})</strong>
      <table>
        <tbody>
          <ScoreRow label="Accuracy" score={s.accuracy} rationale={r?.accuracy} />
          <ScoreRow label="Completeness" score={s.completeness} rationale={r?.completeness} />
          <ScoreRow label="Adherence" score={s.adherence} rationale={r?.adherence} />
          <ScoreRow label="Clarity" score={s.clarity} rationale={r?.clarity} />
        </tbody>
      </table>
      {j.rationale && <div className="rationale">{j.rationale}</div>}
    </div>
  );
}

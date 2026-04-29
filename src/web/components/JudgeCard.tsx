import type { JudgeFile } from '@shared/schemas/judge.js';
import type { JSX, ReactNode } from 'react';
import { Hint } from './Hint.js';

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
}): JSX.Element {
  const display = props.ungradeable ? '—' : props.score;
  const title = props.ungradeable ? 'Ungradeable: harness limit prevented evaluation' : undefined;
  const row: ReactNode = (
    <tr>
      <td>{props.label}</td>
      <td className="score" title={title}>
        {display}
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
          />
          <ScoreRow
            label="Completeness"
            score={s.completeness}
            rationale={r?.completeness}
            ungradeable={u?.completeness}
          />
          <ScoreRow
            label="Adherence"
            score={s.adherence}
            rationale={r?.adherence}
            ungradeable={u?.adherence}
          />
          <ScoreRow
            label="Clarity"
            score={s.clarity}
            rationale={r?.clarity}
            ungradeable={u?.clarity}
          />
        </tbody>
      </table>
      {j.rationale && <div className="rationale">{renderRationale(j.rationale)}</div>}
    </div>
  );
}

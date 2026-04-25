import type { JudgeFile } from '@shared/schemas/judge.js';

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
  if (!j.scores) return <div className="judge-card"><em>Judge pending…</em></div>;
  const s = j.scores;
  const r = j.scoreRationales;
  const rowTitle = (key: keyof NonNullable<typeof r>): string | undefined =>
    r ? r[key] : undefined;
  return (
    <div className="judge-card">
      <strong>Judge ({j.judgeModel})</strong>
      <table>
        <tbody>
          <tr title={rowTitle('accuracy')}><td>Accuracy</td><td className="score">{s.accuracy}</td></tr>
          <tr title={rowTitle('completeness')}><td>Completeness</td><td className="score">{s.completeness}</td></tr>
          <tr title={rowTitle('adherence')}><td>Adherence</td><td className="score">{s.adherence}</td></tr>
          <tr title={rowTitle('clarity')}><td>Clarity</td><td className="score">{s.clarity}</td></tr>
        </tbody>
      </table>
      {j.rationale && <div className="rationale">{j.rationale}</div>}
    </div>
  );
}

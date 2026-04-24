import type { JudgeFile } from '@shared/schemas/judge.js';

export function JudgeCard(props: { judge: JudgeFile }): JSX.Element {
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
  return (
    <div className="judge-card">
      <strong>Judge ({j.judgeModel})</strong>
      <table>
        <tbody>
          <tr><td>Accuracy</td><td className="score">{s.accuracy}</td></tr>
          <tr><td>Completeness</td><td className="score">{s.completeness}</td></tr>
          <tr><td>Adherence</td><td className="score">{s.adherence}</td></tr>
          <tr><td>Clarity</td><td className="score">{s.clarity}</td></tr>
        </tbody>
      </table>
      {j.rationale && <div className="rationale">{j.rationale}</div>}
    </div>
  );
}

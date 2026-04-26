import type { JSX } from 'react';

export function PromptField(props: {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}): JSX.Element {
  return (
    <div className="prompt-field">
      <div className="row">
        <label>Prompt</label>
      </div>
      <textarea
        placeholder="Prompt passed to claude -p"
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </div>
  );
}

import { useId, type JSX } from 'react';

export function PromptField(props: {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}): JSX.Element {
  const id = useId();
  return (
    <div className="prompt-field">
      <div className="row">
        <label htmlFor={id}>Prompt</label>
      </div>
      <textarea
        id={id}
        placeholder="Prompt passed to claude -p"
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </div>
  );
}

import { useRef, useState, type ChangeEvent, type JSX } from 'react';
import { FilePickerModal } from './FilePickerModal.js';
import { Hint } from './Hint.js';

export function VariantEditor(props: {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const onUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    props.onChange(text);
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div className="variant-editor">
      <div className="row">
        <label>Variant</label>
        <span className="upload">
          <Hint content="Pick an existing file from this project — typically your current CLAUDE.md, a .claude/skills/<name>/SKILL.md, or .claude/agents/<name>.md.">
            <button type="button" disabled={props.disabled} onClick={() => setPickerOpen(true)}>
              Browse project…
            </button>
          </Hint>
          <Hint content="Pick a file from anywhere on your computer (outside this project) — e.g. a draft on your Desktop or a file from another repo.">
            <button
              type="button"
              disabled={props.disabled}
              onClick={() => inputRef.current?.click()}
            >
              Upload…
            </button>
          </Hint>
          <input
            ref={inputRef}
            type="file"
            style={{ display: 'none' }}
            onChange={onUpload}
            accept=".md,.txt"
          />
        </span>
      </div>
      <textarea
        placeholder="Paste variant content (CLAUDE.md, SKILL.md, or agent .md)"
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
      />
      <FilePickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={(_path, content) => props.onChange(content)}
      />
    </div>
  );
}

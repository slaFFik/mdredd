import { useRef, useState } from 'react';
import { FilePickerModal } from './FilePickerModal.js';

export function VariantEditor(props: {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
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
          <button type="button" disabled={props.disabled} onClick={() => setPickerOpen(true)}>
            Browse project…
          </button>
          <button type="button" disabled={props.disabled} onClick={() => inputRef.current?.click()}>
            Upload…
          </button>
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

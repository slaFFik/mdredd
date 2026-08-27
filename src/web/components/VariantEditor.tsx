import { useId, useRef, useState, type ChangeEvent, type JSX } from 'react';
import { CollapseToggle } from './CollapseToggle.js';
import { FilePickerModal } from './FilePickerModal.js';
import { Hint } from './Hint.js';
import { MarkdownToggle } from './MarkdownToggle.js';
import { MarkdownView } from './MarkdownView.js';

export function VariantEditor(props: {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaId = useId();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [rendered, setRendered] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const onUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    props.onChange(text);
    if (inputRef.current) inputRef.current.value = '';
  };

  const hasContent = props.value.trim().length > 0;
  const alwaysVisible = rendered || collapsed;
  const hostClass = `md-host${collapsed ? ' collapsed' : ''}`;

  return (
    <div className="variant-editor">
      <div className="row">
        <label htmlFor={textareaId}>Variant</label>
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
            aria-label="Upload variant file"
            style={{ display: 'none' }}
            onChange={onUpload}
            accept=".md,.txt"
          />
        </span>
      </div>
      <div className={hostClass}>
        {collapsed && hasContent ? (
          <div className="variant-collapsed">{previewLine(props.value)}</div>
        ) : rendered ? (
          <MarkdownView content={props.value} className="variant-rendered" />
        ) : (
          <textarea
            id={textareaId}
            placeholder="Paste variant content (CLAUDE.md, SKILL.md, or agent .md)"
            value={props.value}
            disabled={props.disabled}
            onChange={(e) => props.onChange(e.target.value)}
          />
        )}
        {hasContent && (
          <div className={`toolbar-toggles${alwaysVisible ? ' always-visible' : ''}`}>
            <MarkdownToggle rendered={rendered} onToggle={() => setRendered((v) => !v)} />
            <CollapseToggle collapsed={collapsed} onToggle={() => setCollapsed((v) => !v)} />
          </div>
        )}
      </div>
      <FilePickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={(_path, content) => props.onChange(content)}
      />
    </div>
  );
}

function previewLine(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return `${flat.slice(0, 80)} …`;
}

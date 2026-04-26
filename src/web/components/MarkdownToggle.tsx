import type { JSX } from 'react';
import { Hint } from './Hint.js';

export function MarkdownToggle(props: { rendered: boolean; onToggle: () => void }): JSX.Element {
  return (
    <Hint content={props.rendered ? 'Switch to raw view' : 'Preview rendered markdown'}>
      <button
        type="button"
        className={`md-toggle${props.rendered ? ' rendered' : ''}`}
        onClick={props.onToggle}
        aria-label={props.rendered ? 'Switch to raw view' : 'Preview rendered markdown'}
      >
        {props.rendered ? <CodeIcon /> : <EyeIcon />}
      </button>
    </Hint>
  );
}

function EyeIcon(): JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function CodeIcon(): JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}

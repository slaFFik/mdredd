import type { JSX } from 'react';
import { ToolbarIconButton } from './ToolbarIconButton.js';

export function CollapseToggle(props: { collapsed: boolean; onToggle: () => void }): JSX.Element {
  const label = props.collapsed ? 'Expand' : 'Collapse';
  return (
    <ToolbarIconButton
      icon={props.collapsed ? <ChevronDownIcon /> : <ChevronUpIcon />}
      ariaLabel={label}
      title={label}
      onClick={props.onToggle}
    />
  );
}

function ChevronUpIcon(): JSX.Element {
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
      <polyline points="18 15 12 9 6 15" />
    </svg>
  );
}

function ChevronDownIcon(): JSX.Element {
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
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

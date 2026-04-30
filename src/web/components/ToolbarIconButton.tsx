import type { JSX, ReactNode } from 'react';
import { Hint } from './Hint.js';

export function ToolbarIconButton(props: {
  icon: ReactNode;
  ariaLabel: string;
  title: ReactNode;
  onClick: () => void;
  className?: string;
}): JSX.Element {
  const cls = props.className ? `toolbar-icon-button ${props.className}` : 'toolbar-icon-button';
  return (
    <Hint content={props.title}>
      <button type="button" className={cls} onClick={props.onClick} aria-label={props.ariaLabel}>
        {props.icon}
      </button>
    </Hint>
  );
}

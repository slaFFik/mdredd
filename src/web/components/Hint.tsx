import * as Tooltip from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';

export function Hint(props: {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
}): JSX.Element {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{props.children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          className="hint"
          side={props.side ?? 'top'}
          align={props.align ?? 'center'}
          sideOffset={6}
          collisionPadding={8}
        >
          {props.content}
          <Tooltip.Arrow className="hint-arrow" width={10} height={5} />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

import type { ReactNode } from 'react';
import { cn } from './cn';

/**
 * A keycap: the visible half of a keyboard shortcut. 20 px tall, mono, in the
 * langfuse button-key idiom. `aria-hidden` by default because the control it
 * sits in already carries `aria-keyshortcuts`.
 */
export function Keycap({ children, className, invert }: { children: ReactNode; className?: string; invert?: boolean }) {
  return (
    <kbd
      aria-hidden
      className={cn(
        'inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-[1px] border px-1',
        'font-mono text-[10px] font-medium leading-none not-italic tracking-[-0.2px]',
        invert
          ? 'border-white/25 bg-white/15 text-text-on-primary'
          : 'border-line-key bg-surface-key text-text-tertiary',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

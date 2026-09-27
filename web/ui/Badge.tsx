import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

export type Tone = 'neutral' | 'success' | 'warning' | 'error' | 'info';

const tones: Record<Tone, string> = {
  neutral: 'border-line-structure bg-surface-bg text-text-secondary',
  success: 'border-tone-success/50 bg-surface-bg text-tone-success',
  warning: 'border-tone-warning/50 bg-surface-bg text-tone-warning',
  error:   'border-tone-error/50 bg-surface-bg text-tone-error',
  info:    'border-tone-info/60 bg-surface-bg text-text-secondary',
};

/**
 * A small bordered label. `neutral` is the only tone the deck uses — evidence
 * about a lead is stated, never coloured. The other tones are for the control
 * panel's run state.
 */
export function Badge({ tone = 'neutral', filled, className, children, ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone; filled?: boolean; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex h-[18px] items-center gap-1 whitespace-nowrap rounded-[1px] border px-1.5',
        'text-[11px] font-[450] leading-none tracking-[-0.06px]',
        tones[tone],
        filled && 'bg-surface-2',
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
}

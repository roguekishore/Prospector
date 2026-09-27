import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

/** A filter toggle. `aria-pressed` carries the state; pressed is the inverted fill. */
export function Chip({ pressed, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { pressed: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      className={cn(
        'inline-flex h-[26px] items-center gap-1.5 rounded-ctl border px-2 whitespace-nowrap cursor-pointer',
        'text-label font-[450] tracking-[-0.06px] leading-none transition-colors',
        'border-line-structure bg-surface-bg text-text-secondary hover:border-line-cta hover:text-text-primary',
        'aria-pressed:border-text-primary aria-pressed:bg-text-primary aria-pressed:text-text-on-primary',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-line-cta',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

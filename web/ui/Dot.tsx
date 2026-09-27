import { cn } from './cn';

/** A status dot: `off` grey, `live` green, `run` pulsing. */
export function Dot({ state, className, label }: { state: 'off' | 'live' | 'run' | 'error'; className?: string; label?: string }) {
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        state === 'off' && 'bg-text-disabled',
        state === 'live' && 'bg-tone-success shadow-[0_0_0_3px_color-mix(in_srgb,var(--tone-success)_25%,transparent)]',
        state === 'run' && 'bg-tone-info animate-[pulse-dot_1.4s_ease-in-out_infinite] motion-reduce:animate-none',
        state === 'error' && 'bg-tone-error',
        className,
      )}
    />
  );
}

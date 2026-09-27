import type { ReactNode } from 'react';
import { cn } from './cn';
import { Button } from './Button';

/** A quiet "nothing here" for a list. */
export function Empty({ title = 'Nothing here.', hint, action, className }: { title?: ReactNode; hint?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('stripes flex flex-col items-center justify-center gap-2 border border-dashed border-line-divider-dash px-6 py-12 text-center', className)}>
      <p className="text-body-m text-text-secondary">{title}</p>
      {hint && <p className="max-w-md text-body-s text-text-tertiary">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** A failed fetch: the message, and a way to try again. */
export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className={cn('corner-box flex flex-col items-start gap-3 border border-tone-error/50 bg-surface-bg p-4', className)}>
      <p className="text-body-s text-text-primary"><span className="font-medium text-tone-error">Could not load.</span> {message}</p>
      {onRetry && <Button variant="secondary" size="sm" onClick={onRetry}>Try again</Button>}
    </div>
  );
}

/** An indeterminate spinner with an accessible label. */
export function Spinner({ label = 'Loading', className }: { label?: string; className?: string }) {
  return (
    <span role="status" aria-label={label} className={cn('inline-flex items-center gap-2 text-text-tertiary', className)}>
      <span aria-hidden className="size-3.5 animate-spin rounded-full border-[1.5px] border-line-structure border-t-text-secondary motion-reduce:animate-none" />
      <span className="text-label">{label}…</span>
    </span>
  );
}

/** A striped placeholder block, sized by the caller. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('stripes animate-pulse motion-reduce:animate-none border border-line-structure/60', className)} />;
}

import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

/**
 * A langfuse box: 1 px border on `surface-bg` with the four 8×8 corner
 * brackets. `title` renders a 15 px serif heading row with optional actions.
 */
export function Panel({ title, actions, pad = true, className, children, as: Tag = 'section', ...rest }: HTMLAttributes<HTMLElement> & {
  title?: ReactNode; actions?: ReactNode; pad?: boolean; children?: ReactNode; as?: 'section' | 'div' | 'article' | 'aside';
}) {
  return (
    <Tag className={cn('corner-box border border-line-structure bg-surface-bg', className)} {...rest}>
      {(title || actions) && (
        <header className={cn('flex min-h-10 items-center justify-between gap-3 border-b border-line-structure px-4')}>
          {title && <h2 className="truncate font-serif text-[15px] font-medium leading-tight text-text-primary">{title}</h2>}
          {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        </header>
      )}
      <div className={cn(pad && 'p-4')}>{children}</div>
    </Tag>
  );
}

import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from './cn';
import { Keycap } from './Keycap';

export interface TabItem<V extends string> { value: V; label: ReactNode; count?: number | string; keycap?: string }

/**
 * A tab list (`role=tablist`), 26 px triggers, arrow keys move between tabs.
 * Controlled: the parent owns `value`. Panels are the parent's business; pass
 * `panelId` so `aria-controls` can point at the one shown.
 */
export function Tabs<V extends string>({ value, onChange, items, ariaLabel, panelId, className, size = 'sm' }: {
  value: V; onChange: (v: V) => void; items: TabItem<V>[]; ariaLabel: string; panelId?: string; className?: string; size?: 'sm' | 'lg';
}) {
  const ref = useRef<HTMLDivElement>(null);

  function onKey(ev: KeyboardEvent<HTMLDivElement>) {
    const i = items.findIndex((t) => t.value === value);
    let next = -1;
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') next = (i + 1) % items.length;
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') next = (i - 1 + items.length) % items.length;
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = items.length - 1;
    if (next < 0) return;
    ev.preventDefault();
    const item = items[next]!;
    onChange(item.value);
    const btn = ref.current?.querySelectorAll<HTMLButtonElement>('[role=tab]')[next];
    btn?.focus();
  }

  return (
    <div
      ref={ref}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKey}
      className={cn('inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-tab border border-line-structure bg-surface-bg p-0.5', className)}
    >
      {items.map((t) => {
        const on = t.value === value;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={on}
            aria-controls={on ? panelId : undefined}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(t.value)}
            aria-keyshortcuts={t.keycap}
            className={cn(
              'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-tab border border-transparent whitespace-nowrap',
              'text-label font-[450] tracking-[-0.06px] text-text-secondary transition-colors cursor-pointer',
              'hover:bg-surface-button-grey/60 hover:text-text-primary',
              'aria-selected:border-line-structure aria-selected:bg-surface-button-grey aria-selected:text-text-primary',
              'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-line-cta',
              size === 'lg' ? 'h-9 px-3 text-body-s' : 'h-[26px] px-2',
            )}
          >
            {t.label}
            {t.count !== undefined && <span className="font-mono text-[10px] text-text-tertiary tnum">{t.count}</span>}
            {t.keycap && <Keycap>{t.keycap}</Keycap>}
          </button>
        );
      })}
    </div>
  );
}

import { useRef, type KeyboardEvent } from 'react';
import { cn } from './cn';

export type Tier = 'A' | 'B' | 'C' | 'X';
export const TIERS: Tier[] = ['A', 'B', 'C', 'X'];

/**
 * The operator's tier, as a radio group of four buttons. Pressing the checked
 * one clears it — a four-way radio a misclick could never undo would be a trap.
 * Roving tabindex: Tab lands on the checked (or first) button, arrows move.
 *
 * The letter is the shortcut (A/B/C/X, or 1–4), which is why there is no
 * separate keycap: the label is the hint.
 */
export function TierGroup({ value, onChange, label, size = 'md', disabled, className }: {
  value: Tier | null; onChange: (next: Tier | null) => void; label: string; size?: 'sm' | 'md' | 'lg'; disabled?: boolean; className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const focusIndex = TIERS.indexOf((value ?? 'A') as Tier);

  function onKey(ev: KeyboardEvent<HTMLDivElement>) {
    const btns = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role=radio]') ?? [])];
    const i = btns.findIndex((b) => b === document.activeElement);
    if (i < 0) return;
    let next = -1;
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') next = (i + 1) % btns.length;
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') next = (i - 1 + btns.length) % btns.length;
    if (next < 0) return;
    ev.preventDefault();
    btns[next]?.focus();
  }

  const h = size === 'lg' ? 'h-11 min-w-11 text-[15px]' : size === 'md' ? 'h-8 min-w-9 text-[13px]' : 'h-[26px] min-w-7 text-[12px]';

  return (
    <div ref={ref} role="radiogroup" aria-label={label} onKeyDown={onKey} className={cn('inline-flex gap-1', className)}>
      {TIERS.map((t, i) => {
        const on = value === t;
        return (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={`Tier ${t}`}
            title={on ? `Tier ${t} — press again to clear (${t} or ${i + 1})` : `Tier ${t} (${t} or ${i + 1})`}
            tabIndex={i === focusIndex ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(on ? null : t)}
            className={cn(
              'inline-flex items-center justify-center rounded-ctl border px-2 font-mono font-medium leading-none cursor-pointer',
              'border-line-structure bg-surface-bg text-text-secondary transition-colors hover:border-line-cta hover:text-text-primary',
              'aria-checked:border-text-primary aria-checked:bg-text-primary aria-checked:text-text-on-primary',
              'disabled:opacity-50 disabled:pointer-events-none',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-line-cta',
              h,
            )}
          >
            {t}
          </button>
        );
      })}
    </div>
  );
}

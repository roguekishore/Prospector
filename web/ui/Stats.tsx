import type { ReactNode } from 'react';
import { cn } from './cn';
import type { Tone } from './Badge';
import { num } from './format';

/** A number and what it counts. Mono, tabular, so a column of them lines up. */
export function StatTile({ value, label, hint, tone = 'neutral', className, size = 'md' }: {
  value: number | string | null | undefined; label: ReactNode; hint?: ReactNode; tone?: Tone; className?: string; size?: 'sm' | 'md' | 'lg';
}) {
  const toneCls: Record<Tone, string> = {
    neutral: 'text-text-primary', success: 'text-tone-success', warning: 'text-tone-warning', error: 'text-tone-error', info: 'text-text-primary',
  };
  return (
    <div className={cn('flex min-w-0 flex-col gap-0.5', className)}>
      <span className={cn('font-mono font-medium leading-none tnum', toneCls[tone],
        size === 'lg' ? 'text-[28px]' : size === 'md' ? 'text-[22px]' : 'text-[17px]')}>
        {typeof value === 'number' ? num(value) : (value ?? '—')}
      </span>
      <span className="truncate text-[11px] font-[450] uppercase tracking-[0.06em] text-text-tertiary">{label}</span>
      {hint && <span className="text-[11px] text-text-tertiary">{hint}</span>}
    </div>
  );
}

export interface BarSegment { value: number; tone: Tone | 'muted'; label: string }

/**
 * A stacked proportion bar, 6 px tall. Each segment gets its share of `total`;
 * whatever is left is the track. An `aria-label` spells the numbers out.
 */
export function StackedBar({ segments, total, className, height = 'h-1.5' }: { segments: BarSegment[]; total: number; className?: string; height?: string }) {
  const fill: Record<Tone | 'muted', string> = {
    neutral: 'bg-text-primary', success: 'bg-tone-success', warning: 'bg-tone-warning', error: 'bg-tone-error', info: 'bg-tone-info', muted: 'bg-line-structure',
  };
  const denom = Math.max(1, total);
  const label = segments.map((s) => `${s.label} ${num(s.value)}`).join(', ') + ` of ${num(total)}`;
  return (
    <div role="img" aria-label={label} className={cn('flex w-full overflow-hidden rounded-[1px] bg-surface-2', height, className)}>
      {segments.map((s) => (
        <span key={s.label} className={cn('block h-full transition-[width] duration-300', fill[s.tone])} style={{ width: `${(100 * s.value) / denom}%` }} />
      ))}
    </div>
  );
}

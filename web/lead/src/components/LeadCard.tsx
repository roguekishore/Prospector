import { Check, Pin, Star } from 'lucide-react';
import { Badge } from '@ui/Badge';
import { cn } from '@ui/cn';
import { num } from '@ui/format';
import type { Row } from '../api';
import { Shot } from './Shot';

/** The evidence badges. Neutral on purpose: these are facts, not a verdict. */
export function evidence(r: Row): string[] {
  const out: string[] = [];
  if (r.https_status === 'none') out.push('HTTP only');
  if (r.https_status === 'expired') out.push('Cert expired');
  if (r.email) out.push('Has email');
  return out;
}

/** One lead in the grid: the mobile shot, who it is, and what the operator said. */
export function LeadCard({ row, href, current }: { row: Row; href: string; current?: boolean }) {
  const badges = evidence(row);
  return (
    <a
      href={href}
      data-active={current || undefined}
      aria-current={current ? 'true' : undefined}
      className={cn(
        'corner-box-hover group flex flex-col border border-line-structure bg-surface-bg outline-none transition-colors',
        'hover:border-line-cta focus-visible:border-line-cta',
        row.reviewed_at && 'bg-surface-1/60',
      )}
    >
      <div className="relative aspect-[4/5] overflow-hidden border-b border-line-structure bg-surface-2">
        <Shot domain={row.domain} kind="mobile" name={row.name} className="absolute inset-0 h-full w-full object-cover object-top" />
        {row.pitch && (
          <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-1 bg-text-primary px-1.5 py-0.5 text-[10px] font-medium leading-none text-text-on-primary" title="Marked for a pitch">
            <Pin aria-hidden className="size-2.5" /> pitch
          </span>
        )}
        {row.tier && (
          <span className="absolute right-1.5 top-1.5 grid size-6 place-items-center bg-text-primary font-mono text-[12px] font-medium leading-none text-text-on-primary" aria-label={`Tier ${row.tier}`}>
            {row.tier}
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-1 p-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate font-mono text-[11px] text-text-tertiary">{row.domain ?? '—'}</span>
          {row.reviewed_at && <Check aria-label="Reviewed" className="size-3.5 shrink-0 text-text-tertiary" />}
        </div>
        <span className="line-clamp-2 text-body-s font-medium leading-snug text-text-primary">{row.name}</span>
        <span className="font-mono text-[11px] text-text-tertiary tnum">
          {num(row.review_count)} reviews
          {row.rating !== null && <> · {row.rating}<Star aria-hidden className="-mt-0.5 ml-0.5 inline size-2.5 fill-current" /></>}
        </span>
        {badges.length > 0 && (
          <div className="mt-0.5 flex flex-wrap gap-1">
            {badges.map((b) => <Badge key={b}>{b}</Badge>)}
          </div>
        )}
      </div>
    </a>
  );
}

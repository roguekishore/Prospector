import type { ReactNode } from 'react';
import { Download, Keyboard } from 'lucide-react';
import { Button } from '@ui/Button';
import { cn } from '@ui/cn';
import { PITCH_CSV } from '../api';
import { hrefOverview } from '../routes';

export interface Crumb { label: string; href?: string }

/**
 * The bar every view shares: a wordmark, the breadcrumb, the pitch CSV and the
 * keyboard help. Sticky, so the way back is always one click up.
 */
export function TopBar({ crumbs, children, onHelp }: { crumbs: Crumb[]; children?: ReactNode; onHelp: () => void }) {
  return (
    <header className="sticky top-0 z-30 border-b border-line-structure bg-surface-bg/95 backdrop-blur-sm">
      <div className="mx-auto flex h-12 max-w-[1600px] items-center gap-3 px-4 sm:px-6">
        <a href={hrefOverview()} className="flex shrink-0 items-center gap-2 rounded-ctl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-line-cta" aria-label="Leads — all verticals">
          <span aria-hidden className="grid size-6 place-items-center bg-text-primary font-serif text-[13px] font-medium leading-none text-surface-cta-primary">L</span>
          <span className="hidden font-serif text-[15px] font-medium text-text-primary sm:inline">Leads</span>
        </a>
        <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
          <ol className="flex min-w-0 items-center gap-1.5 text-body-s text-text-tertiary">
            {crumbs.map((c, i) => {
              const last = i === crumbs.length - 1;
              return (
                <li key={`${c.label}-${i}`} className={cn('flex min-w-0 items-center gap-1.5', last && 'min-w-0 flex-1')}>
                  {i > 0 && <span aria-hidden className="text-text-disabled">/</span>}
                  {c.href && !last
                    ? <a href={c.href} className="truncate hover:text-text-primary">{c.label}</a>
                    : <span aria-current={last ? 'page' : undefined} className={cn('truncate', last && 'text-text-primary')}>{c.label}</span>}
                </li>
              );
            })}
          </ol>
        </nav>
        <div className="flex shrink-0 items-center gap-1.5">
          {children}
          <Button href={PITCH_CSV} download="pitch.csv" variant="secondary" size="sm" icon={<Download />} aria-label="Download the pitch list as CSV">
            <span className="hidden sm:inline">Pitch CSV</span>
          </Button>
          <Button variant="text" size="sm" onClick={onHelp} icon={<Keyboard />} keycap="?" aria-label="Keyboard shortcuts">
            <span className="hidden md:inline">Keys</span>
          </Button>
        </div>
      </div>
    </header>
  );
}

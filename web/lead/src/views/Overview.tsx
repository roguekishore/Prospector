import { useEffect } from 'react';
import { ArrowRight, RotateCcw } from 'lucide-react';
import { Button } from '@ui/Button';
import { num, pct } from '@ui/format';
import { Empty, ErrorState, Skeleton, StatTile, StackedBar } from '@ui/index';
import type { Vertical } from '../api';
import { loadVerticals, verticals } from '../data';
import { hrefVertical, lastVertical } from '../routes';
import { TopBar } from '../components/TopBar';

/** Every vertical, with how far the review has got. The front door. */
export function Overview({ onHelp }: { onHelp: () => void }) {
  const state = verticals.useValue();
  useEffect(() => { void loadVerticals(true); document.title = 'Leads'; }, []);

  const totals = state.items.reduce(
    (a, v) => ({ leads: a.leads + v.leads, no_website: a.no_website + v.no_website, reviewed: a.reviewed + v.reviewed, pitch: a.pitch + v.pitch }),
    { leads: 0, no_website: 0, reviewed: 0, pitch: 0 },
  );
  const last = lastVertical();
  const resume = last ? state.items.find((v) => v.slug === last) : undefined;

  return (
    <>
      <TopBar crumbs={[{ label: 'Verticals' }]} onHelp={onHelp} />
      <main className="mx-auto flex max-w-[1600px] flex-col gap-6 px-4 py-6 sm:px-6">
        <section aria-label="Totals" className="corner-box grid grid-cols-2 gap-x-4 gap-y-5 border border-line-structure bg-surface-bg p-4 sm:grid-cols-4 sm:p-5">
          <StatTile value={totals.leads} label="leads" size="lg" />
          <StatTile value={totals.reviewed} label="reviewed" hint={totals.leads ? `${pct(totals.reviewed, totals.leads)} of leads` : undefined} size="lg" />
          <StatTile value={totals.pitch} label="pitch" size="lg" />
          <StatTile value={totals.no_website} label="no website" size="lg" />
        </section>

        {resume && (
          <div className="flex flex-wrap items-center gap-3 text-body-s text-text-tertiary">
            <span>You were reviewing <span className="text-text-primary">{resume.label}</span>.</span>
            <Button href={hrefVertical({ slug: resume.slug, tab: 'leads', filters: ['unreviewed'] })} variant="cta" size="sm" iconEnd={<ArrowRight />}>
              Continue with the unreviewed
            </Button>
          </div>
        )}

        {state.status === 'error' && <ErrorState error={state.error} onRetry={() => void loadVerticals(true)} />}

        {state.status === 'loading' && state.items.length === 0 && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-40" />)}
          </div>
        )}

        {state.status === 'ready' && state.items.length === 0 && (
          <Empty title="No verticals yet." hint="Add one in the control panel, then run discover." />
        )}

        {state.items.length > 0 && (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-label="Verticals">
            {state.items.map((v) => <li key={v.slug}><VerticalCard v={v} /></li>)}
          </ul>
        )}

        {state.status === 'ready' && (
          <div className="flex justify-end">
            <Button variant="text" size="sm" icon={<RotateCcw />} onClick={() => void loadVerticals(true)}>Refresh counts</Button>
          </div>
        )}
      </main>
    </>
  );
}

function VerticalCard({ v }: { v: Vertical }) {
  const href = hrefVertical({ slug: v.slug, tab: 'leads', filters: [] });
  return (
    <a
      href={href}
      className="corner-box-hover stripes-hover group flex h-full flex-col gap-4 border border-line-structure bg-surface-bg p-4 outline-none transition-colors hover:border-line-cta focus-visible:border-line-cta"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate font-serif text-[19px] font-medium leading-tight text-text-primary">{v.label}</h2>
          <p className="truncate font-mono text-[11px] text-text-tertiary">{v.slug}</p>
        </div>
        <ArrowRight aria-hidden className="mt-1 size-4 shrink-0 text-text-disabled transition-colors group-hover:text-text-primary" />
      </div>
      <dl className="grid grid-cols-4 gap-2">
        {([['leads', v.leads], ['reviewed', v.reviewed], ['pitch', v.pitch], ['no site', v.no_website]] as const).map(([k, n]) => (
          <div key={k} className="min-w-0">
            <dd className="font-mono text-[17px] font-medium leading-none text-text-primary tnum">{num(n)}</dd>
            <dt className="mt-1 truncate text-[10px] uppercase tracking-[0.06em] text-text-tertiary">{k}</dt>
          </div>
        ))}
      </dl>
      <div className="mt-auto flex flex-col gap-1.5">
        <StackedBar total={Math.max(v.leads, 1)} segments={[{ value: v.reviewed, tone: 'neutral', label: 'reviewed' }]} />
        <span className="text-[11px] text-text-tertiary">
          {v.leads ? `${pct(v.reviewed, v.leads)} reviewed` : 'nothing captured yet'}
        </span>
      </div>
    </a>
  );
}

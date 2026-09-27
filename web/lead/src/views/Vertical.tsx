import { useEffect, useMemo, useRef } from 'react';
import { ChevronDown, Star, X } from 'lucide-react';
import { Button, Chip, Empty, ErrorState, Skeleton, Spinner, Tabs } from '@ui/index';
import { num } from '@ui/format';
import { FILTERS, normaliseFilters, type Row, type Tab } from '../api';
import { ensureList, isDone, loadMore, loadVerticals, reloadList, useList, verticals } from '../data';
import { go, hrefLead, hrefOverview, hrefVertical, listKey, rememberVertical, type ListCtx } from '../routes';
import { LeadCard } from '../components/LeadCard';
import { TierPitch } from '../components/Decision';
import { TopBar } from '../components/TopBar';

/** One vertical: the tabs, the filter chips, and a page of rows at a time. */
export function VerticalView({ ctx, onHelp }: { ctx: ListCtx; onHelp: () => void }) {
  const key = listKey(ctx);
  const list = useList(ctx);
  const vs = verticals.useValue();
  const vertical = vs.items.find((v) => v.slug === ctx.slug);

  useEffect(() => { void loadVerticals(); }, []);
  useEffect(() => { void ensureList(ctx); rememberVertical(ctx.slug); /* eslint-disable-line */ }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { document.title = `${vertical?.label ?? ctx.slug} — Leads`; }, [vertical?.label, ctx.slug]);

  function setTab(tab: Tab) { go(hrefVertical({ ...ctx, tab })); }
  function toggleFilter(k: string) {
    const set = new Set(ctx.filters);
    if (set.has(k)) set.delete(k); else set.add(k);
    go(hrefVertical({ ...ctx, filters: normaliseFilters(set) }));
  }

  const groups = useMemo(() => ({
    site:   FILTERS.filter((f) => f[2] === 'site'),
    review: FILTERS.filter((f) => f[2] === 'review'),
    tier:   FILTERS.filter((f) => f[2] === 'tier'),
  }), []);

  const label = vertical?.label ?? ctx.slug;
  const showing = list.rows.length;
  const total = list.total;

  return (
    <>
      <TopBar crumbs={[{ label: 'Verticals', href: hrefOverview() }, { label }]} onHelp={onHelp} />
      <main className="mx-auto flex max-w-[1600px] flex-col gap-4 px-4 py-5 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-[26px] leading-tight sm:text-[32px]">{label}</h1>
          </div>
          <Tabs
            ariaLabel="Which rows"
            value={ctx.tab}
            onChange={setTab}
            panelId="rows"
            items={[
              { value: 'leads', label: 'Leads', count: vertical ? num(vertical.leads) : undefined },
              { value: 'no-website', label: 'No website', count: vertical ? num(vertical.no_website) : undefined },
            ]}
          />
        </div>

        <div role="group" aria-label="Filters — every pressed chip must match" className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <ChipGroup label="Site" items={groups.site} active={ctx.filters} onToggle={toggleFilter} />
          <ChipGroup label="Review" items={groups.review} active={ctx.filters} onToggle={toggleFilter} />
          <ChipGroup label="Tier" items={groups.tier} active={ctx.filters} onToggle={toggleFilter} mono />
          {ctx.filters.length > 0 && (
            <Button variant="text" size="sm" icon={<X />} onClick={() => go(hrefVertical({ ...ctx, filters: [] }))}>Clear</Button>
          )}
          <span className="ml-auto font-mono text-[11px] text-text-tertiary tnum" aria-live="polite">
            {total === null ? '' : `${num(showing)} of ${num(total)}`}
          </span>
        </div>

        <section id="rows" role="tabpanel" aria-label={ctx.tab === 'leads' ? 'Leads' : 'Rows with no website'} className="flex flex-col gap-4">
          {list.status === 'error' && <ErrorState error={list.error} onRetry={() => void reloadList(ctx)} />}

          {list.status === 'loading' && list.rows.length === 0 && (
            ctx.tab === 'leads'
              ? <div className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-3">{Array.from({ length: 12 }, (_, i) => <Skeleton key={i} className="aspect-[4/6]" />)}</div>
              : <Skeleton className="h-64" />
          )}

          {list.status === 'ready' && list.rows.length === 0 && (
            <Empty
              title={ctx.filters.length ? 'Nothing matches these filters.' : ctx.tab === 'leads' ? 'No leads captured yet.' : 'Every listing here has a website.'}
              hint={ctx.filters.length ? 'Every pressed chip must match. Clear one or two.' : undefined}
              action={ctx.filters.length ? <Button variant="secondary" size="sm" onClick={() => go(hrefVertical({ ...ctx, filters: [] }))}>Clear filters</Button> : undefined}
            />
          )}

          {list.rows.length > 0 && (ctx.tab === 'leads'
            ? <ul className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-3 sm:grid-cols-[repeat(auto-fill,minmax(196px,1fr))]" aria-label="Leads">
                {list.rows.map((r) => <li key={r.company_id}><LeadCard row={r} href={hrefLead(r.company_id, ctx)} /></li>)}
              </ul>
            : <NoWebsiteTable rows={list.rows} ctx={ctx} />
          )}

          <LoadMore ctx={ctx} showing={showing} total={total} loading={list.status === 'loading'} done={isDone(list)} />
        </section>
      </main>
    </>
  );
}

function ChipGroup({ label, items, active, onToggle, mono }: {
  label: string; items: ReadonlyArray<readonly [string, string, string]>; active: string[]; onToggle: (k: string) => void; mono?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5" role="group" aria-label={label}>
      <span className="mr-0.5 text-[11px] uppercase tracking-[0.06em] text-text-tertiary">{label}</span>
      {items.map(([k, text]) => (
        <Chip key={k} pressed={active.includes(k)} onClick={() => onToggle(k)} className={mono ? 'min-w-7 justify-center px-1.5 font-mono' : undefined}>
          {text}
        </Chip>
      ))}
    </div>
  );
}

/**
 * "Load more", plus a sentinel that loads the next page as the button scrolls
 * into view — so a long review session never has to click, but the click is
 * always there.
 */
function LoadMore({ ctx, showing, total, loading, done }: { ctx: ListCtx; showing: number; total: number | null; loading: boolean; done: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || done || total === null) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void loadMore(ctx);
    }, { rootMargin: '400px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [ctx, done, total, showing]);

  if (total === null || showing === 0) return null;
  return (
    <div ref={ref} className="flex flex-col items-center gap-2 py-4">
      {done
        ? <span className="text-label text-text-tertiary">All {num(total)} shown</span>
        : loading
          ? <Spinner label={`Loading ${num(showing + 1)}–${num(Math.min(total, showing + 60))}`} />
          : <Button variant="secondary" size="md" iconEnd={<ChevronDown />} onClick={() => void loadMore(ctx)}>Load more · {num(showing)} of {num(total)}</Button>}
    </div>
  );
}

/** Rows with `domain IS NULL`: no site to show, so a table, with the same decision controls. */
function NoWebsiteTable({ rows, ctx }: { rows: Row[]; ctx: ListCtx }) {
  return (
    <>
      {/* Phones: one stacked card per row, nothing scrolls sideways. */}
      <ul className="flex flex-col gap-2 md:hidden" aria-label="Rows with no website">
        {rows.map((r) => (
          <li key={r.company_id} className="corner-box flex flex-col gap-2.5 border border-line-structure bg-surface-bg p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <a href={hrefLead(r.company_id, ctx)} className="block truncate text-body-m font-medium text-text-primary hover:underline">{r.name}</a>
                <div className="truncate text-[12px] text-text-tertiary">{r.address ?? ''}</div>
              </div>
              <span className="shrink-0 font-mono text-[12px] tnum text-text-secondary">
                {num(r.review_count)} rev{r.rating !== null && <> · {r.rating}<Star aria-hidden className="-mt-0.5 ml-0.5 inline size-2.5 fill-current" /></>}
              </span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-[13px] tnum text-text-secondary">
                {r.phone ? <a href={`tel:${r.phone.replace(/\s+/g, '')}`} className="hover:underline">{r.phone}</a> : '—'}
              </span>
              <TierPitch row={r} size="md" />
            </div>
          </li>
        ))}
      </ul>
      <div className="corner-box hidden overflow-x-auto border border-line-structure bg-surface-bg md:block">
      <table className="w-full min-w-[640px] border-collapse text-body-s">
        <thead>
          <tr className="border-b border-line-structure text-left text-[11px] uppercase tracking-[0.06em] text-text-tertiary">
            <th scope="col" className="px-3 py-2.5 font-[450]">Business</th>
            <th scope="col" className="px-3 py-2.5 text-right font-[450]">Reviews</th>
            <th scope="col" className="hidden px-3 py-2.5 text-right font-[450] md:table-cell">Rating</th>
            <th scope="col" className="px-3 py-2.5 font-[450]">Phone</th>
            <th scope="col" className="hidden px-3 py-2.5 font-[450] lg:table-cell">Address</th>
            <th scope="col" className="px-3 py-2.5 font-[450]">Your call</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.company_id} className="border-b border-line-structure last:border-0 hover:bg-surface-1/60">
              <td className="px-3 py-2 align-top">
                <a href={hrefLead(r.company_id, ctx)} className="font-medium text-text-primary hover:underline">{r.name}</a>
                <div className="text-[12px] text-text-tertiary lg:hidden">{r.address ?? ''}</div>
                {r.reviewed_at && <div className="mt-0.5 font-mono text-[10px] text-text-tertiary">reviewed</div>}
              </td>
              <td className="px-3 py-2 text-right align-top font-mono tnum text-text-secondary">{num(r.review_count)}</td>
              <td className="hidden px-3 py-2 text-right align-top font-mono tnum text-text-secondary md:table-cell">
                {r.rating !== null ? <>{r.rating}<Star aria-hidden className="-mt-0.5 ml-0.5 inline size-2.5 fill-current" /></> : '—'}
              </td>
              <td className="px-3 py-2 align-top font-mono text-[13px] tnum text-text-secondary">
                {r.phone ? <a href={`tel:${r.phone.replace(/\s+/g, '')}`} className="hover:underline">{r.phone}</a> : '—'}
              </td>
              <td className="hidden max-w-[280px] truncate px-3 py-2 align-top text-text-tertiary lg:table-cell" title={r.address ?? undefined}>{r.address ?? '—'}</td>
              <td className="px-3 py-1.5 align-top"><TierPitch row={r} size="sm" /></td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </>
  );
}

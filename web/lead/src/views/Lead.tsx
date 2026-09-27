import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowRight, ExternalLink, Mail, Maximize2, Minimize2, Monitor, Phone, SkipForward, Smartphone, Star,
} from 'lucide-react';
import { Badge, Button, ErrorState, Panel, Skeleton, Tabs, useToast } from '@ui/index';
import { fmtDateTime, fmtDay, num } from '@ui/format';
import { isTyping, modalOpen, useDocumentEvent, useMediaQuery } from '@ui/hooks';
import { createStore } from '@ui/store';
import { TIERS, type Tier } from '@ui/TierGroup';
import { siteUrl, type Link, type Row } from '../api';
import { ensureList, findRow, loadLead, prefetchShots, saveDecision, useLead, useList } from '../data';
import { neighbour, nextUnreviewed, positionOf, prefetchAround, type StepResult } from '../deck';
import { go, hrefLead, hrefOverview, hrefVertical, listKey, parseHash, type ListCtx } from '../routes';
import { NoteField, TierPitch } from '../components/Decision';
import { evidence } from '../components/LeadCard';
import { Shot } from '../components/Shot';
import { TopBar } from '../components/TopBar';

type ShotKind = 'mobile' | 'desktop';
/** Which screenshot is up. Module-level so it survives stepping to the next lead. */
const shotMode = createStore<ShotKind>('mobile');

/** One lead: the shots, what Places and qualify know, the outside links, and the operator's call. */
export function LeadView({ id, ctx: routeCtx, onHelp }: { id: number; ctx: ListCtx | null; onHelp: () => void }) {
  const toast = useToast();
  const state = useLead(id);
  const lead = state.lead && state.lead.company_id === id ? state.lead : undefined;
  const row: Row | undefined = lead ?? findRow(id);

  // The list this lead is stepped through. From the URL when opened from a
  // grid; otherwise derived from the lead itself (its vertical, the tab its
  // domain implies, no filters) so a pasted `#/lead/123` can still step.
  const ctx = useMemo<ListCtx | null>(() => {
    // A context naming another vertical is stale (a hand-edited link, say);
    // the lead's own list is the honest one to step through.
    if (routeCtx && (!row || row.vertical === routeCtx.slug)) return routeCtx;
    if (!row) return null;
    return { slug: row.vertical, tab: row.domain ? 'leads' : 'no-website', filters: [] };
  }, [routeCtx, row]);
  const ctxKey = ctx ? listKey(ctx) : '';
  const list = useList(ctx ?? { slug: '-', tab: 'leads', filters: [] });

  useEffect(() => { void loadLead(id).catch(() => {}); }, [id]);
  useEffect(() => { if (ctx) void ensureList(ctx); }, [ctxKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (ctx) prefetchAround(ctx, id); }, [ctxKey, id, list.rows.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (row?.domain) prefetchShots(row.domain); }, [row?.domain]);
  useEffect(() => { document.title = row ? `${row.name} — Leads` : 'Lead — Leads'; }, [row?.name, row]);

  const mode = shotMode.useValue();
  const [zoom, setZoom] = useState<'fit' | 'actual'>('fit');
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const wide = useMediaQuery('(min-width: 1100px)');

  const pos = ctx ? positionOf(ctx, id) : null;
  const backHref = ctx ? hrefVertical(ctx) : hrefOverview();

  // The id the hash names right now. A key pressed in the few milliseconds
  // between a navigation and React's re-render would otherwise act on the lead
  // that was just left.
  const liveId = useCallback(() => { const r = parseHash(window.location.hash); return r.view === 'lead' ? r.id : id; }, [id]);

  const jump = useCallback((r: StepResult, what: 'next' | 'previous' | 'unreviewed') => {
    if (r === 'start') return toast('This is the first lead in the list.');
    if (r === 'end') return toast(what === 'unreviewed' ? 'No unreviewed lead after this one.' : 'This is the last lead in the list.');
    if (r === 'unknown') return toast('Open this lead from a list to step through it.');
    go(hrefLead(r.id, ctx));
  }, [ctx, toast]);

  const step = useCallback((dir: 1 | -1) => {
    if (!ctx) return toast('Open this lead from a list to step through it.');
    void neighbour(ctx, liveId(), dir).then((r) => jump(r, dir > 0 ? 'next' : 'previous')).catch((e: unknown) => toast(`Could not load the next page — ${e instanceof Error ? e.message : String(e)}`, { tone: 'error' }));
  }, [ctx, liveId, jump, toast]);

  const unreviewed = useCallback(() => {
    if (!ctx) return toast('Open this lead from a list to step through it.');
    void nextUnreviewed(ctx, liveId()).then((r) => jump(r, 'unreviewed')).catch((e: unknown) => toast(`Could not load the next page — ${e instanceof Error ? e.message : String(e)}`, { tone: 'error' }));
  }, [ctx, liveId, jump, toast]);

  const site = lead ? siteUrl(lead) : row?.domain ? `https://${row.domain}/` : null;
  const openSite = useCallback(() => {
    if (!site) return toast('No website to open.');
    window.open(site, '_blank', 'noopener,noreferrer');
  }, [site, toast]);

  const setTier = useCallback((t: Tier) => {
    if (!row) return;
    void saveDecision(id, { tier: row.tier === t ? null : t });
  }, [id, row]);

  // The keyboard. Nothing fires while typing, except Esc, which leaves the field.
  useDocumentEvent('keydown', useCallback((ev: KeyboardEvent) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (isTyping(ev.target)) {
      if (ev.key === 'Escape') (ev.target as HTMLElement).blur();
      return;
    }
    if (ev.defaultPrevented || modalOpen()) return;
    const k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
    switch (k) {
      case 'ArrowRight': case 'j': ev.preventDefault(); step(1); break;
      case 'ArrowLeft':  case 'k': ev.preventDefault(); step(-1); break;
      case 'u': ev.preventDefault(); unreviewed(); break;
      case 'a': case 'b': case 'c': case 'x': ev.preventDefault(); setTier(k.toUpperCase() as Tier); break;
      case '1': case '2': case '3': case '4': ev.preventDefault(); setTier(TIERS[Number(k) - 1]!); break;
      case 'p': ev.preventDefault(); if (row) void saveDecision(id, { pitch: !row.pitch }); break;
      case 'n': ev.preventDefault(); noteRef.current?.focus(); noteRef.current?.setSelectionRange(noteRef.current.value.length, noteRef.current.value.length); break;
      case 'd': ev.preventDefault(); shotMode.set('desktop'); break;
      case 'm': ev.preventDefault(); shotMode.set('mobile'); break;
      case 'o': ev.preventDefault(); openSite(); break;
      case 'Escape': ev.preventDefault(); go(backHref); break;
      default: return;
    }
  }, [step, unreviewed, setTier, row, id, openSite, backHref]));

  const crumbs = [
    { label: 'Verticals', href: hrefOverview() },
    { label: lead?.vertical_label ?? ctx?.slug ?? '…', href: ctx ? hrefVertical(ctx) : undefined },
    { label: row?.domain ?? row?.name ?? `#${id}` },
  ];

  if (state.status === 'error' && !row) {
    return (
      <>
        <TopBar crumbs={crumbs} onHelp={onHelp} />
        <main className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6">
          <ErrorState error={state.error} onRetry={() => void loadLead(id, true).catch(() => {})} />
          <div className="mt-4"><Button href={backHref} variant="text" icon={<ArrowLeft />} keycap="Esc">Back to the list</Button></div>
        </main>
      </>
    );
  }

  const badges = row ? evidence(row) : [];

  const deckBar = (
    <div className="flex flex-wrap items-center gap-2 border-b border-line-structure bg-surface-1 px-4 py-2 sm:px-6">
      <Button href={backHref} variant="text" size="sm" icon={<ArrowLeft />} keycap="Esc" aria-label="Back to the list"><span className="hidden sm:inline">List</span></Button>
      <div className="flex items-center gap-1">
        <Button variant="secondary" size="sm" icon={<ArrowLeft />} keycap="K" onClick={() => step(-1)} aria-label="Previous lead" disabled={!ctx} />
        <span className="min-w-[72px] px-1 text-center font-mono text-[11px] text-text-tertiary tnum" aria-live="polite">
          {pos ? `${num(pos.index + 1)} / ${pos.total === null ? '…' : num(pos.total)}` : '— / —'}
        </span>
        <Button variant="secondary" size="sm" iconEnd={<ArrowRight />} keycap="J" onClick={() => step(1)} aria-label="Next lead" disabled={!ctx} />
      </div>
      <Button variant="secondary" size="sm" icon={<SkipForward />} keycap="U" onClick={unreviewed} disabled={!ctx}><span className="hidden md:inline">Next unreviewed</span><span className="md:hidden">Unreviewed</span></Button>
      <span className="mx-1 hidden h-4 w-px bg-line-structure sm:inline-block" aria-hidden />
      <Tabs
        ariaLabel="Which screenshot"
        value={mode}
        onChange={(m) => shotMode.set(m)}
        items={[
          { value: 'mobile', label: <><Smartphone aria-hidden className="size-3.5" /><span className="hidden sm:inline">Mobile</span></>, keycap: 'M' },
          { value: 'desktop', label: <><Monitor aria-hidden className="size-3.5" /><span className="hidden sm:inline">Desktop</span></>, keycap: 'D' },
        ]}
      />
      {mode === 'desktop' && row?.domain && (
        <Button variant="text" size="sm" icon={zoom === 'fit' ? <Maximize2 /> : <Minimize2 />} onClick={() => setZoom((z) => (z === 'fit' ? 'actual' : 'fit'))} pressed={zoom === 'actual'} aria-label={zoom === 'fit' ? 'Show the desktop shot at actual size' : 'Fit the desktop shot to the column'}>
          <span className="hidden lg:inline">{zoom === 'fit' ? 'Actual size' : 'Fit'}</span>
        </Button>
      )}
      <span className="flex-1" />
      {site && (
        <Button href={site} target="_blank" rel="noopener noreferrer" variant="secondary" size="sm" icon={<ExternalLink />} keycap="O">
          <span className="hidden sm:inline">Open site</span>
        </Button>
      )}
    </div>
  );

  const identity = row && (
    <div className="flex flex-col gap-1.5 px-4 pb-3 pt-4">
      <span className="truncate font-mono text-[12px] text-text-tertiary">{row.domain ?? 'no website'}</span>
      <h1 className="text-[22px] leading-tight sm:text-[24px]">{row.name}</h1>
      <span className="font-mono text-[12px] text-text-tertiary tnum">
        {num(row.review_count)} reviews{row.rating !== null && <> · {row.rating}<Star aria-hidden className="-mt-0.5 ml-0.5 inline size-2.5 fill-current" /></>}
      </span>
      {badges.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{badges.map((b) => <Badge key={b}>{b}</Badge>)}</div>}
    </div>
  );

  const stage = row && (
    <div className={`relative flex justify-center overflow-auto border border-line-structure bg-surface-2 ${wide ? 'max-h-[calc(100vh-190px)] min-h-[420px]' : 'max-h-[70vh] min-h-[280px]'}`}>
      {row.domain ? (
        <Shot
          key={`${row.domain}-${mode}`}
          domain={row.domain}
          kind={mode}
          name={row.name}
          eager
          className={mode === 'mobile' ? 'block w-[390px] max-w-full self-start shadow-ctl' : zoom === 'fit' ? 'block w-full self-start' : 'block max-w-none self-start'}
          imgClassName="h-auto"
        />
      ) : (
        <Shot domain={null} kind={mode} name={row.name} className="h-[280px] w-full" />
      )}
    </div>
  );

  const places = row && (
    <Panel title="Places" pad={false}>
      <dl className="divide-y divide-line-structure text-body-s">
        <KV k="Category" v={row.primary_type ?? '—'} mono />
        <KV k="Phone" v={row.phone ? <a href={`tel:${row.phone.replace(/\s+/g, '')}`} className="inline-flex items-center gap-1.5 hover:underline"><Phone aria-hidden className="size-3" />{row.phone}</a> : '—'} mono />
        <KV k="Status" v={lead ? (lead.business_status ?? '—') : <Skeleton className="h-4 w-24" />} mono />
        <KV k="Address" v={row.address ?? '—'} />
      </dl>
    </Panel>
  );

  const siteInfo = row && (
    <Panel title="Site" pad={false}>
      <dl className="divide-y divide-line-structure text-body-s">
        <KV k="HTTPS" v={row.https_status === 'ok' ? 'ok' : row.https_status === 'expired' ? 'certificate expired' : row.https_status === 'none' ? 'none — plain HTTP' : '—'} mono />
        <KV k="Cert expires" v={fmtDay(row.cert_expires)} mono />
        <KV k="HTTP status" v={lead ? (lead.http_status ?? '—') : <Skeleton className="h-4 w-10" />} mono />
        <KV k="Final URL" v={lead ? (lead.final_url ? <Ext href={lead.final_url} /> : '—') : <Skeleton className="h-4 w-40" />} mono />
        <KV k="Listed as" v={lead ? (lead.website_raw ?? '—') : <Skeleton className="h-4 w-40" />} mono />
        <KV k="Email" v={row.email ? <span className="inline-flex items-center gap-1.5 break-all"><Mail aria-hidden className="size-3 shrink-0" />{row.email}</span> : '—'} mono />
        <KV k="Captured" v={lead ? fmtDateTime(lead.captured_at) : <Skeleton className="h-4 w-32" />} mono />
      </dl>
    </Panel>
  );

  const links = (
    <Panel title="Outside links" pad={false}>
      {lead ? (
        <div className="flex flex-col divide-y divide-line-structure">
          <LinkList title="Social" links={lead.links.social} />
          <LinkList title="Other" links={lead.links.other} />
        </div>
      ) : <div className="flex flex-col gap-2 p-4"><Skeleton className="h-4 w-32" /><Skeleton className="h-4 w-48" /></div>}
    </Panel>
  );

  const call = row && (
    <Panel title="Your call">
      <div className="flex flex-col gap-4">
        <TierPitch row={row} size="md" withKeycap />
        <NoteField row={row} inputRef={noteRef} />
        <p className="font-mono text-[11px] text-text-tertiary">
          {row.reviewed_at ? `reviewed ${fmtDateTime(row.reviewed_at)}` : 'not reviewed'}
        </p>
      </div>
    </Panel>
  );

  return (
    <>
      <TopBar crumbs={crumbs} onHelp={onHelp} />
      {deckBar}
      <main className="mx-auto max-w-[1600px] px-4 py-4 sm:px-6">
        {!row ? (
          <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)_320px]"><Skeleton className="h-64" /><Skeleton className="h-[480px]" /><Skeleton className="h-64" /></div>
        ) : wide ? (
          <div className="grid grid-cols-[280px_minmax(0,1fr)_320px] items-start gap-4">
            <aside className="flex flex-col gap-4">
              <Panel pad={false}>{identity}</Panel>
              {places}
              {siteInfo}
            </aside>
            {stage}
            <aside className="flex flex-col gap-4">
              {call}
              {links}
            </aside>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <Panel pad={false}>{identity}</Panel>
            {stage}
            {call}
            <div className="grid gap-4 sm:grid-cols-2">
              {places}
              {siteInfo}
            </div>
            {links}
          </div>
        )}
      </main>
    </>
  );
}

function KV({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-2 px-4 py-2">
      <dt className="text-[11px] uppercase leading-5 tracking-[0.06em] text-text-tertiary">{k}</dt>
      <dd className={`min-w-0 break-words leading-5 text-text-primary ${mono ? 'font-mono text-[12px]' : ''}`}>{v}</dd>
    </div>
  );
}

function Ext({ href, children }: { href: string; children?: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-1 break-all text-text-links hover:underline">
      <span className="min-w-0 break-all">{children ?? href}</span>
      <ExternalLink aria-hidden className="size-3 shrink-0" />
    </a>
  );
}

function LinkList({ title, links }: { title: string; links: Link[] }) {
  return (
    <div className="px-4 py-3">
      <h3 className="mb-1.5 text-[11px] uppercase tracking-[0.06em] text-text-tertiary">{title} <span className="font-mono">{links.length}</span></h3>
      {links.length === 0 ? <p className="text-body-s text-text-disabled">none</p> : (
        <ul className="flex flex-col gap-1">
          {links.map((l, i) => (
            <li key={`${l.url}-${i}`} className="text-body-s">
              <Ext href={l.url}>
                <span className="font-mono text-[12px]">{l.target_domain}</span>
                {l.text && <span className="text-text-tertiary"> — {l.text}</span>}
              </Ext>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Hash routes. The hash is the whole navigable state, so a reload, the back
 * button and a link pasted between laptop and phone all land in the same place.
 * The shapes are the ones the old deck used, so existing bookmarks keep working:
 *
 *   #/                                   overview
 *   #/v/<slug>[/no-website][?filter=a,b] one vertical
 *   #/lead/<id>[?v=<slug>&tab=…&filter=…] one lead, with the list it was opened from
 */
import { normaliseFilters, type Tab } from './api';

export interface ListCtx { slug: string; tab: Tab; filters: string[] }

export type Route =
  | { view: 'overview' }
  | { view: 'vertical'; ctx: ListCtx }
  | { view: 'lead'; id: number; ctx: ListCtx | null };

export function listKey(ctx: ListCtx): string {
  return `${ctx.slug}|${ctx.tab}|${ctx.filters.join(',')}`;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '');
  const [head = '', query = ''] = raw.split('?');
  const parts = head.split('/').filter(Boolean);
  const params = new URLSearchParams(query);
  const filters = normaliseFilters((params.get('filter') ?? '').split(',').filter(Boolean));

  if (parts[0] === 'lead' && parts[1] && /^\d+$/.test(parts[1])) {
    const slug = params.get('v');
    const tab: Tab = params.get('tab') === 'no-website' ? 'no-website' : 'leads';
    return {
      view: 'lead',
      id: Number(parts[1]),
      ctx: slug && SLUG_RE.test(slug) ? { slug, tab, filters } : null,
    };
  }
  if (parts[0] === 'v' && parts[1] && SLUG_RE.test(parts[1])) {
    return { view: 'vertical', ctx: { slug: parts[1], tab: parts[2] === 'no-website' ? 'no-website' : 'leads', filters } };
  }
  return { view: 'overview' };
}

export const hrefOverview = () => '#/';

export function hrefVertical(ctx: ListCtx): string {
  const f = ctx.filters.join(',');
  return `#/v/${ctx.slug}${ctx.tab === 'no-website' ? '/no-website' : ''}${f ? `?filter=${encodeURIComponent(f)}` : ''}`;
}

export function hrefLead(id: number, ctx: ListCtx | null): string {
  if (!ctx) return `#/lead/${id}`;
  const q = new URLSearchParams({ v: ctx.slug });
  if (ctx.tab === 'no-website') q.set('tab', ctx.tab);
  if (ctx.filters.length) q.set('filter', ctx.filters.join(','));
  return `#/lead/${id}?${q}`;
}

/** Navigate. Same hash → no `hashchange`, so nothing to do. */
export function go(href: string, replace = false) {
  if (replace) window.history.replaceState(null, '', href);
  else if (window.location.hash !== href) window.location.hash = href;
}

/** The last-opened vertical is the one thing the deck may remember (HANDOFF §3.1). */
const LAST_KEY = 'deck.vertical';
export function rememberVertical(slug: string) { try { localStorage.setItem(LAST_KEY, slug); } catch { /* private mode */ } }
export function lastVertical(): string | null { try { return localStorage.getItem(LAST_KEY); } catch { return null; } }

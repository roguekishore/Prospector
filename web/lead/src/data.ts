/**
 * What the deck knows, outside React: the vertical list, every page of rows it
 * has fetched per (vertical, tab, filters), every lead detail it has opened,
 * and the optimistic decision writer.
 *
 * Module-level stores rather than component state so that grid → detail →
 * grid comes back to the same loaded pages and scroll, and so the keyboard
 * stepper can page forward without a component in the way.
 */
import { createStore } from '@ui/store';
import type { Tone } from '@ui/Badge';
import {
  getLead, getLeads, getVerticals, putDecision, shotUrl,
  type Decision, type Lead, type Row, type Vertical,
} from './api';
import { listKey, type ListCtx } from './routes';

export type Status = 'idle' | 'loading' | 'ready' | 'error';

// ---- verticals -------------------------------------------------------------

export interface VerticalsState { status: Status; items: Vertical[]; error?: unknown }
export const verticals = createStore<VerticalsState>({ status: 'idle', items: [] });

let verticalsInflight: Promise<void> | null = null;
export function loadVerticals(force = false): Promise<void> {
  const s = verticals.get();
  if (!force && (s.status === 'ready' || s.status === 'loading')) return verticalsInflight ?? Promise.resolve();
  verticals.set({ ...s, status: 'loading', error: undefined });
  verticalsInflight = getVerticals()
    .then((items) => verticals.set({ status: 'ready', items }))
    .catch((error) => verticals.set({ ...verticals.get(), status: 'error', error }))
    .finally(() => { verticalsInflight = null; });
  return verticalsInflight;
}

// ---- lists (one page at a time) ---------------------------------------------

export interface ListState { total: number | null; rows: Row[]; status: Status; error?: unknown }
const EMPTY: ListState = { total: null, rows: [], status: 'idle' };

export const lists = createStore<Record<string, ListState>>({});
const listInflight = new Map<string, Promise<void>>();

export function getList(ctx: ListCtx): ListState {
  return lists.get()[listKey(ctx)] ?? EMPTY;
}
export function useList(ctx: ListCtx): ListState {
  return lists.useValue((all) => all[listKey(ctx)] ?? EMPTY);
}
export function isDone(s: ListState): boolean {
  return s.total !== null && s.rows.length >= s.total;
}

function patchList(key: string, fn: (s: ListState) => ListState) {
  lists.update((all) => ({ ...all, [key]: fn(all[key] ?? EMPTY) }));
}

/** Fetch the page at `offset` and append it (or replace, for offset 0). */
function fetchPage(ctx: ListCtx, offset: number): Promise<void> {
  const key = listKey(ctx);
  const running = listInflight.get(key);
  if (running) return running;
  patchList(key, (s) => ({ ...s, status: 'loading', error: undefined }));
  const p = getLeads(ctx.slug, ctx.tab, ctx.filters, offset)
    .then((page) => {
      patchList(key, (s) => {
        // Pages are appended by offset; a repeat of an offset we already hold
        // (two callers racing) replaces those rows rather than duplicating them.
        const rows = offset === 0 ? page.rows : [...s.rows.slice(0, offset), ...page.rows];
        return { total: page.total, rows, status: 'ready' };
      });
    })
    .catch((error) => patchList(key, (s) => ({ ...s, status: 'error', error })))
    .finally(() => listInflight.delete(key));
  listInflight.set(key, p);
  return p;
}

/** The first page, if this list has never loaded (or failed). */
export function ensureList(ctx: ListCtx): Promise<void> {
  const s = getList(ctx);
  if (s.status === 'ready' || s.status === 'loading') return listInflight.get(listKey(ctx)) ?? Promise.resolve();
  return fetchPage(ctx, 0);
}

/** The next page, if there is one. */
export function loadMore(ctx: ListCtx): Promise<void> {
  const s = getList(ctx);
  if (s.status === 'loading') return listInflight.get(listKey(ctx)) ?? Promise.resolve();
  if (isDone(s)) return Promise.resolve();
  return fetchPage(ctx, s.rows.length);
}

/** Start over — after a filter change the operator wants to see reflected, say. */
export function reloadList(ctx: ListCtx): Promise<void> {
  return fetchPage(ctx, 0);
}

/**
 * Load pages until row `i` exists, then return it — or null once the list is
 * exhausted. This is what lets the keyboard step across page boundaries.
 */
export async function ensureIndex(ctx: ListCtx, i: number): Promise<Row | null> {
  if (i < 0) return null;
  await ensureList(ctx);
  for (let guard = 0; guard < 200; guard++) {
    const s = getList(ctx);
    if (s.rows[i]) return s.rows[i]!;
    if (s.status === 'error') throw s.error;
    if (isDone(s)) return null;
    await loadMore(ctx);
  }
  return null;
}

/** Any loaded row with this id, from any list. Used to paint a detail before its fetch lands. */
export function findRow(id: number): Row | undefined {
  for (const s of Object.values(lists.get())) {
    const r = s.rows.find((x) => x.company_id === id);
    if (r) return r;
  }
  return undefined;
}

// ---- lead detail -----------------------------------------------------------

export interface LeadState { status: Status; lead?: Lead; error?: unknown }
export const leads = createStore<Record<number, LeadState>>({});
const leadInflight = new Map<number, Promise<Lead>>();

export function useLead(id: number): LeadState {
  return leads.useValue((all) => all[id] ?? { status: 'idle' });
}

export function loadLead(id: number, force = false): Promise<Lead> {
  const running = leadInflight.get(id);
  if (running) return running;
  const cur = leads.get()[id];
  if (!force && cur?.status === 'ready' && cur.lead) return Promise.resolve(cur.lead);
  leads.update((all) => ({ ...all, [id]: { ...(all[id] ?? {}), status: 'loading', error: undefined } }));
  const p = getLead(id)
    .then((lead) => { leads.update((all) => ({ ...all, [id]: { status: 'ready', lead } })); return lead; })
    .catch((error) => { leads.update((all) => ({ ...all, [id]: { ...(all[id] ?? {}), status: 'error', error } })); throw error; })
    .finally(() => leadInflight.delete(id));
  leadInflight.set(id, p);
  return p;
}

/** Warm the detail cache without caring about the answer. */
export function prefetchLead(id: number) {
  loadLead(id).catch(() => {});
}

const warmed = new Set<string>();
/** Ask the browser for the screenshots so a step paints them from cache. */
export function prefetchShots(domain: string | null, kinds: Array<'mobile' | 'desktop'> = ['mobile', 'desktop']) {
  if (!domain) return;
  for (const k of kinds) {
    const url = shotUrl(domain, k);
    if (warmed.has(url)) continue;
    warmed.add(url);
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
  }
}

// ---- decisions -------------------------------------------------------------

type Notify = (message: string, opts?: { tone?: Tone }) => void;
let notify: Notify = () => {};
/** The app hands its toast function in once; the writer stays React-free. */
export function setNotifier(fn: Notify) { notify = fn; }

function currentOf(id: number): Row | Lead | undefined {
  return leads.get()[id]?.lead ?? findRow(id);
}

/** Write the same fields onto the cached detail and every list row with this id. */
function applyRow(id: number, fields: Partial<Row>) {
  leads.update((all) => {
    const s = all[id];
    return s?.lead ? { ...all, [id]: { ...s, lead: { ...s.lead, ...fields } } } : all;
  });
  lists.update((all) => {
    let changed = false;
    const next: Record<string, ListState> = {};
    for (const [k, s] of Object.entries(all)) {
      const i = s.rows.findIndex((r) => r.company_id === id);
      if (i < 0) { next[k] = s; continue; }
      const rows = s.rows.slice();
      rows[i] = { ...rows[i]!, ...fields };
      next[k] = { ...s, rows };
      changed = true;
    }
    return changed ? next : all;
  });
}

/**
 * Save one decision, optimistically.
 *
 * The control flips first so a fast reviewer never waits on a round trip. The
 * `PUT` is a full replace, so the patch is merged onto the row's current tier,
 * pitch and note and all three are sent. If it fails, the row reverts and a
 * "not saved" toast says why. Nothing is kept in localStorage: a decision that
 * exists only in one browser is a decision that is lost.
 */
export async function saveDecision(id: number, patch: Partial<Decision>): Promise<boolean> {
  const cur = currentOf(id);
  if (!cur) return false;
  const before: Decision & { reviewed_at: string | null } = { tier: cur.tier, pitch: cur.pitch, note: cur.note, reviewed_at: cur.reviewed_at };
  const next: Decision = { tier: before.tier, pitch: before.pitch, note: before.note, ...patch };
  // `reviewed_at` is the server's to set; this mirrors its rule for the local paint.
  const reviewed_at = next.tier !== null || next.pitch ? (before.reviewed_at ?? new Date().toISOString()) : null;

  applyRow(id, { ...next, reviewed_at });
  try {
    await putDecision(id, next);
    return true;
  } catch (e) {
    applyRow(id, before);
    const why = e instanceof Error ? e.message : String(e);
    notify(`Not saved — ${why}`, { tone: 'error' });
    return false;
  }
}

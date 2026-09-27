/**
 * Stepping through a list: which lead is next, which is the next unreviewed,
 * and warming the neighbours so a step paints at once. Pure data; the keys
 * that call these live in the Lead view.
 */
import { ensureIndex, ensureList, getList, isDone, loadMore, prefetchLead, prefetchShots } from './data';
import type { ListCtx } from './routes';

export type StepResult = { id: number; index: number } | 'start' | 'end' | 'unknown';

async function indexOf(ctx: ListCtx, id: number): Promise<number> {
  let i = getList(ctx).rows.findIndex((r) => r.company_id === id);
  if (i >= 0) return i;
  await ensureList(ctx);
  i = getList(ctx).rows.findIndex((r) => r.company_id === id);
  return i;
}

/** Where `id` sits in the list, for "12 / 530". Null until its page is loaded. */
export function positionOf(ctx: ListCtx, id: number): { index: number; total: number | null } | null {
  const s = getList(ctx);
  const i = s.rows.findIndex((r) => r.company_id === id);
  return i < 0 ? null : { index: i, total: s.total };
}

/**
 * The lead `dir` steps away in the list order the server returned, fetching
 * the next `offset` page when the step lands past the loaded rows.
 */
export async function neighbour(ctx: ListCtx, id: number, dir: 1 | -1): Promise<StepResult> {
  const i = await indexOf(ctx, id);
  if (i < 0) return 'unknown';
  const target = i + dir;
  if (target < 0) return 'start';
  const row = await ensureIndex(ctx, target);
  return row ? { id: row.company_id, index: target } : 'end';
}

/** The next lead after `id` with no `reviewed_at`, paging forward as far as it takes. */
export async function nextUnreviewed(ctx: ListCtx, id: number): Promise<StepResult> {
  const i = await indexOf(ctx, id);
  if (i < 0) return 'unknown';
  for (let j = i + 1; ; j++) {
    const row = await ensureIndex(ctx, j);
    if (!row) return 'end';
    if (row.reviewed_at === null) return { id: row.company_id, index: j };
  }
}

/**
 * Warm the two leads either side (detail JSON and both screenshots) and, when
 * the operator is within a few rows of the loaded end, the next page.
 */
export function prefetchAround(ctx: ListCtx, id: number) {
  const s = getList(ctx);
  const i = s.rows.findIndex((r) => r.company_id === id);
  if (i < 0) return;
  for (const j of [i + 1, i - 1, i + 2]) {
    const r = s.rows[j];
    if (!r) continue;
    prefetchLead(r.company_id);
    prefetchShots(r.domain);
  }
  if (!isDone(s) && s.rows.length - i <= 4) loadMore(ctx).catch(() => {});
}

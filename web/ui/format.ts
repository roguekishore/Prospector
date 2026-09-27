/** Formatting helpers shared by both apps. */

const INT = new Intl.NumberFormat('en-IN');

/** `1,234` in the operator's locale (Indian grouping), `—` for nothing. */
export function num(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : INT.format(n);
}

/** `62%` from a part and a whole; `0%` when the whole is zero. */
export function pct(part: number, whole: number): string {
  return `${whole ? Math.round((100 * part) / whole) : 0}%`;
}

/**
 * Parse a timestamp the API returned. MySQL `DATETIME` arrives as
 * `2026-09-26 18:52:34` with no zone, and every clock in the database is UTC —
 * so it is read as UTC explicitly. `new Date('2026-09-26 18:52:34')` would be
 * read as *local* by every browser and shift the instant by the host offset.
 */
export function parseUtc(s: string | null | undefined): Date | null {
  if (!s) return null;
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `26 Sep 2026, 6:52 pm` in the browser's own zone. */
export function fmtDateTime(s: string | null | undefined): string {
  const d = parseUtc(s);
  return d ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
}

/** `26 Sep 2026` in the browser's own zone. */
export function fmtDate(s: string | null | undefined): string {
  const d = parseUtc(s);
  return d ? d.toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—';
}

/** `6:52:10 pm` for the log. */
export function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour12: false });
}

/** A `DATE` column (`2027-06-01`) as `1 Jun 2027`. */
export function fmtDay(s: string | null | undefined): string {
  if (!s) return '—';
  const d = new Date(`${String(s).slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? String(s) : d.toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' });
}

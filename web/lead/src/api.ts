/**
 * The deck's API, typed. The contract is `src/server/index.js` (HANDOFF §4.1)
 * and this file adapts to it, never the reverse.
 */
import type { Tier } from '@ui/TierGroup';

export type Tab = 'leads' | 'no-website';
export type HttpsStatus = 'ok' | 'expired' | 'none' | null;

export interface Vertical {
  slug: string; label: string;
  leads: number; no_website: number; reviewed: number; pitch: number;
}

export interface Row {
  company_id: number;
  name: string;
  domain: string | null;
  vertical: string;
  address: string | null;
  phone: string | null;
  rating: number | null;
  review_count: number | null;
  primary_type: string | null;
  https_status: HttpsStatus;
  cert_expires: string | null;
  email: string | null;
  tier: Tier | null;
  pitch: boolean;
  note: string | null;
  reviewed_at: string | null;
}

export interface Link { url: string; target_domain: string; kind: string; region: string | null; text: string | null }

export interface Lead extends Row {
  website_raw: string | null;
  final_url: string | null;
  http_status: number | null;
  business_status: string | null;
  captured_at: string | null;
  vertical_label: string;
  links: { social: Link[]; other: Link[] };
}

export interface Page { total: number; rows: Row[] }

/** The decision `PUT` is a full replace: always all three fields. */
export interface Decision { tier: Tier | null; pitch: boolean; note: string | null }

export const PAGE = 60;

/** The filter chips, in display order. Keys are the server's `FILTERS` map. */
export const FILTERS: ReadonlyArray<readonly [key: string, label: string, group: 'site' | 'review' | 'tier']> = [
  ['http',       'HTTP only',    'site'],
  ['expired',    'Cert expired', 'site'],
  ['email',      'Has email',    'site'],
  ['unreviewed', 'Unreviewed',   'review'],
  ['pitch',      'Pitch',        'review'],
  ['tier:A',     'A',            'tier'],
  ['tier:B',     'B',            'tier'],
  ['tier:C',     'C',            'tier'],
  ['tier:X',     'X',            'tier'],
];
const FILTER_ORDER = new Map(FILTERS.map(([k], i) => [k, i]));

/** Known filters only, in canonical order, so two chip orders make one cache key. */
export function normaliseFilters(keys: Iterable<string>): string[] {
  return [...new Set(keys)].filter((k) => FILTER_ORDER.has(k)).sort((a, b) => FILTER_ORDER.get(a)! - FILTER_ORDER.get(b)!);
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; this.name = 'ApiError'; }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { Accept: 'application/json', ...(init?.headers ?? {}) } });
  } catch {
    throw new ApiError(0, 'the server did not answer');
  }
  if (!res.ok) {
    let detail = res.statusText || `HTTP ${res.status}`;
    try { const body = (await res.json()) as { error?: string }; if (body?.error) detail = body.error; } catch { /* not json */ }
    throw new ApiError(res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const getVerticals = () => api<Vertical[]>('/api/verticals');

export function getLeads(slug: string, tab: Tab, filters: string[], offset: number, limit = PAGE) {
  const q = new URLSearchParams({ vertical: slug, view: tab, offset: String(offset), limit: String(limit) });
  if (filters.length) q.set('filter', filters.join(','));
  return api<Page>(`/api/leads?${q}`);
}

export const getLead = (id: number) => api<Lead>(`/api/leads/${id}`);

export function putDecision(id: number, d: Decision) {
  return api<void>(`/api/leads/${id}/decision`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tier: d.tier ?? null, pitch: !!d.pitch, note: d.note ?? null }),
  });
}

export const PITCH_CSV = '/api/export/pitch.csv';

export function shotUrl(domain: string, kind: 'mobile' | 'desktop') {
  return `/shots/${encodeURIComponent(domain)}/${kind}.webp`;
}

/** The live site, for the O key and the "open" link. Prefers what qualify resolved. */
export function siteUrl(lead: Pick<Lead, 'final_url' | 'website_raw' | 'domain'>): string | null {
  if (lead.final_url) return lead.final_url;
  if (lead.website_raw) return lead.website_raw;
  if (lead.domain) return `https://${lead.domain}/`;
  return null;
}

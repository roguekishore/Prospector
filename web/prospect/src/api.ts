/**
 * The control panel's API, typed. The contract is `src/control/index.js`
 * (HANDOFF §4.2); this adapts to it, never the reverse.
 *
 * The token travels as `X-Control-Token` on fetches and as `?token=` on the
 * EventSource URL (the browser cannot set a header on one). It comes from
 * `?token=` in the page URL or from `localStorage['pc.token']`, so a
 * bookmarked phone link keeps working.
 */

export interface VerticalStatus {
  slug: string; label: string;
  discovered: number; eligible: number; captured: number; failed: number; pending: number;
  noWebsite: number; dead: number; unqualified: number; extracted: number;
  failureKinds: Record<string, number>; pct: number;
}
export interface Totals extends Omit<VerticalStatus, 'slug' | 'label'> {}
export interface StatusPayload { verticals: VerticalStatus[]; total: Totals; at: string; unit: 'rows' }

export interface RunState {
  mode: string; label: string; argv: string[]; startedAt: number; pid: number;
  stepIndex: number; totalSteps: number; stepLabel: string;
}
export interface LastExit { code: number | null; signal: string | null; at: number; label: string; mode: string; error?: string }
export interface LogLine { at: number; stream: 'out' | 'err' | 'sys'; line: string }
export interface Snapshot { running: boolean; state: RunState | null; lastExit: LastExit | null; lines: LogLine[] }
export type RunEvent = { running: true; state: RunState } | { running: false; lastExit: LastExit };

export interface Estimate { floor: number; ceiling: number; tiles: number }
export interface Vertical { slug: string; label: string; enabled: boolean; priority: number; keywords: string[]; estimate: Estimate }

export type Mode = 'local' | 'lambda';
export type CaptureMode = 'local' | 'lambda' | 'none';

export interface StartRunBody { mode: Mode; vertical: string | null; concurrency: number; deadline: number; batch: number; dryRun?: boolean }
export interface StartPipelineBody { vertical: string; captureMode: CaptureMode; concurrency?: number; batch?: number }

// ---- token -------------------------------------------------------------------

const KEY = 'pc.token';

export function readToken(): string {
  const fromUrl = new URLSearchParams(window.location.search).get('token');
  if (fromUrl) { writeToken(fromUrl); return fromUrl; }
  try { return localStorage.getItem(KEY) ?? ''; } catch { return ''; }
}
export function writeToken(t: string) {
  try { if (t) localStorage.setItem(KEY, t); else localStorage.removeItem(KEY); } catch { /* private mode */ }
}

// ---- fetch -------------------------------------------------------------------

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; this.name = 'ApiError'; }
}

export async function api<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...(init?.headers as Record<string, string> | undefined) };
  if (token) headers['X-Control-Token'] = token;
  if (init?.body) headers['Content-Type'] = 'application/json';
  let res: Response;
  try { res = await fetch(path, { ...init, headers }); }
  catch { throw new ApiError(0, 'the server did not answer'); }
  let body: unknown = null;
  try { body = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const detail = (body as { error?: string } | null)?.error ?? (res.status === 401 ? 'Unauthorized' : `HTTP ${res.status}`);
    throw new ApiError(res.status, detail);
  }
  return body as T;
}

export const getRun       = (t: string) => api<Snapshot>('/api/run', t);
export const getStatus    = (t: string) => api<StatusPayload>('/api/status', t);
export const getVerticals = (t: string) => api<Vertical[]>('/api/verticals', t);
export const startRun     = (t: string, body: StartRunBody) => api<{ ok: true; state: RunState }>('/api/run/start', t, { method: 'POST', body: JSON.stringify(body) });
export const stopRun      = (t: string) => api<{ ok: boolean; message: string }>('/api/run/stop', t, { method: 'POST' });
export const addVertical  = (t: string, body: { label: string; keywords: string[] }) => api<{ ok: true; vertical: Vertical; estimate: Estimate }>('/api/verticals', t, { method: 'POST', body: JSON.stringify(body) });
export const startPipeline = (t: string, body: StartPipelineBody) => api<{ ok: true; state: RunState }>('/api/pipeline/start', t, { method: 'POST', body: JSON.stringify(body) });

export function eventsUrl(token: string): string {
  return '/api/events' + (token ? `?token=${encodeURIComponent(token)}` : '');
}

/** What one discover run costs, mirrored from src/control/verticals.js for the live estimate. */
export const TILES = 25;
export const MAX_PAGES = 3;
export function estimateFor(keywordCount: number): Estimate {
  const floor = TILES * keywordCount;
  return { floor, ceiling: floor * MAX_PAGES, tiles: TILES };
}

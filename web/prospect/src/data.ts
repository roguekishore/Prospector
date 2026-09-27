/**
 * The control panel's live state: the token, the SSE connection and what it
 * pushes (runner snapshot, status every 3 s, log lines, run transitions,
 * vertical additions), plus the vertical list fetched over HTTP.
 */
import { createStore } from '@ui/store';
import {
  ApiError, eventsUrl, getRun, getVerticals, readToken, writeToken,
  type LastExit, type LogLine, type RunEvent, type RunState, type Snapshot, type StatusPayload, type Vertical,
} from './api';

export const MAX_LINES = 500;

export type Conn = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'unauthorised' | 'down';

export const token   = createStore<string>(readToken());
export const conn    = createStore<Conn>('idle');
export const status  = createStore<StatusPayload | null>(null);
export const run     = createStore<{ running: boolean; state: RunState | null; lastExit: LastExit | null }>({ running: false, state: null, lastExit: null });
export const lines   = createStore<LogLine[]>([]);
export const verts   = createStore<{ items: Vertical[]; error?: string }>({ items: [] });
export const banner  = createStore<{ text: string; tone: 'error' | 'success' } | null>(null);
/** True from a 401 until a token is accepted: the page shows the token form, not a flash of the panel. */
export const gated   = createStore<boolean>(false);

let bannerTimer = 0;
export function showBanner(text: string, tone: 'error' | 'success' = 'error', ms = 6000) {
  banner.set({ text, tone });
  window.clearTimeout(bannerTimer);
  bannerTimer = window.setTimeout(() => banner.set(null), ms);
}
export function clearBanner() { banner.set(null); window.clearTimeout(bannerTimer); }

export function setToken(t: string) {
  writeToken(t.trim());
  token.set(t.trim());
  void boot();
}

export function clearLog() { lines.set([]); }

// ---- verticals -----------------------------------------------------------------

export async function loadVerticals(): Promise<void> {
  try {
    const items = await getVerticals(token.get());
    verts.set({ items });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) { conn.set('unauthorised'); gated.set(true); return; }
    verts.set({ ...verts.get(), error: e instanceof Error ? e.message : String(e) });
  }
}

// ---- the stream ----------------------------------------------------------------

let es: EventSource | null = null;
let retryTimer = 0;
let retryMs = 2000;

function append(entry: LogLine) {
  lines.update((xs) => {
    const next = xs.length >= MAX_LINES ? xs.slice(xs.length - MAX_LINES + 1) : xs.slice();
    next.push(entry);
    return next;
  });
}

function applySnapshot(s: Snapshot) {
  run.set({ running: s.running, state: s.state, lastExit: s.lastExit });
  lines.set((s.lines ?? []).slice(-MAX_LINES));
}

/**
 * Open the stream. `EventSource` reconnects by itself after a drop, but not
 * after a refused connection — and it cannot tell us why it was refused. So on
 * `error` with the stream closed we probe `/api/run` over fetch, which can:
 * a 401 means the token is missing or wrong, anything else means the server
 * is down and we retry with backoff.
 */
export function connect(reset = false) {
  window.clearTimeout(retryTimer);
  if (es) { es.close(); es = null; }
  if (reset) retryMs = 2000;
  conn.set(conn.get() === 'live' || conn.get() === 'idle' ? 'connecting' : conn.get() === 'unauthorised' ? 'connecting' : 'reconnecting');

  const source = new EventSource(eventsUrl(token.get()));
  es = source;

  source.addEventListener('open', () => { conn.set('live'); gated.set(false); retryMs = 2000; clearBanner(); void loadVerticals(); });
  source.addEventListener('snapshot', (e) => applySnapshot(JSON.parse((e as MessageEvent).data) as Snapshot));
  source.addEventListener('status',   (e) => status.set(JSON.parse((e as MessageEvent).data) as StatusPayload));
  source.addEventListener('line',     (e) => append(JSON.parse((e as MessageEvent).data) as LogLine));
  source.addEventListener('run',      (e) => {
    const d = JSON.parse((e as MessageEvent).data) as RunEvent;
    if (d.running) run.set({ running: true, state: d.state, lastExit: run.get().lastExit });
    else run.set({ running: false, state: null, lastExit: d.lastExit });
  });
  source.addEventListener('verticals', () => { void loadVerticals(); });

  source.onerror = () => {
    if (source !== es) return;
    if (source.readyState === EventSource.CONNECTING) { conn.set('reconnecting'); return; }   // the browser is retrying on its own
    source.close(); es = null;
    void getRun(token.get())
      .then((snap) => { applySnapshot(snap); scheduleRetry(); })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) { conn.set('unauthorised'); gated.set(true); return; }
        conn.set('down');
        scheduleRetry();
      });
  };
}

function scheduleRetry() {
  window.clearTimeout(retryTimer);
  retryTimer = window.setTimeout(() => connect(), retryMs);
  retryMs = Math.min(retryMs * 2, 30_000);
}

/** The first thing the page does: find out whether the token works, then stream. */
export async function boot() {
  conn.set('connecting');
  try {
    const snap = await getRun(token.get());
    applySnapshot(snap);
    gated.set(false);
    connect(true);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) { conn.set('unauthorised'); gated.set(true); return; }
    conn.set('down');
    scheduleRetry();
  }
}

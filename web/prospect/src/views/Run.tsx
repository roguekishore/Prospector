import { useState } from 'react';
import { Play, Square } from 'lucide-react';
import { Badge, Button, ConfirmDialog, Field, Panel, Select, Tabs } from '@ui/index';
import { fmtDateTime, num } from '@ui/format';
import { startRun, stopRun } from '../api';
import { run, showBanner, status, token } from '../data';
import { BATCHES, CONCURRENCY, DEADLINES, settings } from '../settings';

/**
 * Capture what is still pending: on this box (slow, free, unattended) or on
 * Lambda (fast). One run at a time; Stop asks first and is safe — capture is
 * per-domain atomic and resumes where it stopped.
 */
export function Run() {
  const st = settings.useValue();
  const r = run.useValue();
  const s = status.useValue();
  const [busy, setBusy] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);

  const verticals = s?.verticals ?? [];
  const pendingAll = verticals.reduce((a, v) => a + v.pending, 0);

  async function start() {
    setBusy(true);
    try {
      await startRun(token.get(), {
        mode: st.mode, vertical: st.vertical || null,
        concurrency: st.concurrency, deadline: st.deadline, batch: st.batch,
      });
    } catch (e) {
      showBanner(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  async function stop() {
    setConfirmStop(false);
    setBusy(true);
    try {
      const res = await stopRun(token.get());
      if (!res.ok) showBanner(res.message, 'error');
    } catch (e) {
      showBanner(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  return (
    <div className="flex flex-col gap-3">
      <Panel title="Capture what is pending">
        <div className="flex flex-col gap-4">
          <Field id="mode" label="Where">
            <Tabs
              ariaLabel="Where to capture"
              size="lg"
              className="w-full [&>button]:flex-1"
              value={st.mode}
              onChange={(mode) => settings.update((v) => ({ ...v, mode }))}
              items={[
                { value: 'local',  label: <span>This box <span className="text-text-tertiary">· slow</span></span> },
                { value: 'lambda', label: <span>Lambda <span className="text-text-tertiary">· fast</span></span> },
              ]}
            />
          </Field>

          <Field id="runVertical" label="Vertical">
            <Select id="runVertical" uiSize="lg" value={st.vertical} onChange={(e) => settings.update((v) => ({ ...v, vertical: e.target.value }))}>
              <option value="">All verticals · {num(pendingAll)} pending</option>
              {verticals.map((v) => <option key={v.slug} value={v.slug}>{v.label} · {num(v.pending)} pending</option>)}
            </Select>
          </Field>

          {st.mode === 'local' ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="conc" label="Concurrency">
                <Select id="conc" uiSize="lg" value={st.concurrency} onChange={(e) => settings.update((v) => ({ ...v, concurrency: Number(e.target.value) }))}>
                  {CONCURRENCY.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              </Field>
              <Field id="deadline" label="Per-capture deadline">
                <Select id="deadline" uiSize="lg" value={st.deadline} onChange={(e) => settings.update((v) => ({ ...v, deadline: Number(e.target.value) }))}>
                  {DEADLINES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              </Field>
            </div>
          ) : (
            <Field id="batch" label="Domains per invoke" hint="10 × a 60 s deadline fits Lambda's 900 s ceiling; 15 does not in the worst case.">
              <Select id="batch" uiSize="lg" value={st.batch} onChange={(e) => settings.update((v) => ({ ...v, batch: Number(e.target.value) }))}>
                {BATCHES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
            </Field>
          )}

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button variant="cta" size="lg" icon={<Play />} onClick={() => void start()} disabled={busy || r.running} className="sm:flex-1">
              {st.mode === 'lambda' ? 'Dispatch to Lambda' : 'Start capture'}
            </Button>
            {r.running && (
              <Button variant="danger" size="lg" icon={<Square />} onClick={() => setConfirmStop(true)} disabled={busy} className="sm:flex-1">
                Stop
              </Button>
            )}
          </div>

          {r.running && r.state ? (
            <p className="text-[12px] leading-snug text-text-tertiary">
              Running since <span className="font-mono text-text-secondary">{fmtDateTime(new Date(r.state.startedAt).toISOString())}</span> · pid <span className="font-mono">{r.state.pid}</span>.
              Stopping is safe — capture is per-domain atomic and resumes where it stopped.
            </p>
          ) : r.lastExit ? (
            <p className="flex flex-wrap items-center gap-2 text-[12px] text-text-tertiary">
              <Badge tone={r.lastExit.code === 0 ? 'success' : 'error'}>{r.lastExit.code === 0 ? 'ok' : `exit ${r.lastExit.code ?? r.lastExit.signal ?? '?'}`}</Badge>
              <span className="truncate">{r.lastExit.label}</span>
              <span className="font-mono">{fmtDateTime(new Date(r.lastExit.at).toISOString())}</span>
            </p>
          ) : (
            <p className="text-[12px] text-text-tertiary">One run at a time: two captures would fight for the same 2 GB and re-capture each other's work.</p>
          )}
        </div>
      </Panel>

      <ConfirmDialog
        open={confirmStop}
        onCancel={() => setConfirmStop(false)}
        onConfirm={() => void stop()}
        title="Stop the run?"
        description="Completed captures are kept and it resumes where it stopped."
        confirmLabel="Stop the run"
        danger
        busy={busy}
      />
    </div>
  );
}

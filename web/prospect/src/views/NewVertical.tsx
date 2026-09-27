import { useState, type FormEvent } from 'react';
import { Coins, Plus } from 'lucide-react';
import { Badge, Button, ConfirmDialog, Field, Input, Panel, Select, Tabs, Textarea } from '@ui/index';
import { num } from '@ui/format';
import { addVertical, estimateFor, startPipeline, type CaptureMode } from '../api';
import { loadVerticals, run, showBanner, token, verts } from '../data';
import { settings } from '../settings';

const MAX_KEYWORDS = 20;

function splitKeywords(text: string): string[] {
  return text.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** Add a vertical, and run the whole pipeline for one — the only path that spends Places quota. */
export function NewVertical() {
  return (
    <div className="flex flex-col gap-3">
      <AddForm />
      <PipelineForm />
    </div>
  );
}

function AddForm() {
  const [label, setLabel] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const r = run.useValue();

  const keywords = splitKeywords(text);
  const est = estimateFor(keywords.length);
  const tooMany = keywords.length > MAX_KEYWORDS;
  const valid = label.trim().length > 0 && keywords.length > 0 && !tooMany;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    try {
      const res = await addVertical(token.get(), { label: label.trim(), keywords });
      showBanner(`Added ${res.vertical.slug} — ${num(res.estimate.floor)}–${num(res.estimate.ceiling)} Places requests per discover run.`, 'success');
      setLabel(''); setText('');
      await loadVerticals();
      settings.update((v) => ({ ...v, pipeVertical: res.vertical.slug }));
    } catch (err) {
      showBanner(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  return (
    <Panel title="Add a vertical">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field id="nvLabel" label="Name" hint="The slug is derived from it and never renamed.">
          <Input id="nvLabel" uiSize="lg" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Veterinary clinics" autoCapitalize="words" autoComplete="off" />
        </Field>
        <Field
          id="nvKeywords"
          label={`Search keywords — one per line, 1–${MAX_KEYWORDS}`}
          hint={
            tooMany
              ? <span className="text-tone-error">{keywords.length} keywords — at most {MAX_KEYWORDS}.</span>
              : keywords.length
                ? <span><span className="font-mono">{estimateFor(1).tiles} tiles × {keywords.length}</span> = <span className="font-mono text-text-secondary">{num(est.floor)}</span> requests minimum, up to <span className="font-mono text-text-secondary">{num(est.ceiling)}</span> if every query paginates.</span>
                : `${estimateFor(1).tiles} tiles × keywords = Places requests per discover run.`
          }
        >
          <Textarea id="nvKeywords" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder={'veterinary clinic\npet hospital\nanimal clinic'} className="min-h-24 text-[15px]" />
        </Field>
        <Button type="submit" variant="primary" size="lg" icon={<Plus />} disabled={!valid || busy || r.running} full>
          Add vertical
        </Button>
      </form>
    </Panel>
  );
}

function PipelineForm() {
  const st = settings.useValue();
  const v = verts.useValue();
  const r = run.useValue();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<CaptureMode | null>(null);

  const slug = st.pipeVertical || v.items[0]?.slug || '';
  const chosen = v.items.find((x) => x.slug === slug);

  async function go(captureMode: CaptureMode) {
    setConfirm(null);
    if (!chosen) return showBanner('Pick a vertical');
    setBusy(true);
    try {
      await startPipeline(token.get(), {
        vertical: chosen.slug, captureMode,
        ...(captureMode === 'none' ? {} : { concurrency: st.concurrency, batch: st.batch }),
      });
    } catch (err) {
      showBanner(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  const disabled = busy || r.running || !chosen;

  return (
    <Panel title="Run the whole pipeline">
      <div className="flex flex-col gap-4">
        <Field id="pipeVertical" label="Vertical">
          <Select id="pipeVertical" uiSize="lg" value={slug} onChange={(e) => settings.update((x) => ({ ...x, pipeVertical: e.target.value }))}>
            {v.items.length === 0 && <option value="">No verticals yet</option>}
            {v.items.map((x) => <option key={x.slug} value={x.slug}>{x.label} · {x.keywords.length} keyword{x.keywords.length === 1 ? '' : 's'}</option>)}
          </Select>
        </Field>
        {v.error && <p className="text-[12px] text-tone-error">{v.error}</p>}

        <Field id="pipeMode" label="Capture on">
          <Tabs
            ariaLabel="Where to capture"
            size="lg"
            className="w-full [&>button]:flex-1"
            value={st.pipeMode}
            onChange={(pipeMode) => settings.update((x) => ({ ...x, pipeMode }))}
            items={[{ value: 'local', label: 'This box' }, { value: 'lambda', label: 'Lambda' }]}
          />
        </Field>

        {chosen && (
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-text-tertiary">
            <Coins aria-hidden className="size-3.5" />
            <span>Discover will spend</span>
            <Badge tone="warning"><span className="font-mono tnum">{num(chosen.estimate.floor)}–{num(chosen.estimate.ceiling)}</span> requests</Badge>
            <span>— the only stage that costs quota.</span>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <Button variant="cta" size="lg" onClick={() => setConfirm(st.pipeMode)} disabled={disabled} full>
            discover → qualify → capture
          </Button>
          <Button variant="secondary" size="lg" onClick={() => setConfirm('none')} disabled={disabled} full>
            Discover + qualify only
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirm !== null}
        onCancel={() => setConfirm(null)}
        onConfirm={() => { if (confirm) void go(confirm); }}
        title={confirm === 'none' ? `Discover + qualify ${chosen?.label ?? ''}?` : `Run the pipeline for ${chosen?.label ?? ''}?`}
        description={confirm === 'none' ? 'No capture afterwards.' : `discover → qualify → capture on ${st.pipeMode === 'lambda' ? 'Lambda' : 'this box'}.`}
        confirmLabel={`Spend ${chosen ? `${num(chosen.estimate.floor)}–${num(chosen.estimate.ceiling)}` : ''} requests`}
        busy={busy}
      >
        {chosen && (
          <p>
            Discover will spend <strong className="font-mono text-text-primary">{num(chosen.estimate.floor)}–{num(chosen.estimate.ceiling)}</strong> Places
            requests ({chosen.estimate.tiles} tiles × {chosen.keywords.length} keyword{chosen.keywords.length === 1 ? '' : 's'}, up to {estimateFor(1).ceiling / estimateFor(1).floor} pages each).
            This is the only stage that costs quota.
          </p>
        )}
      </ConfirmDialog>
    </Panel>
  );
}

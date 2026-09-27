import { Badge, Empty, Panel, Skeleton, StackedBar, StatTile } from '@ui/index';
import { fmtTime, num } from '@ui/format';
import type { VerticalStatus } from '../api';
import { conn, status } from '../data';

/**
 * Capture progress, from MySQL every 3 s. Counts are rows, not domains — several
 * listings can share one website and capture runs once per website — and the
 * page says so in words, not a footnote.
 */
export function Progress() {
  const s = status.useValue();
  const c = conn.useValue();

  if (!s) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-40" />
        <Skeleton className="h-64" />
        {c === 'down' && <Empty title="The server is not answering." hint="Reconnecting on its own. Numbers appear as soon as the stream opens." />}
      </div>
    );
  }

  const t = s.total;
  const kinds = Object.entries(t.failureKinds ?? {}).sort((a, b) => b[1] - a[1]);
  const at = new Date(s.at);

  return (
    <div className="flex flex-col gap-3">
      <Panel
        title="Captured"
        actions={<span className="font-mono text-[11px] text-text-tertiary tnum">updated {Number.isNaN(at.getTime()) ? '—' : fmtTime(at.getTime())}</span>}
      >
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-4">
            <StatTile value={t.captured} label="captured" tone="success" size="lg" />
            <StatTile value={t.pending}  label="pending" size="lg" />
            <StatTile value={t.failed}   label="failed" tone={t.failed ? 'error' : 'neutral'} size="lg" />
            <StatTile value={t.eligible} label="eligible" size="lg" hint={`${t.pct}% captured`} />
          </div>
          <StackedBar
            total={t.eligible}
            height="h-2"
            segments={[
              { value: t.captured, tone: 'success', label: 'captured' },
              { value: t.failed,   tone: 'error',   label: 'failed' },
              { value: t.pending,  tone: 'muted',   label: 'pending' },
            ]}
          />
          <div className="grid grid-cols-2 gap-x-3 gap-y-3 sm:grid-cols-5">
            <StatTile value={t.discovered}  label="discovered" size="sm" />
            <StatTile value={t.noWebsite}   label="no website" size="sm" />
            <StatTile value={t.dead}        label="dead host" size="sm" />
            <StatTile value={t.unqualified} label="unqualified" size="sm" />
            <StatTile value={t.extracted}   label="extracted" size="sm" />
          </div>
          {kinds.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] uppercase tracking-[0.06em] text-text-tertiary">failures</span>
              {kinds.map(([k, n]) => <Badge key={k} tone="error"><span className="font-mono">{k}</span> {num(n)}</Badge>)}
            </div>
          )}
          <p className="text-[12px] leading-snug text-text-tertiary">
            Counts are <strong className="font-medium text-text-secondary">listings (rows), not websites</strong>: several listings can share one
            site, and capture runs once per site.
          </p>
        </div>
      </Panel>

      <Panel title="By vertical" pad={false}>
        {s.verticals.length === 0
          ? <Empty className="border-0" title="No verticals yet." hint="Add one under New vertical, then run discover." />
          : <ul className="divide-y divide-line-structure">{s.verticals.map((v) => <li key={v.slug}><VerticalRow v={v} /></li>)}</ul>}
      </Panel>
    </div>
  );
}

function VerticalRow({ v }: { v: VerticalStatus }) {
  const kinds = Object.entries(v.failureKinds ?? {}).sort((a, b) => b[1] - a[1]);
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <span className="block truncate text-body-m font-medium text-text-primary">{v.label}</span>
          <span className="block truncate font-mono text-[11px] text-text-tertiary">{v.slug}</span>
        </div>
        <span className="shrink-0 font-mono text-[13px] text-text-secondary tnum">{v.pct}%</span>
      </div>
      <StackedBar
        total={v.eligible}
        segments={[
          { value: v.captured, tone: 'success', label: 'captured' },
          { value: v.failed,   tone: 'error',   label: 'failed' },
          { value: v.pending,  tone: 'muted',   label: 'pending' },
        ]}
      />
      <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-text-tertiary tnum">
        <span><span className="text-text-secondary">{num(v.captured)}</span> / {num(v.eligible)} captured</span>
        {v.pending > 0 && <span>{num(v.pending)} pending</span>}
        {v.failed > 0 && <span className="text-tone-error">{num(v.failed)} failed</span>}
        {v.noWebsite > 0 && <span>{num(v.noWebsite)} no site</span>}
        {v.dead > 0 && <span>{num(v.dead)} dead</span>}
        {v.unqualified > 0 && <span>{num(v.unqualified)} unqualified</span>}
        {kinds.length > 0 && <span className="text-text-disabled">{kinds.map(([k, n]) => `${k} ${n}`).join(', ')}</span>}
      </div>
    </div>
  );
}

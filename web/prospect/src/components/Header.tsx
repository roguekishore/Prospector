import { KeyRound, X } from 'lucide-react';
import { Badge, Button, Dot } from '@ui/index';
import { cn } from '@ui/cn';
import { banner, clearBanner, conn, run, setToken } from '../data';

const CONN_LABEL: Record<string, string> = {
  idle: 'not connected', connecting: 'connecting…', live: 'live', reconnecting: 'reconnecting…', unauthorised: 'token needed', down: 'server unreachable',
};

/** Connection dot, the run state, and the error banner. Sticky on a phone. */
export function Header() {
  const c = conn.useValue();
  const r = run.useValue();
  const b = banner.useValue();

  const dotState = r.running ? 'run' : c === 'live' ? 'live' : c === 'unauthorised' || c === 'down' ? 'error' : 'off';
  const runText = r.running && r.state
    ? `${r.state.label}${r.state.totalSteps > 1 ? ` · ${r.state.stepIndex + 1}/${r.state.totalSteps} ${r.state.stepLabel}` : ''}`
    : r.lastExit
      ? `last: ${r.lastExit.code === 0 ? 'ok' : `exit ${r.lastExit.code ?? r.lastExit.signal ?? '?'}`} · ${r.lastExit.label}`
      : 'idle';

  return (
    <header className="sticky top-0 z-30 border-b border-line-structure bg-surface-bg/95 backdrop-blur-sm">
      <div className="mx-auto flex max-w-[1100px] flex-col gap-2 px-4 pb-2 pt-[calc(8px+env(safe-area-inset-top,0px))] sm:px-6">
        <div className="flex items-center gap-3">
          <a href="#progress" className="flex shrink-0 items-center gap-2" aria-label="Prospect — progress">
            <span aria-hidden className="grid size-6 place-items-center bg-text-primary font-serif text-[13px] font-medium leading-none text-surface-cta-primary">P</span>
            <span className="font-serif text-[15px] font-medium text-text-primary">Prospect</span>
          </a>
          <span className="flex items-center gap-1.5 text-label text-text-tertiary" aria-live="polite">
            <Dot state={dotState} label={`Connection: ${CONN_LABEL[c] ?? c}`} />
            <span>{CONN_LABEL[c] ?? c}</span>
          </span>
          <span className="flex-1" />
          <span className={cn('min-w-0 truncate text-right font-mono text-[11px]', r.running ? 'text-text-primary' : 'text-text-tertiary')} title={runText}>
            {runText}
          </span>
          {c !== 'unauthorised' && (
            <Button variant="text" size="sm" icon={<KeyRound />} aria-label="Change the token" title="Change the token" onClick={() => setToken(window.prompt('Control token') ?? '')} className="hidden sm:inline-flex" />
          )}
        </div>
        {b && (
          <div role="alert" className={cn('flex items-start gap-2 border px-3 py-2 text-body-s', b.tone === 'error' ? 'border-tone-error/60 bg-surface-bg text-text-primary' : 'border-tone-success/60 bg-surface-bg text-text-primary')}>
            <Badge tone={b.tone} className="mt-0.5 shrink-0">{b.tone === 'error' ? 'error' : 'done'}</Badge>
            <span className="min-w-0 flex-1 break-words">{b.text}</span>
            <Button variant="text" size="sm" icon={<X />} aria-label="Dismiss" onClick={clearBanner} className="-my-1 -mr-2 px-1.5" />
          </div>
        )}
      </div>
    </header>
  );
}

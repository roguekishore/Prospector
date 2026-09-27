import { useEffect, useRef, useState } from 'react';
import { ArrowDown, Eraser } from 'lucide-react';
import { Button, Panel } from '@ui/index';
import { cn } from '@ui/cn';
import { fmtTime } from '@ui/format';
import { MAX_LINES, clearLog, conn, lines } from '../data';

/**
 * The runner's last 500 lines, streamed. Sticks to the bottom while you are
 * there and stops following the moment you scroll up, with a way back down.
 */
export function Log() {
  const xs = lines.useValue();
  const c = conn.useValue();
  const box = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);

  useEffect(() => {
    const el = box.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [xs, follow]);

  function onScroll() {
    const el = box.current;
    if (!el) return;
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  }

  return (
    <Panel
      title="Live log"
      pad={false}
      actions={
        <>
          <span className="hidden font-mono text-[11px] text-text-tertiary tnum sm:inline">{xs.length} / {MAX_LINES}</span>
          <Button variant="text" size="sm" icon={<Eraser />} onClick={clearLog} disabled={xs.length === 0}>Clear</Button>
        </>
      }
    >
      <div className="relative">
        <div
          ref={box}
          onScroll={onScroll}
          role="log"
          aria-live="polite"
          aria-label="Runner output"
          className="h-[min(60vh,560px)] overflow-y-auto overflow-x-hidden bg-surface-code p-3 font-mono text-[11.5px] leading-[1.55] text-[#d6d6d0] [overflow-wrap:anywhere]"
        >
          {xs.length === 0 ? (
            <p className="text-[#7a7a74]">{c === 'live' ? 'Nothing yet. Lines appear here as soon as a run writes them.' : 'Waiting for the stream…'}</p>
          ) : xs.map((l, i) => (
            <div key={`${l.at}-${i}`} className={cn('flex gap-2 whitespace-pre-wrap', l.stream === 'err' && 'text-[#f0917a]', l.stream === 'sys' && 'text-[#a9b4f5]')}>
              <span className="hidden shrink-0 select-none text-[#6b6b66] sm:inline">{fmtTime(l.at)}</span>
              <span className="min-w-0">{l.line}</span>
            </div>
          ))}
        </div>
        {!follow && xs.length > 0 && (
          <Button variant="primary" size="sm" icon={<ArrowDown />} className="absolute bottom-3 right-3 shadow-ctl" onClick={() => { setFollow(true); const el = box.current; if (el) el.scrollTop = el.scrollHeight; }}>
            Latest
          </Button>
        )}
      </div>
      <p className="px-4 py-2 text-[11px] text-text-tertiary">Last {MAX_LINES} lines. Reconnects automatically.</p>
    </Panel>
  );
}

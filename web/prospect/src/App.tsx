import { useEffect, useMemo } from 'react';
import { Tabs, ToastProvider } from '@ui/index';
import { useHash } from '@ui/hooks';
import { boot, gated, lines, run } from './data';
import { Header } from './components/Header';
import { TokenGate } from './components/TokenGate';
import { Progress } from './views/Progress';
import { Run } from './views/Run';
import { NewVertical } from './views/NewVertical';
import { Log } from './views/Log';

type TabKey = 'progress' | 'run' | 'new' | 'log';
const TABS: TabKey[] = ['progress', 'run', 'new', 'log'];

export function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}

function Shell() {
  const hash = useHash();
  const tab = useMemo<TabKey>(() => {
    const k = hash.replace(/^#/, '') as TabKey;
    return TABS.includes(k) ? k : 'progress';
  }, [hash]);
  const g = gated.useValue();
  const r = run.useValue();
  const n = lines.useValue((xs) => xs.length);

  useEffect(() => { void boot(); }, []);
  useEffect(() => { document.title = `${r.running ? '● ' : ''}Prospect`; }, [r.running]);

  if (g) {
    return (<><Header /><TokenGate /></>);
  }

  return (
    <>
      <Header />
      <main className="mx-auto flex max-w-[1100px] flex-col gap-3 px-4 pb-[calc(24px+env(safe-area-inset-bottom,0px))] pt-3 sm:px-6">
        <Tabs
          ariaLabel="Sections"
          size="lg"
          className="w-full [&>button]:flex-1"
          value={tab}
          onChange={(t) => { window.location.hash = t; }}
          panelId="panel"
          items={[
            { value: 'progress', label: 'Progress' },
            { value: 'run', label: r.running ? <span className="inline-flex items-center gap-1.5">Run <span aria-hidden className="size-1.5 rounded-full bg-tone-info" /></span> : 'Run' },
            { value: 'new', label: <><span className="sm:hidden">New</span><span className="hidden sm:inline">New vertical</span></> },
            { value: 'log', label: 'Log', count: n || undefined },
          ]}
        />
        <section id="panel" role="tabpanel" aria-label={tab}>
          {tab === 'progress' && <Progress />}
          {tab === 'run' && <Run />}
          {tab === 'new' && <NewVertical />}
          {tab === 'log' && <Log />}
        </section>
      </main>
    </>
  );
}

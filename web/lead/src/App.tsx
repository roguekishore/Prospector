import { useCallback, useEffect, useMemo, useState } from 'react';
import { ToastProvider, useToast } from '@ui/Toast';
import { isTyping, modalOpen, useDocumentEvent, useHash } from '@ui/hooks';
import { setNotifier } from './data';
import { go, hrefOverview, parseHash } from './routes';
import { KeyHelp } from './components/KeyHelp';
import { Overview } from './views/Overview';
import { VerticalView } from './views/Vertical';
import { LeadView } from './views/Lead';

export function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}

function Shell() {
  const toast = useToast();
  useEffect(() => { setNotifier(toast); }, [toast]);

  const hash = useHash();
  const route = useMemo(() => parseHash(hash), [hash]);
  const [help, setHelp] = useState(false);
  const onHelp = useCallback(() => setHelp(true), []);

  // App-wide keys: `?` anywhere, Esc from a vertical back to the overview. The
  // lead view owns the rest of the map.
  useDocumentEvent('keydown', useCallback((ev: KeyboardEvent) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey || isTyping(ev.target) || ev.defaultPrevented) return;
    if (ev.key === '?' && !modalOpen()) { ev.preventDefault(); setHelp(true); return; }
    if (modalOpen()) return;
    if (ev.key === 'Escape' && route.view === 'vertical') { ev.preventDefault(); go(hrefOverview()); }
  }, [route.view]));

  useEffect(() => { window.scrollTo({ top: 0 }); }, [route.view, route.view === 'lead' ? route.id : route.view === 'vertical' ? route.ctx.slug + route.ctx.tab : '']);

  return (
    <>
      {route.view === 'overview' && <Overview onHelp={onHelp} />}
      {route.view === 'vertical' && <VerticalView key={`${route.ctx.slug}/${route.ctx.tab}`} ctx={route.ctx} onHelp={onHelp} />}
      {route.view === 'lead' && <LeadView id={route.id} ctx={route.ctx} onHelp={onHelp} />}
      <KeyHelp open={help} onClose={() => setHelp(false)} />
    </>
  );
}

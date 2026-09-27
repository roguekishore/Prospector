import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

/** The current `location.hash`, re-rendering on `hashchange`. */
export function useHash(): string {
  return useSyncExternalStore(
    (cb) => { window.addEventListener('hashchange', cb); return () => window.removeEventListener('hashchange', cb); },
    () => window.location.hash,
    () => '',
  );
}

/** `matchMedia` as state. */
export function useMediaQuery(query: string): boolean {
  const get = () => (typeof window !== 'undefined' && window.matchMedia(query).matches);
  const [on, setOn] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const fn = () => setOn(mq.matches);
    fn();
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, [query]);
  return on;
}

/** A document-level listener that always sees the latest handler. */
export function useDocumentEvent<K extends keyof DocumentEventMap>(
  type: K,
  handler: (ev: DocumentEventMap[K]) => void,
  options?: AddEventListenerOptions,
) {
  useEffect(() => {
    document.addEventListener(type, handler, options);
    return () => document.removeEventListener(type, handler, options);
  }, [type, handler, options]);
}

/** True while an input, textarea, select or contenteditable has focus. */
export function isTyping(target: EventTarget | null): boolean {
  const el = (target instanceof Element ? target : document.activeElement) as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/** A boolean with a stable toggler. */
export function useToggle(initial = false): [boolean, () => void, (v: boolean) => void] {
  const [on, setOn] = useState(initial);
  const toggle = useCallback(() => setOn((v) => !v), []);
  return [on, toggle, setOn];
}

/** True while a native `<dialog>` is showing — keys belong to it then. */
export function modalOpen(): boolean {
  return document.querySelector('dialog[open]') !== null;
}

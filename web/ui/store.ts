import { useSyncExternalStore } from 'react';

/**
 * The smallest possible external store: one value, `set`/`update`, and a hook
 * that re-renders on change. Both apps keep their fetched data here rather than
 * in component state so a view that unmounts (grid → detail → grid) comes back
 * to the pages it already had.
 */
export function createStore<T>(initial: T) {
  let value = initial;
  const subs = new Set<() => void>();
  const get = () => value;
  const set = (next: T) => {
    if (Object.is(next, value)) return;
    value = next;
    for (const fn of subs) fn();
  };
  const update = (fn: (v: T) => T) => set(fn(value));
  const subscribe = (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn); }; };
  function useValue(): T;
  function useValue<S>(selector: (v: T) => S): S;
  function useValue<S>(selector?: (v: T) => S) {
    return useSyncExternalStore(subscribe, () => (selector ? selector(value) : value), () => (selector ? selector(value) : value));
  }
  return { get, set, update, subscribe, useValue };
}

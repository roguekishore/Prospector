import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { cn } from './cn';
import type { Tone } from './Badge';

type ToastItem = { id: number; message: string; tone: Tone };
type ToastFn = (message: string, opts?: { tone?: Tone; ms?: number }) => void;

const Ctx = createContext<ToastFn>(() => {});

/** `const toast = useToast(); toast('not saved — …', { tone: 'error' })`. */
export function useToast(): ToastFn { return useContext(Ctx); }

const toneCls: Record<Tone, string> = {
  neutral: 'border-line-cta bg-text-primary text-text-on-primary',
  success: 'border-tone-success bg-text-primary text-text-on-primary',
  warning: 'border-tone-warning bg-text-primary text-text-on-primary',
  error:   'border-tone-error bg-tone-error text-white',
  info:    'border-tone-info bg-text-primary text-text-on-primary',
};

/** Bottom-centre, `role=status`, at most three at a time, each gone after 2.8 s. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const toast = useCallback<ToastFn>((message, opts) => {
    const id = ++seq.current;
    setItems((xs) => [...xs, { id, message, tone: opts?.tone ?? 'neutral' }].slice(-3));
    window.setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), opts?.ms ?? 2800);
  }, []);

  const value = useMemo(() => toast, [toast]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-[calc(16px+env(safe-area-inset-bottom,0px))] z-50 flex flex-col items-center gap-2 px-4"
      >
        {items.map((t) => (
          <div
            key={t.id}
            className={cn(
              'pointer-events-none max-w-[min(560px,100%)] rounded-ctl border px-3 py-2 text-body-s shadow-ctl',
              'animate-[toast-in_160ms_ease-out]',
              toneCls[t.tone],
            )}
          >
            {t.message}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

import { forwardRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from './cn';

/** Label above, control below, optional hint under. Ties `htmlFor` to the control's id. */
export function Field({ id, label, hint, children, className }: { id: string; label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-[11px] font-[450] uppercase tracking-[0.06em] text-text-tertiary">{label}</label>
      {children}
      {hint && <p className="text-[12px] leading-snug text-text-tertiary">{hint}</p>}
    </div>
  );
}

const control =
  'w-full rounded-ctl border border-line-structure bg-surface-bg text-text-secondary shadow-ctl ' +
  'placeholder:text-text-disabled transition-colors focus-visible:outline-none focus-visible:ring-1 ' +
  'focus-visible:ring-line-cta focus-visible:ring-offset-1 focus-visible:ring-offset-surface-bg ' +
  'disabled:cursor-not-allowed disabled:opacity-50 text-body-s';

type Size = 'sm' | 'lg';
const heights: Record<Size, string> = { sm: 'h-8 px-2', lg: 'h-11 px-3 text-[15px]' };

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { uiSize?: Size }>(
  function Input({ className, uiSize = 'sm', ...rest }, ref) {
    return <input ref={ref} className={cn(control, heights[uiSize], className)} {...rest} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { uiSize?: Size }>(
  function Select({ className, uiSize = 'sm', children, ...rest }, ref) {
    return (
      <select ref={ref} className={cn(control, heights[uiSize], 'appearance-none bg-no-repeat pr-8',
        "bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='none' stroke='%236b6b66' stroke-width='1.5'%3E%3Cpath d='m4 6 4 4 4-4'/%3E%3C/svg%3E\")] bg-[position:right_8px_center]",
        className)} {...rest}>
        {children}
      </select>
    );
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={cn(control, 'min-h-20 px-3 py-2 leading-snug resize-y', className)} {...rest} />;
  },
);

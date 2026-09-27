import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from './cn';
import { Button } from './Button';

/**
 * A modal on the native `<dialog>`: `showModal()` gives the focus trap, the
 * backdrop, Esc and `inert` outside for free. Closing by any route calls
 * `onClose`, so the parent's `open` state stays the truth.
 */
export function Dialog({ open, onClose, title, description, children, footer, className, wide }: {
  open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children?: ReactNode; footer?: ReactNode; className?: string; wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      aria-labelledby="dlg-title"
      className={cn(
        'corner-box m-auto w-[calc(100vw-32px)] border border-line-structure bg-surface-bg p-0 text-text-primary shadow-none',
        'backdrop:bg-black/40 backdrop:backdrop-blur-[2px] open:animate-[dlg-in_140ms_ease-out]',
        wide ? 'max-w-2xl' : 'max-w-md',
        className,
      )}
    >
      {open && (
        <div className="flex flex-col">
          <header className="flex items-start justify-between gap-4 border-b border-line-structure px-5 py-4">
            <div className="min-w-0">
              <h2 id="dlg-title" className="font-serif text-[19px] font-medium leading-tight">{title}</h2>
              {description && <p className="mt-1 text-body-s text-text-tertiary">{description}</p>}
            </div>
            <Button variant="text" size="sm" onClick={onClose} aria-label="Close" icon={<X />} className="-mr-2 -mt-1 px-1.5" />
          </header>
          {children && <div className="px-5 py-4 text-body-s text-text-secondary">{children}</div>}
          {footer && <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line-structure px-5 py-3">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}

/** A yes/no on top of `Dialog`. `danger` paints the confirm red (stop a run). */
export function ConfirmDialog({ open, onCancel, onConfirm, title, description, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger, busy, children }: {
  open: boolean; onCancel: () => void; onConfirm: () => void; title: ReactNode; description?: ReactNode; confirmLabel?: string; cancelLabel?: string; danger?: boolean; busy?: boolean; children?: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="text" size="md" onClick={onCancel} disabled={busy}>{cancelLabel}</Button>
          <Button variant={danger ? 'danger' : 'primary'} size="md" onClick={onConfirm} disabled={busy} autoFocus>{confirmLabel}</Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}

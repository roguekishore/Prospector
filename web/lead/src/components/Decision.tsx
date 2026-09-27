import { useEffect, useRef, useState, type RefObject } from 'react';
import { Pin } from 'lucide-react';
import { Button } from '@ui/Button';
import { Textarea } from '@ui/Field';
import { TierGroup, type Tier } from '@ui/TierGroup';
import { cn } from '@ui/cn';
import type { Row } from '../api';
import { saveDecision } from '../data';

const MAX_NOTE = 4000;

/** Tier and pitch for one row — the grid table and the detail share it. */
export function TierPitch({ row, size = 'sm', withKeycap, className }: { row: Row; size?: 'sm' | 'md' | 'lg'; withKeycap?: boolean; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <TierGroup
        value={row.tier}
        size={size}
        label={`Tier for ${row.name}`}
        onChange={(tier: Tier | null) => { void saveDecision(row.company_id, { tier }); }}
      />
      <Button
        variant="secondary"
        size={size === 'lg' ? 'lg' : size === 'md' ? 'md' : 'sm'}
        pressed={row.pitch}
        icon={<Pin />}
        keycap={withKeycap ? 'P' : undefined}
        aria-label={`${row.pitch ? 'Remove' : 'Mark'} ${row.name} ${row.pitch ? 'from' : 'for'} the pitch list`}
        onClick={() => { void saveDecision(row.company_id, { pitch: !row.pitch }); }}
      >
        Pitch
      </Button>
    </div>
  );
}

/**
 * The note. Saved on blur, not on every keystroke — one PUT per character would
 * be a write per keypress against a shared database. Esc blurs (the keyboard
 * handler does that); the counter appears near the 4,000 limit.
 */
export function NoteField({ row, inputRef }: { row: Row; inputRef?: RefObject<HTMLTextAreaElement | null> }) {
  const [text, setText] = useState(row.note ?? '');
  const local = useRef<HTMLTextAreaElement>(null);
  const ref = inputRef ?? local;

  // A new row, or a revert after a failed save, repaints the field.
  useEffect(() => { setText(row.note ?? ''); }, [row.company_id, row.note]);

  function commit() {
    const next = text.trim() ? text : null;
    if ((row.note ?? null) === next) return;
    void saveDecision(row.company_id, { note: next });
  }

  const id = `note-${row.company_id}`;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="flex items-center justify-between text-[11px] font-[450] uppercase tracking-[0.06em] text-text-tertiary">
        <span>Note</span>
        <span className="font-mono tnum" aria-live={text.length > MAX_NOTE - 200 ? 'polite' : 'off'}>
          {text.length > MAX_NOTE - 500 ? `${text.length} / ${MAX_NOTE}` : ''}
        </span>
      </label>
      <Textarea
        id={id}
        ref={ref}
        value={text}
        maxLength={MAX_NOTE}
        rows={4}
        placeholder="What you want to remember about this one"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        aria-keyshortcuts="N"
      />
    </div>
  );
}

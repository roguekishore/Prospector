import { Dialog } from '@ui/Dialog';
import { Keycap } from '@ui/Keycap';

const SECTIONS: Array<{ title: string; keys: Array<[keys: string[], what: string]> }> = [
  { title: 'Move', keys: [
    [['→', 'J'], 'Next lead in the current list — crosses pages'],
    [['←', 'K'], 'Previous lead'],
    [['U'], 'Next unreviewed lead'],
    [['Esc'], 'Back: lead → list → verticals; leaves the note when typing'],
  ] },
  { title: 'Decide', keys: [
    [['A', 'B', 'C', 'X'], 'Set the tier; the same key again clears it'],
    [['1', '2', '3', '4'], 'The same four tiers'],
    [['P'], 'Toggle the pitch mark'],
    [['N'], 'Write a note'],
  ] },
  { title: 'Look', keys: [
    [['D'], 'Desktop screenshot'],
    [['M'], 'Mobile screenshot'],
    [['O'], 'Open the live site in a new tab'],
    [['?'], 'This overlay'],
  ] },
];

/** The keyboard map, as an overlay. Every key here also has a button somewhere on the page. */
export function KeyHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard" description="Nothing fires while you are typing in a field, except Esc." wide>
      <div className="grid gap-5 sm:grid-cols-3">
        {SECTIONS.map((s) => (
          <section key={s.title}>
            <h3 className="mb-2 font-serif text-[15px] text-text-primary">{s.title}</h3>
            <dl className="flex flex-col gap-2">
              {s.keys.map(([keys, what]) => (
                <div key={what} className="flex items-start gap-2">
                  <dt className="flex shrink-0 gap-1">{keys.map((k) => <Keycap key={k}>{k}</Keycap>)}</dt>
                  <dd className="text-[13px] leading-snug text-text-secondary">{what}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}

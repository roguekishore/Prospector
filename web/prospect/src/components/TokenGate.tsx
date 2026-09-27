import { useState, type FormEvent } from 'react';
import { KeyRound } from 'lucide-react';
import { Button, Field, Input, Panel } from '@ui/index';
import { conn, setToken, token } from '../data';

/**
 * The 401 state. Not an empty page: it says what is missing and takes the
 * token right here, saving it for next time.
 */
export function TokenGate() {
  const current = token.useValue();
  const c = conn.useValue();
  const [value, setValue] = useState('');

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!value.trim()) return;
    setToken(value);
    setValue('');
  }

  return (
    <main className="mx-auto flex max-w-[480px] flex-col gap-4 px-4 py-10 sm:px-6">
      <Panel title={<span className="inline-flex items-center gap-2"><KeyRound aria-hidden className="size-4" /> Token needed</span>}>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <p className="text-body-s text-text-secondary">
            {current
              ? 'That token was refused. This panel can start runs and spend Places quota, so it will not show anything without the right one.'
              : 'This panel can start runs and spend Places quota, so it needs the control token. Paste it here, or open the link that has ?token= in it.'}
          </p>
          <Field id="token" label="Control token" hint="Kept in this browser only, as pc.token.">
            <Input id="token" uiSize="lg" type="password" autoComplete="off" autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder="CONTROL_TOKEN" />
          </Field>
          <Button type="submit" variant="cta" size="lg" full disabled={!value.trim() || c === 'connecting'}>
            {c === 'connecting' ? 'Checking…' : 'Use this token'}
          </Button>
        </form>
      </Panel>
    </main>
  );
}

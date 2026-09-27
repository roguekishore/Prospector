import { useEffect, useState } from 'react';
import { ImageOff, Globe } from 'lucide-react';
import { cn } from '@ui/cn';
import { shotUrl } from '../api';

/**
 * One screenshot, with an honest placeholder when there is none: a row with no
 * domain was never captured, and a row whose capture lives on another box
 * (or failed) gets a 404 from `/shots/`. Both are stated, not hidden.
 */
export function Shot({ domain, kind, name, className, imgClassName, eager, style }: {
  domain: string | null; kind: 'mobile' | 'desktop'; name: string; className?: string; imgClassName?: string; eager?: boolean; style?: React.CSSProperties;
}) {
  const [failed, setFailed] = useState(false);
  const src = domain ? shotUrl(domain, kind) : null;
  useEffect(() => { setFailed(false); }, [src]);

  if (!src || failed) {
    return (
      <div role="img" aria-label={domain ? `No ${kind} screenshot available for ${name}` : `${name} has no website`}
        className={cn('stripes flex flex-col items-center justify-center gap-1.5 text-text-tertiary', className)} style={style}>
        {domain ? <ImageOff aria-hidden className="size-5" /> : <Globe aria-hidden className="size-5" />}
        <span className="text-label">{domain ? 'No capture here' : 'No website'}</span>
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={`${kind === 'mobile' ? 'Mobile' : 'Desktop'} screenshot of ${name}`}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      onError={() => setFailed(true)}
      className={cn(className, imgClassName)}
      style={style}
    />
  );
}

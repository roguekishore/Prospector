import { forwardRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from './cn';
import { Keycap } from './Keycap';

export type ButtonVariant = 'primary' | 'cta' | 'secondary' | 'text' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

type Common = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** A key name shown as a keycap at the end; also sets `aria-keyshortcuts`. */
  keycap?: string;
  icon?: ReactNode;
  iconEnd?: ReactNode;
  /** Sets `aria-pressed` and the pressed look — for toggles. */
  pressed?: boolean;
  full?: boolean;
  className?: string;
  children?: ReactNode;
};

export type ButtonProps = Common & ButtonHTMLAttributes<HTMLButtonElement> & { href?: undefined };
export type LinkButtonProps = Common & AnchorHTMLAttributes<HTMLAnchorElement> & { href: string };

const base =
  'inline-flex items-center justify-center gap-1.5 rounded-ctl border whitespace-nowrap select-none ' +
  'text-label font-[450] tracking-[-0.06px] leading-none transition-colors cursor-pointer ' +
  'disabled:opacity-50 disabled:pointer-events-none aria-disabled:opacity-50 aria-disabled:pointer-events-none ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-line-cta';

const sizes: Record<ButtonSize, string> = {
  sm: 'h-[26px] px-2',
  md: 'h-8 px-2.5',
  lg: 'h-11 px-3.5 text-body-s',
};

const variants: Record<ButtonVariant, string> = {
  primary:   'bg-text-primary text-text-on-primary border-text-secondary shadow-ctl hover:bg-text-secondary',
  cta:       'bg-surface-cta-primary text-text-primary border-line-cta shadow-ctl hover:brightness-[.97]',
  secondary: 'bg-surface-bg text-text-secondary border-line-structure shadow-ctl hover:border-line-cta hover:text-text-primary',
  text:      'bg-transparent text-text-secondary border-transparent hover:text-text-primary hover:bg-surface-button-grey',
  danger:    'bg-surface-bg text-tone-error border-tone-error/60 shadow-ctl hover:bg-tone-error hover:text-white hover:border-tone-error',
};

const pressedCls = 'aria-pressed:bg-text-primary aria-pressed:text-text-on-primary aria-pressed:border-text-primary aria-pressed:shadow-none';

function classes(p: Common) {
  return cn(base, sizes[p.size ?? 'sm'], variants[p.variant ?? 'secondary'], pressedCls, p.full && 'w-full', p.className);
}

function Inner({ icon, iconEnd, keycap, children, variant, pressed }: Common) {
  const invert = variant === 'primary' || pressed === true;
  return (
    <>
      {icon && <span aria-hidden className="inline-flex shrink-0 items-center [&_svg]:size-3.5">{icon}</span>}
      {children !== undefined && children !== null && children !== false && (
        <span className="min-w-0 truncate">{children}</span>
      )}
      {iconEnd && <span aria-hidden className="inline-flex shrink-0 items-center [&_svg]:size-3.5">{iconEnd}</span>}
      {keycap && <Keycap invert={invert} className="-mr-1">{keycap}</Keycap>}
    </>
  );
}

/**
 * The button. Renders an `<a>` when given `href`, a `<button type=button>`
 * otherwise. Variants follow langfuse: `primary` dark fill, `cta` the one
 * yellow, `secondary` bordered, `text` bare, `danger` for stop.
 */
export const Button = forwardRef<HTMLButtonElement | HTMLAnchorElement, ButtonProps | LinkButtonProps>(
  function Button(props, ref) {
    const { variant, size, keycap, icon, iconEnd, pressed, full, className, children, ...rest } = props;
    const common: Common = { variant, size, keycap, icon, iconEnd, pressed, full, className, children };
    const ks = keycap ? keycap : undefined;
    if ('href' in rest && typeof rest.href === 'string') {
      const a = rest as AnchorHTMLAttributes<HTMLAnchorElement>;
      return (
        <a ref={ref as never} className={classes(common)} aria-keyshortcuts={ks} {...a}>
          <Inner {...common} />
        </a>
      );
    }
    const b = rest as ButtonHTMLAttributes<HTMLButtonElement>;
    return (
      <button
        ref={ref as never}
        type={b.type ?? 'button'}
        className={classes(common)}
        aria-pressed={pressed === undefined ? undefined : pressed}
        aria-keyshortcuts={ks}
        {...b}
      >
        <Inner {...common} />
      </button>
    );
  },
);

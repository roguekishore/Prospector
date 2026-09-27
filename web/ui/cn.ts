import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge Tailwind class lists, last one wins — the `cn()` every shadcn-style component uses. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

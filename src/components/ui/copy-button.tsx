'use client';

import { Check, Copy } from 'lucide-react';
import * as React from 'react';

import { cn } from '@/lib/cn';
import { Button, type ButtonProps } from './button';

const RESET_MS = 2000;

export interface CopyButtonProps extends Omit<
  ButtonProps,
  'value' | 'children' | 'asChild' | 'loading'
> {
  /** The exact text placed on the clipboard. */
  value: string;
  /** Accessible name in the idle state. */
  label?: string;
  /** Accessible name once the copy succeeded. */
  copiedLabel?: string;
  /** Show the label next to the icon instead of only to screen readers. */
  showLabel?: boolean;
  /** Notified after a successful write, e.g. to raise a toast. */
  onCopied?: (value: string) => void;
}

/**
 * `navigator.clipboard` is unavailable on insecure origins and in some
 * embedded webviews, so the write is guarded and failures leave the button in
 * its idle state rather than lying with a checkmark. The confirmation is
 * announced through a live region because a colour/icon swap alone is not
 * perceivable to every user.
 */
export function CopyButton({
  value,
  label = 'Copy to clipboard',
  copiedLabel = 'Copied',
  showLabel = false,
  onCopied,
  className,
  variant = 'ghost',
  size,
  onClick,
  ...props
}: CopyButtonProps) {
  const [copied, setCopied] = React.useState(false);
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleClick = React.useCallback(
    async (event: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(event);
      if (event.defaultPrevented) return;

      try {
        await navigator.clipboard.writeText(value);
      } catch {
        // Clipboard denied or unavailable. Say nothing rather than claim success.
        return;
      }

      setCopied(true);
      onCopied?.(value);
      if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), RESET_MS);
    },
    [onClick, onCopied, value],
  );

  const currentLabel = copied ? copiedLabel : label;

  return (
    <Button
      type="button"
      variant={variant}
      size={size ?? (showLabel ? 'sm' : 'icon')}
      aria-label={currentLabel}
      data-state={copied ? 'copied' : 'idle'}
      onClick={handleClick}
      className={cn(copied && 'text-jade', className)}
      {...props}
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {showLabel ? <span aria-hidden="true">{currentLabel}</span> : null}
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? copiedLabel : ''}
      </span>
    </Button>
  );
}

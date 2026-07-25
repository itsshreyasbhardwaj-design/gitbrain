import { cn } from '@/lib/cn';

/**
 * The GitBrain mark: a node-link glyph.
 *
 * Drawn rather than imported so it inherits `currentColor`, scales without a
 * raster asset, and costs no network request.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cn('size-6', className)}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path
        d="M12 4.2 5.6 7.9v7.4L12 19l6.4-3.7V7.9L12 4.2Z"
        stroke="currentColor"
        strokeWidth="1.4"
        opacity="0.35"
      />
      <path
        d="M12 4.2v5.3m0 0 4.6 2.6M12 9.5l-4.6 2.6m4.6 2.6V19"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <circle cx="12" cy="9.5" r="2.1" fill="currentColor" />
      <circle cx="7.4" cy="12.1" r="1.5" fill="currentColor" opacity="0.75" />
      <circle cx="16.6" cy="12.1" r="1.5" fill="currentColor" opacity="0.75" />
      <circle cx="12" cy="19" r="1.5" fill="currentColor" opacity="0.55" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-center gap-2', className)}>
      <Logo className="text-jade size-6" />
      <span className="text-ink text-[15px] font-semibold tracking-tight">GitBrain</span>
    </span>
  );
}

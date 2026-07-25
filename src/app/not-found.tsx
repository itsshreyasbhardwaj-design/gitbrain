import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center px-4 py-32 text-center">
      <p className="text-jade font-mono text-sm">404</p>
      <h1 className="text-title text-ink mt-3">This analysis is not available</h1>
      <p className="text-ink-muted mt-3 text-sm leading-relaxed">
        Analyses are held in memory unless durable storage is configured, so a link can expire after
        a server restart. Running the analysis again takes a few seconds.
      </p>
      <Link
        href="/"
        className="bg-jade text-canvas mt-7 rounded-lg px-4 py-2 text-sm font-medium transition-opacity hover:opacity-90"
      >
        Analyze a repository
      </Link>
    </div>
  );
}

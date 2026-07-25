import { Wordmark } from '@/components/logo';

const REPOSITORY_URL = 'https://github.com/itsshreyasbhardwaj-design/gitbrain';

export function SiteFooter() {
  return (
    <footer className="border-line mt-24 border-t">
      <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
        <div className="flex flex-col gap-1">
          <Wordmark />
          <p className="text-ink-faint text-xs">
            Open source under the MIT licence. Runs entirely on your own infrastructure.
          </p>
        </div>

        <nav className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs" aria-label="Footer">
          <a
            href={REPOSITORY_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="text-ink-subtle hover:text-ink transition-colors"
          >
            Source
          </a>
          <a
            href={`${REPOSITORY_URL}/blob/main/CONTRIBUTING.md`}
            target="_blank"
            rel="noreferrer noopener"
            className="text-ink-subtle hover:text-ink transition-colors"
          >
            Contributing
          </a>
          <a
            href={`${REPOSITORY_URL}/issues/new/choose`}
            target="_blank"
            rel="noreferrer noopener"
            className="text-ink-subtle hover:text-ink transition-colors"
          >
            Report an issue
          </a>
          <a
            href={`${REPOSITORY_URL}/blob/main/LICENSE`}
            target="_blank"
            rel="noreferrer noopener"
            className="text-ink-subtle hover:text-ink transition-colors"
          >
            MIT
          </a>
        </nav>
      </div>
    </footer>
  );
}

'use client';

import { Highlight, type Language, type PrismTheme } from 'prism-react-renderer';

import { CopyButton } from '@/components/ui/copy-button';
import { cn } from '@/lib/cn';

/**
 * Syntax theme built from our design tokens.
 *
 * Prism needs concrete colour values rather than CSS variables, so the palette
 * is mirrored here. Keep it in sync with `globals.css` if the accent changes.
 */
const THEME: PrismTheme = {
  plain: { color: '#e8eaed', backgroundColor: 'transparent' },
  styles: [
    {
      types: ['comment', 'prolog', 'doctype', 'cdata'],
      style: { color: '#6b7280', fontStyle: 'italic' },
    },
    { types: ['punctuation'], style: { color: '#9ca3af' } },
    { types: ['property', 'tag', 'constant', 'symbol', 'deleted'], style: { color: '#f0a3a3' } },
    { types: ['boolean', 'number'], style: { color: '#d8b4fe' } },
    {
      types: ['selector', 'attr-name', 'string', 'char', 'builtin', 'inserted'],
      style: { color: '#7fdba8' },
    },
    { types: ['operator', 'entity', 'url'], style: { color: '#93c5fd' } },
    { types: ['atrule', 'attr-value', 'keyword'], style: { color: '#7dd3fc' } },
    { types: ['function', 'class-name'], style: { color: '#fcd34d' } },
    { types: ['regex', 'important', 'variable'], style: { color: '#fdba74' } },
  ],
};

/** Prism language aliases for names our detector produces. */
const LANGUAGE_ALIASES: Record<string, string> = {
  typescript: 'tsx',
  javascript: 'jsx',
  'c++': 'cpp',
  'c#': 'csharp',
  shell: 'bash',
  dockerfile: 'docker',
  'protocol buffers': 'protobuf',
  markdown: 'markdown',
  other: 'text',
  text: 'text',
};

function normalizeLanguage(language: string | undefined): Language {
  const key = (language ?? '').toLowerCase().trim();
  return ((LANGUAGE_ALIASES[key] ?? key) || 'text') as Language;
}

export interface CodeBlockProps {
  code: string;
  language?: string;
  /** Line number the first rendered line corresponds to in the source file. */
  startLine?: number;
  /** Path shown in the header; also enables the header row. */
  filename?: string;
  showLineNumbers?: boolean;
  className?: string;
  /** Caps rendered height; the block scrolls beyond it. */
  maxHeight?: string;
}

export function CodeBlock({
  code,
  language,
  startLine = 1,
  filename,
  showLineNumbers = true,
  className,
  maxHeight = '28rem',
}: CodeBlockProps) {
  const trimmed = code.replace(/\n+$/, '');

  return (
    <div
      className={cn('border-line bg-canvas-raised overflow-hidden rounded-lg border', className)}
    >
      {filename && (
        <div className="border-line flex items-center justify-between gap-2 border-b px-3 py-1.5">
          <span className="text-ink-subtle truncate font-mono text-[11px]" title={filename}>
            {filename}
          </span>
          <CopyButton value={trimmed} className="shrink-0" />
        </div>
      )}

      <Highlight theme={THEME} code={trimmed} language={normalizeLanguage(language)}>
        {({ className: preClass, style, tokens, getLineProps, getTokenProps }) => (
          <pre
            className={cn(preClass, 'overflow-auto p-3 font-mono text-[12.5px] leading-[1.65]')}
            style={{ ...style, maxHeight }}
            tabIndex={0}
          >
            <code>
              {tokens.map((line, index) => {
                const lineProps = getLineProps({ line });
                return (
                  <div key={index} {...lineProps} className={cn(lineProps.className, 'table-row')}>
                    {showLineNumbers && (
                      <span
                        className="text-ink-faint/60 table-cell pr-4 text-right tabular-nums select-none"
                        aria-hidden="true"
                      >
                        {startLine + index}
                      </span>
                    )}
                    <span className="table-cell whitespace-pre-wrap">
                      {line.map((token, key) => (
                        <span key={key} {...getTokenProps({ token })} />
                      ))}
                    </span>
                  </div>
                );
              })}
            </code>
          </pre>
        )}
      </Highlight>
    </div>
  );
}

'use client';

import Link from 'next/link';
import { createElement, useMemo, type ComponentPropsWithoutRef } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';

import { CodeBlock } from '@/components/code-block';
import { Mermaid } from '@/components/mermaid';
import { cn } from '@/lib/cn';

/**
 * Sanitization schema.
 *
 * Markdown here is generated from repository contents, and repository contents
 * are untrusted input — a README can contain anything. Starting from
 * `rehype-sanitize`'s allowlist and adding only what we need means a new
 * element is denied by default rather than permitted by oversight.
 */
const SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), ['className', /^language-./]],
    span: [...(defaultSchema.attributes?.span ?? []), ['className', /^(hljs|token)-?/]],
    a: [...(defaultSchema.attributes?.a ?? []), 'target', 'rel'],
  },
  // No <img> from generated content: it would leak the reader's IP to whatever
  // host a README references, and none of our documents need images.
  tagNames: (defaultSchema.tagNames ?? []).filter((tag) => tag !== 'img'),
};

/** Extract plain text from a React children tree, for code block contents. */
function childrenToText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(childrenToText).join('');
  if (typeof node === 'object' && 'props' in node) {
    const props = (node as { props?: { children?: React.ReactNode } }).props;
    return childrenToText(props?.children);
  }
  return '';
}

export interface MarkdownProps {
  children: string;
  className?: string;
  /**
   * Turns `path/to/file.ts:42` references into links into the file viewer.
   * Supplied by report pages; omitted in chat, where citations render as chips.
   */
  fileHref?: (path: string, line?: number) => string;
  /**
   * How far to demote generated headings, so the page keeps one valid outline.
   *
   * Generated documents start at `# Title`, but they are always embedded inside
   * a page that already owns the `<h1>` (the repository name). Rendering them
   * verbatim produces two `<h1>`s and a broken heading hierarchy for screen
   * readers. Default 1 demotes `#` to `<h2>`; pass 0 only if this Markdown is
   * genuinely the top level of its page.
   */
  headingOffset?: number;
}

/** Visual weight per rendered heading level, independent of the tag used. */
const HEADING_CLASS: Record<number, string> = {
  1: 'mt-8 mb-3 text-2xl font-semibold tracking-tight text-ink',
  2: 'mt-8 mb-3 text-lg font-semibold tracking-tight text-ink',
  3: 'mt-6 mb-2 text-[15px] font-semibold text-ink',
  4: 'mt-5 mb-2 text-sm font-semibold text-ink',
  5: 'mt-4 mb-1.5 text-sm font-medium text-ink-muted',
  6: 'mt-4 mb-1.5 text-xs font-medium tracking-wide uppercase text-ink-faint',
};

export function Markdown({ children, className, fileHref, headingOffset = 1 }: MarkdownProps) {
  const components = useMemo(
    () => ({
      ...headingComponents(headingOffset),
      code({
        className: codeClass,
        children: codeChildren,
        ...props
      }: ComponentPropsWithoutRef<'code'>) {
        const match = /language-(\w+)/.exec(codeClass ?? '');
        const text = childrenToText(codeChildren);

        // Inline code: no language class and no newline.
        if (!match && !text.includes('\n')) {
          const inline = text.trim();
          const reference = fileHref ? parseFileReference(inline) : null;

          if (reference && fileHref) {
            return (
              <Link
                href={fileHref(reference.path, reference.line)}
                className="border-line bg-surface text-jade-200 hover:border-jade/40 hover:text-jade rounded border px-1 py-0.5 font-mono text-[0.85em] transition-colors"
              >
                {inline}
              </Link>
            );
          }

          return (
            <code
              className="border-line bg-surface text-ink rounded border px-1 py-0.5 font-mono text-[0.85em]"
              {...props}
            >
              {codeChildren}
            </code>
          );
        }

        const language = match?.[1] ?? 'text';
        if (language === 'mermaid') return <Mermaid chart={text.trim()} className="my-4" />;

        return (
          <CodeBlock code={text} language={language} showLineNumbers={false} className="my-4" />
        );
      },

      // `code` already renders its own container; a wrapping <pre> would nest
      // a block element inside a paragraph-level element and break layout.
      pre({ children: preChildren }: ComponentPropsWithoutRef<'pre'>) {
        return <>{preChildren}</>;
      },

      a({ href, children: linkChildren, ...props }: ComponentPropsWithoutRef<'a'>) {
        const external = href?.startsWith('http');
        return (
          <a
            href={href}
            className="text-jade decoration-jade/30 hover:decoration-jade underline underline-offset-2 transition-colors"
            {...(external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
            {...props}
          >
            {linkChildren}
          </a>
        );
      },

      table({ children: tableChildren }: ComponentPropsWithoutRef<'table'>) {
        return (
          <div className="border-line my-4 overflow-x-auto rounded-lg border">
            <table className="w-full border-collapse text-sm">{tableChildren}</table>
          </div>
        );
      },
      th({ children: thChildren }: ComponentPropsWithoutRef<'th'>) {
        return (
          <th className="border-line bg-surface/60 text-ink-muted border-b px-3 py-2 text-left font-medium">
            {thChildren}
          </th>
        );
      },
      td({ children: tdChildren }: ComponentPropsWithoutRef<'td'>) {
        return (
          <td className="border-line/60 text-ink-muted border-b px-3 py-2 align-top">
            {tdChildren}
          </td>
        );
      },
    }),
    [fileHref, headingOffset],
  );

  return (
    <div
      className={cn(
        'text-ink-muted text-[15px] leading-[1.7]',
        '[&>p]:my-3',
        '[&>ul]:my-3 [&>ul]:list-disc [&>ul]:space-y-1.5 [&>ul]:pl-5',
        '[&>ol]:my-3 [&>ol]:list-decimal [&>ol]:space-y-1.5 [&>ol]:pl-5',
        '[&_li::marker]:text-ink-faint',
        '[&>blockquote]:border-jade/40 [&>blockquote]:text-ink-subtle [&>blockquote]:my-4 [&>blockquote]:border-l-2 [&>blockquote]:pl-4',
        '[&>hr]:border-line [&>hr]:my-8',
        '[&_strong]:text-ink [&_strong]:font-semibold',
        '[&:first-child>*:first-child]:mt-0',
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, SCHEMA]]}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Build heading renderers that demote each level by `offset`.
 *
 * Levels are clamped at 6, so a deeply nested generated document degrades to
 * repeated `<h6>`s rather than emitting an invalid `<h7>`. Visual weight is
 * driven by the *source* level, so a demoted `#` still reads as the document's
 * title even though it is an `<h2>` in the outline.
 */
function headingComponents(offset: number) {
  const levels = [1, 2, 3, 4, 5, 6] as const;

  return Object.fromEntries(
    levels.map((level) => {
      const rendered = Math.min(6, Math.max(1, level + offset));
      // `createElement` with a computed tag, because JSX cannot take a
      // dynamically built intrinsic element name.
      const Heading = ({ children, ...props }: ComponentPropsWithoutRef<'h1'>) =>
        createElement(
          `h${rendered}`,
          { className: HEADING_CLASS[level] ?? HEADING_CLASS[6], ...props },
          children,
        );
      Heading.displayName = `MarkdownHeading${level}`;

      return [`h${level}`, Heading];
    }),
  );
}

/** Recognise `src/auth/session.ts:42` inside inline code. */
function parseFileReference(text: string): { path: string; line?: number } | null {
  const match = /^([\w./@-]+\.[a-zA-Z0-9]+)(?::(\d+))?$/.exec(text);
  if (!match?.[1] || !match[1].includes('.')) return null;
  const line = match[2] ? Number(match[2]) : undefined;
  return line === undefined ? { path: match[1] } : { path: match[1], line };
}

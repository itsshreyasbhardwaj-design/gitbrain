import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';

import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
  display: 'swap',
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
  display: 'swap',
});

const description =
  'Paste any public GitHub repository and get an interactive knowledge base: architecture, ' +
  'dependency graph, health score, security scan, and a codebase you can ask questions.';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'),
  title: {
    default: 'GitBrain — Understand any codebase in minutes',
    template: '%s · GitBrain',
  },
  description,
  applicationName: 'GitBrain',
  keywords: [
    'code analysis',
    'repository intelligence',
    'codebase onboarding',
    'dependency graph',
    'static analysis',
    'developer tools',
  ],
  authors: [{ name: 'GitBrain contributors' }],
  openGraph: {
    type: 'website',
    title: 'GitBrain — Understand any codebase in minutes',
    description,
    siteName: 'GitBrain',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'GitBrain — Understand any codebase in minutes',
    description,
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: '#0b0d10',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        {/* Keyboard users must be able to skip the nav on every page. */}
        <a
          href="#main"
          className="focus:bg-jade focus:text-canvas sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:rounded-lg focus:px-4 focus:py-2 focus:font-medium"
        >
          Skip to content
        </a>
        <SiteHeader />
        <main id="main" className="flex-1">
          {children}
        </main>
        <SiteFooter />
      </body>
    </html>
  );
}

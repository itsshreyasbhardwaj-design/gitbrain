'use client';

import { motion } from 'framer-motion';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  BookOpen,
  Gauge,
  LayoutDashboard,
  MessagesSquare,
  Network,
  Search,
  ShieldAlert,
} from 'lucide-react';

import { cn } from '@/lib/cn';

const TABS = [
  { segment: '', label: 'Overview', icon: LayoutDashboard },
  { segment: 'knowledge', label: 'Knowledge', icon: BookOpen },
  { segment: 'graph', label: 'Code graph', icon: Network },
  { segment: 'health', label: 'Health', icon: Gauge },
  { segment: 'security', label: 'Security', icon: ShieldAlert },
  { segment: 'search', label: 'Search', icon: Search },
  { segment: 'chat', label: 'Ask', icon: MessagesSquare },
] as const;

/**
 * Report navigation.
 *
 * Real links rather than client-side tab state: each tab is its own route
 * segment, so the browser back button, deep links and "open in new tab" all
 * behave the way a user expects. The sliding indicator is decorative only.
 */
export function ReportTabs({ id }: { id: string }) {
  const pathname = usePathname();
  const base = `/r/${id}`;
  const active = pathname === base ? '' : (pathname.slice(base.length + 1).split('/')[0] ?? '');

  return (
    <nav className="-mx-4 mt-7 overflow-x-auto px-4 sm:mx-0 sm:px-0" aria-label="Report sections">
      <div className="border-line flex min-w-max gap-1 border-b pb-px">
        {TABS.map((tab) => {
          const href = tab.segment ? `${base}/${tab.segment}` : base;
          const isActive = active === tab.segment;

          return (
            <Link
              key={tab.segment || 'overview'}
              href={href}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'relative flex items-center gap-1.5 rounded-t-md px-3 py-2.5 text-sm whitespace-nowrap transition-colors',
                isActive ? 'text-ink' : 'text-ink-subtle hover:text-ink-muted',
              )}
            >
              <tab.icon className="size-4" aria-hidden="true" />
              {tab.label}
              {isActive && (
                <motion.span
                  layoutId="report-tab-underline"
                  className="bg-jade absolute inset-x-1 -bottom-px h-0.5 rounded-full"
                  transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                />
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

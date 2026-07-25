'use client';

import { hierarchy, treemap, type HierarchyRectangularNode } from 'd3-hierarchy';
import { ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { TreeNode } from '@/core/types';
import { languageColor } from '@/core/shared/languages';
import { formatBytes, formatCount } from '@/features/report/grade';
import { cn } from '@/lib/cn';

const HEIGHT = 460;
/** Below this area a label cannot be read, so it is omitted rather than clipped. */
const MIN_LABEL_AREA = 2400;

interface Datum {
  name: string;
  path: string;
  type: 'dir' | 'file';
  size: number;
  fileCount: number;
  language?: string | undefined;
  children?: Datum[];
}

function toDatum(node: TreeNode): Datum {
  return {
    name: node.name || '/',
    path: node.path,
    type: node.type,
    size: node.size,
    fileCount: node.fileCount,
    language: node.language,
    ...(node.children ? { children: node.children.map(toDatum) } : {}),
  };
}

/** Walk to the node at `path`, or fall back to the root. */
function findNode(root: Datum, path: string): Datum {
  if (!path) return root;
  const stack: Datum[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (current.path === path) return current;
    if (current.children) stack.push(...current.children);
  }
  return root;
}

export function TreeMap({ tree }: { tree: TreeNode }) {
  const root = useMemo(() => toDatum(tree), [tree]);
  const [zoomPath, setZoomPath] = useState('');
  const [hovered, setHovered] = useState<Datum | null>(null);
  const [width, setWidth] = useState(900);
  const containerRef = useRef<HTMLDivElement>(null);

  // The SVG is laid out in pixel space, so it has to know its real width.
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(Math.max(320, entry.contentRect.width));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const focused = useMemo(() => findNode(root, zoomPath), [root, zoomPath]);

  const cells = useMemo(() => {
    // `sum` counts only leaves, so directory sizes are derived rather than
    // double-counted against the files they contain.
    const laid = hierarchy<Datum>(focused, (node) => node.children)
      .sum((node) => (node.children && node.children.length > 0 ? 0 : Math.max(node.size, 1)))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

    treemap<Datum>().size([width, HEIGHT]).paddingInner(2).paddingTop(0).round(true)(laid);

    return (laid.leaves() as HierarchyRectangularNode<Datum>[]).filter(
      (leaf) => leaf.x1 - leaf.x0 > 1 && leaf.y1 - leaf.y0 > 1,
    );
  }, [focused, width]);

  const breadcrumbs = useMemo(() => {
    const crumbs: { name: string; path: string }[] = [{ name: 'Repository', path: '' }];
    if (!zoomPath) return crumbs;

    let accumulated = '';
    for (const segment of zoomPath.split('/')) {
      accumulated = accumulated ? `${accumulated}/${segment}` : segment;
      crumbs.push({ name: segment, path: accumulated });
    }
    return crumbs;
  }, [zoomPath]);

  const zoomInto = useCallback((datum: Datum) => {
    // Only directories can be zoomed; a file is already a leaf.
    if (datum.type === 'dir' && datum.path) setZoomPath(datum.path);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && zoomPath) setZoomPath('');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomPath]);

  if (cells.length === 0) {
    return (
      <p className="text-ink-subtle mt-6 text-sm">This repository has no files to visualise.</p>
    );
  }

  return (
    <div className="mt-6">
      <nav className="flex flex-wrap items-center gap-1 text-xs" aria-label="Treemap location">
        {breadcrumbs.map((crumb, index) => (
          <span key={crumb.path} className="flex items-center gap-1">
            {index > 0 && <ChevronRight className="text-ink-faint size-3" aria-hidden="true" />}
            <button
              type="button"
              onClick={() => setZoomPath(crumb.path)}
              disabled={index === breadcrumbs.length - 1}
              className={cn(
                'rounded px-1 py-0.5 font-mono transition-colors',
                index === breadcrumbs.length - 1 ? 'text-ink' : 'text-ink-subtle hover:text-jade',
              )}
            >
              {crumb.name}
            </button>
          </span>
        ))}
      </nav>

      <div ref={containerRef} className="glass rounded-panel relative mt-3 overflow-hidden p-2">
        <svg
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          role="img"
          aria-label={`Treemap of ${focused.path || 'the repository'}: ${cells.length} files sized by bytes`}
          className="max-w-full"
        >
          {cells.map((leaf) => {
            const cellWidth = leaf.x1 - leaf.x0;
            const cellHeight = leaf.y1 - leaf.y0;
            const datum = leaf.data;
            // A leaf's colour follows its own language, or its parent's when a
            // directory was collapsed into a single cell.
            const color = languageColor(datum.language ?? leaf.parent?.data.language ?? '');
            const zoomTarget = leaf.parent?.data ?? focused;
            const canZoom = zoomTarget.type === 'dir' && Boolean(zoomTarget.path);

            return (
              <g key={datum.path || `${leaf.x0}-${leaf.y0}`}>
                <rect
                  x={leaf.x0}
                  y={leaf.y0}
                  width={cellWidth}
                  height={cellHeight}
                  rx={2}
                  fill={color}
                  fillOpacity={hovered?.path === datum.path ? 0.85 : 0.55}
                  stroke="var(--color-canvas)"
                  strokeWidth={1}
                  tabIndex={0}
                  role="button"
                  aria-label={`${datum.path}, ${formatBytes(datum.size)}${canZoom ? `. Press Enter to zoom into ${zoomTarget.name}` : ''}`}
                  className="focus:outline-jade cursor-pointer transition-[fill-opacity] duration-150 focus:outline-2 focus:outline-offset-1"
                  onMouseEnter={() => setHovered(datum)}
                  onMouseLeave={() => setHovered(null)}
                  onFocus={() => setHovered(datum)}
                  onBlur={() => setHovered(null)}
                  onClick={() => zoomInto(zoomTarget)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      zoomInto(zoomTarget);
                    }
                  }}
                />
                {cellWidth * cellHeight > MIN_LABEL_AREA && (
                  <text
                    x={leaf.x0 + 5}
                    y={leaf.y0 + 14}
                    className="pointer-events-none fill-white font-mono text-[10px]"
                    style={{ paintOrder: 'stroke', stroke: 'rgba(0,0,0,.55)', strokeWidth: 2.5 }}
                  >
                    {datum.name.length > Math.floor(cellWidth / 6)
                      ? `${datum.name.slice(0, Math.max(1, Math.floor(cellWidth / 6) - 1))}…`
                      : datum.name}
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        {hovered && (
          <div
            className="border-line bg-canvas-raised/95 pointer-events-none absolute bottom-3 left-3 rounded-lg border px-3 py-2 backdrop-blur"
            role="status"
          >
            <p className="text-ink font-mono text-[11px] break-all">{hovered.path || '/'}</p>
            <p className="text-ink-subtle mt-0.5 text-[11px]">
              {formatBytes(hovered.size)}
              {hovered.type === 'dir' && ` · ${formatCount(hovered.fileCount)} files`}
              {hovered.language && ` · ${hovered.language}`}
            </p>
          </div>
        )}
      </div>

      <p className="text-ink-faint mt-2 text-[11px]">
        Click a cell to zoom into its directory. Press Escape to zoom back out.
      </p>
    </div>
  );
}

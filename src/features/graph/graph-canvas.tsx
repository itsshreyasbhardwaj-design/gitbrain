'use client';

import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { useCallback, useMemo } from 'react';

import type { GraphNode, LanguageBreakdown, ModuleGraph } from '@/core/types';
import { basename } from '@/core/shared/paths';
import { cn } from '@/lib/cn';
import { layoutForceDirected, layoutLayered } from './layout';

import '@xyflow/react/dist/style.css';

/**
 * Hard cap on rendered nodes.
 *
 * React Flow keeps a DOM element per node; past roughly this many, panning
 * stutters on a mid-range laptop and the picture stops being readable anyway.
 * When the cap bites we keep the most *connected* modules — the ones that
 * define the architecture — and say plainly how many were hidden. Silently
 * truncating would make the graph a lie.
 */
const MAX_RENDERED_NODES = 300;

export type LayoutMode = 'layered' | 'force';

export interface GraphCanvasProps {
  graph: ModuleGraph;
  languages: readonly LanguageBreakdown[];
  layout: LayoutMode;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  className?: string;
}

interface ModuleNodeData extends Record<string, unknown> {
  label: string;
  path: string;
  loc: number;
  color: string;
  circular: boolean;
  isEntry: boolean;
  dimmed: boolean;
  selected: boolean;
}

/** Node size scales with lines of code, clamped so nothing dominates. */
function nodeWidth(loc: number): number {
  return Math.round(Math.min(220, Math.max(120, 120 + Math.log2(Math.max(loc, 1)) * 12)));
}

function ModuleNode({ data }: NodeProps) {
  const node = data as ModuleNodeData;

  return (
    <div
      className={cn(
        'bg-canvas-raised rounded-lg border px-3 py-2 transition-opacity duration-150',
        node.selected ? 'border-jade shadow-glow' : 'border-line',
        node.circular && !node.selected && 'border-bad/60',
        node.dimmed && 'opacity-20',
      )}
      style={{ width: nodeWidth(node.loc) }}
      title={node.path}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!bg-ink-faint !size-1.5 !border-0"
      />

      <div className="flex items-center gap-1.5">
        <span
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: node.color }}
          aria-hidden="true"
        />
        <span className="text-ink truncate font-mono text-[11px]">{node.label}</span>
        {node.circular && (
          <span className="bg-bad ml-auto size-1.5 shrink-0 rounded-full" aria-hidden="true" />
        )}
      </div>

      <div className="text-ink-faint mt-0.5 flex items-center gap-1.5 pl-3.5 text-[10px]">
        <span className="tabular-nums">{node.loc} LOC</span>
        {node.isEntry && <span className="text-jade">entry</span>}
      </div>

      <Handle
        type="source"
        position={Position.Right}
        className="!bg-ink-faint !size-1.5 !border-0"
      />
    </div>
  );
}

const NODE_TYPES = { module: ModuleNode };

function GraphCanvasInner({
  graph,
  languages,
  layout,
  selectedId,
  onSelect,
  className,
}: GraphCanvasProps) {
  const colorFor = useMemo(() => {
    const map = new Map(languages.map((language) => [language.language, language.color]));
    return (language: string) => map.get(language) ?? '#6b7280';
  }, [languages]);

  /** The subset actually drawn, plus how many were left out. */
  const { visible, hiddenCount } = useMemo(() => {
    if (graph.nodes.length <= MAX_RENDERED_NODES) {
      return { visible: graph.nodes, hiddenCount: 0 };
    }
    const ranked = [...graph.nodes].sort(
      (a, b) => b.inDegree + b.outDegree - (a.inDegree + a.outDegree),
    );
    return {
      visible: ranked.slice(0, MAX_RENDERED_NODES),
      hiddenCount: graph.nodes.length - MAX_RENDERED_NODES,
    };
  }, [graph.nodes]);

  const visibleIds = useMemo(() => new Set(visible.map((node) => node.id)), [visible]);

  const slice = useMemo<ModuleGraph>(
    () => ({
      ...graph,
      nodes: visible,
      edges: graph.edges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to)),
    }),
    [graph, visible, visibleIds],
  );

  const positions = useMemo(
    () => (layout === 'layered' ? layoutLayered(slice) : layoutForceDirected(slice)),
    [slice, layout],
  );

  /** 1-hop neighbourhood of the selection, used to dim everything else. */
  const neighbourhood = useMemo(() => {
    if (!selectedId) return null;
    const set = new Set<string>([selectedId]);
    for (const edge of slice.edges) {
      if (edge.from === selectedId) set.add(edge.to);
      if (edge.to === selectedId) set.add(edge.from);
    }
    return set;
  }, [selectedId, slice.edges]);

  const cyclic = useMemo(() => {
    const set = new Set<string>();
    for (const cycle of graph.cycles) for (const path of cycle) set.add(path);
    return set;
  }, [graph.cycles]);

  const nodes = useMemo<Node[]>(
    () =>
      slice.nodes.map((node: GraphNode) => {
        const point = positions.get(node.id) ?? { x: 0, y: 0 };
        const data: ModuleNodeData = {
          label: basename(node.path),
          path: node.path,
          loc: node.loc,
          color: colorFor(node.language),
          circular: cyclic.has(node.id),
          isEntry: node.isEntry,
          dimmed: neighbourhood !== null && !neighbourhood.has(node.id),
          selected: node.id === selectedId,
        };
        return { id: node.id, type: 'module', position: point, data, draggable: true };
      }),
    [slice.nodes, positions, colorFor, cyclic, neighbourhood, selectedId],
  );

  const edges = useMemo<Edge[]>(
    () =>
      slice.edges.map((edge) => {
        const dimmed =
          neighbourhood !== null && !(neighbourhood.has(edge.from) && neighbourhood.has(edge.to));

        return {
          id: `${edge.from}->${edge.to}`,
          source: edge.from,
          target: edge.to,
          animated: edge.circular,
          style: {
            stroke: edge.circular ? 'var(--color-bad)' : 'var(--xy-edge-stroke)',
            strokeWidth: edge.circular ? 1.6 : 1,
            opacity: dimmed ? 0.08 : edge.circular ? 0.9 : 0.45,
          },
        };
      }),
    [slice.edges, neighbourhood],
  );

  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      onSelect(node.id === selectedId ? null : node.id);
    },
    [onSelect, selectedId],
  );

  return (
    <div className={cn('relative', className)}>
      {hiddenCount > 0 && (
        <p className="border-warn/25 bg-warn/10 text-ink-muted absolute top-3 left-3 z-10 rounded-md border px-2.5 py-1.5 text-[11px] backdrop-blur">
          Showing the {MAX_RENDERED_NODES} most-connected modules. {hiddenCount} more are in the
          analysis but not drawn, to keep the canvas readable.
        </p>
      )}

      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodeClick={onNodeClick}
        onPaneClick={() => onSelect(null)}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.05}
        maxZoom={2.5}
        proOptions={{ hideAttribution: true }}
        nodesConnectable={false}
        edgesFocusable={false}
        aria-label="Module dependency graph"
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="oklch(1 0 0 / 7%)" />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          nodeColor={(node) => ((node.data as ModuleNodeData).color ?? '#6b7280') as string}
          maskColor="oklch(0.145 0.008 265 / 78%)"
          style={{
            backgroundColor: 'var(--color-canvas-raised)',
            border: '1px solid var(--color-line)',
          }}
        />
      </ReactFlow>
    </div>
  );
}

export function GraphCanvas(props: GraphCanvasProps) {
  // React Flow needs its provider above any component calling its hooks.
  return (
    <ReactFlowProvider>
      <GraphCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

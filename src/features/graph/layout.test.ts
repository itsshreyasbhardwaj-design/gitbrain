import { describe, expect, it } from 'vitest';

import type { GraphEdge, GraphNode, ModuleGraph } from '@/core/types';

import { layoutForceDirected, layoutLayered, toPositionedNodes } from './layout';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function node(id: string, overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    label: id.split('/').pop() ?? id,
    path: id,
    language: 'TypeScript',
    loc: 100,
    outDegree: 0,
    inDegree: 0,
    instability: 0.5,
    isEntry: false,
    isOrphan: false,
    ...overrides,
  };
}

function edge(from: string, to: string, circular = false): GraphEdge {
  return { from, to, specifier: `./${to}`, circular };
}

function graphOf(nodes: readonly GraphNode[], edges: readonly GraphEdge[] = []): ModuleGraph {
  return { nodes, edges, cycles: [], externals: [], orphans: [] };
}

const EMPTY: ModuleGraph = graphOf([]);

/** Depth is recoverable from x because layers are evenly spaced. */
function layersByX(
  positions: ReadonlyMap<string, { x: number; y: number }>,
): Map<number, string[]> {
  const byX = new Map<number, string[]>();
  for (const [id, point] of positions) {
    const bucket = byX.get(point.x);
    if (bucket === undefined) byX.set(point.x, [id]);
    else bucket.push(id);
  }
  return byX;
}

function sortedXs(positions: ReadonlyMap<string, { x: number; y: number }>): number[] {
  return [...layersByX(positions).keys()].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// layoutLayered
// ---------------------------------------------------------------------------

describe('layoutLayered', () => {
  it('returns an empty map for an empty graph', () => {
    expect(layoutLayered(EMPTY).size).toBe(0);
  });

  it('places a single node at the origin', () => {
    const positions = layoutLayered(graphOf([node('a.ts')]));
    expect(positions.size).toBe(1);
    expect(positions.get('a.ts')).toEqual({ x: 0, y: 0 });
  });

  it('assigns longest-path depths for a known DAG', () => {
    //  a -> b -> d
    //  a -> c -> d      d must be depth 2 (longest path), not depth 1.
    //  a -> d
    const graph = graphOf(
      [node('a'), node('b'), node('c'), node('d')],
      [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd'), edge('a', 'd')],
    );

    const positions = layoutLayered(graph);
    const xs = sortedXs(positions);
    expect(xs).toHaveLength(3);

    const [layer0, layer1, layer2] = xs;
    expect(layer0).toBeDefined();
    expect(layer1).toBeDefined();
    expect(layer2).toBeDefined();

    const buckets = layersByX(positions);
    expect(buckets.get(layer0 as number)).toEqual(['a']);
    expect(buckets.get(layer1 as number)?.sort()).toEqual(['b', 'c']);
    expect(buckets.get(layer2 as number)).toEqual(['d']);
  });

  it('spaces layers evenly and centres them on the origin', () => {
    const graph = graphOf([node('a'), node('b'), node('c')], [edge('a', 'b'), edge('b', 'c')]);
    const xs = sortedXs(layoutLayered(graph));

    expect(xs).toHaveLength(3);
    const [first, middle, last] = xs as [number, number, number];
    expect(middle).toBe(0);
    expect(first).toBe(-last);
    expect(middle - first).toBe(last - middle);
  });

  it('forces entry points into the first layer even when they are imported', () => {
    // Without the entry override main.ts would sit two layers deep, behind
    // the test that happens to import it.
    const graph = graphOf(
      [node('helpers.ts'), node('test.ts'), node('main.ts', { isEntry: true })],
      [edge('helpers.ts', 'test.ts'), edge('test.ts', 'main.ts')],
    );

    const positions = layoutLayered(graph);
    const main = positions.get('main.ts');
    const test = positions.get('test.ts');
    expect(main).toBeDefined();
    expect(test).toBeDefined();
    expect((main as { x: number }).x).toBeLessThan((test as { x: number }).x);
  });

  it('terminates on cycles by cutting the back edge', () => {
    // a -> b -> c -> a, plus a tail so a cut point is observable.
    const graph = graphOf(
      [node('a'), node('b'), node('c'), node('d')],
      [edge('a', 'b', true), edge('b', 'c', true), edge('c', 'a', true), edge('c', 'd')],
    );

    const positions = layoutLayered(graph);
    expect(positions.size).toBe(4);
    for (const point of positions.values()) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
    }
  });

  it('survives a graph that is nothing but one big cycle', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `m${i}`);
    const edges = ids.map((id, i) => edge(id, ids[(i + 1) % ids.length] as string, true));
    const positions = layoutLayered(
      graphOf(
        ids.map((id) => node(id)),
        edges,
      ),
    );

    expect(positions.size).toBe(40);
  });

  it('lays out disconnected components without dropping any node', () => {
    const graph = graphOf(
      [node('a'), node('b'), node('x'), node('y'), node('lonely')],
      [edge('a', 'b'), edge('x', 'y')],
    );

    const positions = layoutLayered(graph);
    expect(positions.size).toBe(5);
    expect([...positions.keys()].sort()).toEqual(['a', 'b', 'lonely', 'x', 'y']);

    // Nodes sharing a layer must not share a position.
    const seen = new Set<string>();
    for (const point of positions.values()) seen.add(`${point.x}:${point.y}`);
    expect(seen.size).toBe(5);
  });

  it('ignores edges pointing outside the node set', () => {
    const graph = graphOf([node('a')], [edge('a', 'not-rendered'), edge('missing', 'a')]);
    const positions = layoutLayered(graph);

    expect(positions.size).toBe(1);
    expect(positions.get('a')).toEqual({ x: 0, y: 0 });
  });

  it('is deterministic across repeated calls', () => {
    const graph = graphOf(
      [node('a'), node('b'), node('c'), node('d'), node('e')],
      [edge('a', 'b'), edge('b', 'c'), edge('a', 'd'), edge('d', 'e'), edge('e', 'b')],
    );

    expect([...layoutLayered(graph)]).toEqual([...layoutLayered(graph)]);
  });
});

// ---------------------------------------------------------------------------
// layoutForceDirected
// ---------------------------------------------------------------------------

describe('layoutForceDirected', () => {
  it('returns an empty map for an empty graph', () => {
    expect(layoutForceDirected(EMPTY).size).toBe(0);
  });

  it('places a single node at the origin', () => {
    const positions = layoutForceDirected(graphOf([node('solo.ts')]));
    expect(positions.get('solo.ts')).toEqual({ x: 0, y: 0 });
  });

  it('never calls Math.random — identical calls give identical output', () => {
    const graph = graphOf(
      Array.from({ length: 30 }, (_, i) => node(`m${i}`)),
      Array.from({ length: 29 }, (_, i) => edge(`m${i}`, `m${i + 1}`)),
    );

    const first = layoutForceDirected(graph);
    const second = layoutForceDirected(graph);

    expect([...first]).toEqual([...second]);
  });

  it('re-rolls the layout when the seed changes', () => {
    const graph = graphOf(
      Array.from({ length: 12 }, (_, i) => node(`m${i}`)),
      [edge('m0', 'm1'), edge('m1', 'm2')],
    );

    const a = layoutForceDirected(graph, { seed: 1 });
    const b = layoutForceDirected(graph, { seed: 2 });

    expect([...a]).not.toEqual([...b]);
    expect(a.size).toBe(b.size);
  });

  it('keeps every node inside the drawing area and finite', () => {
    const graph = graphOf(
      Array.from({ length: 60 }, (_, i) => node(`m${i}`)),
      Array.from({ length: 40 }, (_, i) => edge(`m${i}`, `m${(i * 7 + 3) % 60}`)),
    );

    const width = 800;
    const height = 600;
    const positions = layoutForceDirected(graph, { width, height, iterations: 40 });

    expect(positions.size).toBe(60);
    for (const point of positions.values()) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
      expect(Math.abs(point.x)).toBeLessThanOrEqual(width / 2);
      expect(Math.abs(point.y)).toBeLessThanOrEqual(height / 2);
    }
  });

  it('separates disconnected components rather than stacking them', () => {
    const graph = graphOf(
      [node('a'), node('b'), node('x'), node('y')],
      [edge('a', 'b'), edge('x', 'y')],
    );

    const positions = layoutForceDirected(graph);
    const stamps = new Set([...positions.values()].map((point) => `${point.x}:${point.y}`));
    expect(stamps.size).toBe(4);
  });

  it('tolerates self-loops and dangling edges', () => {
    const graph = graphOf(
      [node('a'), node('b')],
      [edge('a', 'a'), edge('a', 'b'), edge('b', 'ghost')],
    );

    const positions = layoutForceDirected(graph);
    expect(positions.size).toBe(2);
    for (const point of positions.values()) {
      expect(Number.isFinite(point.x)).toBe(true);
    }
  });

  it('lays out 500 nodes quickly and deterministically', () => {
    const nodes = Array.from({ length: 500 }, (_, i) => node(`m${i}`));
    const edges = Array.from({ length: 900 }, (_, i) =>
      edge(`m${i % 500}`, `m${(i * 13 + 7) % 500}`),
    );
    const graph = graphOf(nodes, edges);

    const started = Date.now();
    const positions = layoutForceDirected(graph);
    const elapsed = Date.now() - started;

    expect(positions.size).toBe(500);
    // The compute budget caps the pass count; if this ever blows past a second
    // the budget has been broken, not merely exceeded.
    expect(elapsed).toBeLessThan(2000);
    expect([...positions]).toEqual([...layoutForceDirected(graph)]);
  });
});

// ---------------------------------------------------------------------------
// toPositionedNodes
// ---------------------------------------------------------------------------

describe('toPositionedNodes', () => {
  it('flattens a layout in the graph node order', () => {
    const graph = graphOf([node('a'), node('b')], [edge('a', 'b')]);
    const positioned = toPositionedNodes(graph, layoutLayered(graph));

    expect(positioned.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(positioned[0]?.x).toBeLessThan(positioned[1]?.x ?? 0);
  });

  it('skips nodes the layout did not position', () => {
    const graph = graphOf([node('a'), node('b')]);
    const partial = new Map([['a', { x: 1, y: 2 }]]);

    expect(toPositionedNodes(graph, partial)).toEqual([{ id: 'a', x: 1, y: 2 }]);
  });
});

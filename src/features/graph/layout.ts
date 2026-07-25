/**
 * Deterministic module-graph layout.
 *
 * Pure TypeScript: no React, no DOM, no timers. That is not incidental — it is
 * what makes the layouts unit-testable and, more importantly, *reproducible*.
 * A developer who re-opens the same analysis must see the same picture, because
 * a graph that reshuffles itself on every render teaches people not to trust it.
 *
 * Two consequences follow from that rule and are enforced throughout this file:
 *
 * **`Math.random()` is never called.** The force layout needs a starting
 * scatter, so it uses a seeded mulberry32 PRNG. Same seed, same scatter, same
 * final positions, forever.
 *
 * **Iteration counts are bounded by a compute budget, not by convergence.**
 * Fruchterman–Reingold is O(n²) per iteration. On a 2 000-module monorepo an
 * unbounded run is a frozen tab, which reads to the user as "GitBrain crashed".
 * We would rather show a slightly under-relaxed graph immediately than a
 * perfect one never, so the iteration count is derived from a fixed pair-visit
 * budget (see `PAIR_VISIT_BUDGET`).
 */

import type { ModuleGraph } from '@/core/types';

/** A node with its resolved position, for consumers that want an array. */
export interface PositionedNode {
  id: string;
  x: number;
  y: number;
}

/** The value side of every layout result. */
export interface LayoutPoint {
  x: number;
  y: number;
}

export interface ForceLayoutOptions {
  /**
   * Upper bound on relaxation passes. The effective count is the smaller of
   * this and whatever the compute budget allows for the graph's size.
   */
  readonly iterations?: number;
  /** Width of the drawing area, in flow units. Positions are centred on 0. */
  readonly width?: number;
  /** Height of the drawing area, in flow units. */
  readonly height?: number;
  /** PRNG seed for the initial scatter. Changing it re-rolls the layout. */
  readonly seed?: number;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Horizontal distance between two layers in the layered layout. */
const LAYER_GAP = 300;
/** Vertical distance between two nodes inside the same layer. */
const ROW_GAP = 88;

const DEFAULT_WIDTH = 1800;
const DEFAULT_HEIGHT = 1200;
const DEFAULT_ITERATIONS = 160;
const DEFAULT_SEED = 0x5eed;

/**
 * Never run fewer than this many passes, even for a huge graph. Below roughly
 * five passes the result is still visibly the initial scatter, which is worse
 * than useless — it looks like a bug rather than a layout.
 */
const MIN_ITERATIONS = 6;

/**
 * Total node-pair visits the repulsion phase is allowed. 12M pair-visits is
 * ~50–150 ms of arithmetic on typed arrays, which keeps the worst case inside
 * a single frame budget's worth of jank rather than seconds of freeze.
 *
 *   n =   50 -> 160 passes (capped by `iterations`)
 *   n =  500 ->  48 passes
 *   n = 2000 ->   6 passes (floored by `MIN_ITERATIONS`)
 */
const PAIR_VISIT_BUDGET = 12_000_000;

// ---------------------------------------------------------------------------
// Seeded PRNG
// ---------------------------------------------------------------------------

/**
 * mulberry32 — 32 bits of state, uniform enough for scattering points and
 * short enough to audit. Inlined rather than pulled from a dependency because
 * "the layout moved" is the kind of regression a transitive version bump
 * should never be able to cause.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Positions are stored at 0.01-unit precision so results serialize cleanly. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// Layered layout
// ---------------------------------------------------------------------------

const UNVISITED = 0;
const IN_PROGRESS = 1;
const RESOLVED = 2;

/**
 * Layer the graph by longest path from its sources.
 *
 * Depth is `1 + max(depth of importers)`, which places a module to the right of
 * everything that depends on it — dependency flow reads left-to-right, the same
 * direction as the import statements that produced it.
 *
 * **Cycles.** A dependency graph is not guaranteed acyclic, and "longest path"
 * is undefined on a cycle. Back edges (those pointing at a node currently on
 * the traversal stack) are dropped for depth purposes, which is equivalent to
 * cutting each cycle at the point the traversal first re-entered it. The cycle
 * itself is still reported by the analysis engine and rendered by the canvas —
 * we are only refusing to let it make the layout diverge.
 *
 * **Entry points are forced to layer 0.** An entry point is by definition where
 * a reader starts, so it belongs at the left margin even when something else
 * (a test, a barrel file) happens to import it.
 *
 * The traversal uses an explicit stack rather than recursion: import chains in
 * a real monorepo run thousands deep, and a `RangeError` here would present as
 * "this repository is too complex to draw".
 */
export function layoutLayered(graph: ModuleGraph): Map<string, LayoutPoint> {
  const positions = new Map<string, LayoutPoint>();
  if (graph.nodes.length === 0) return positions;

  const ids = new Set(graph.nodes.map((node) => node.id));
  const forcedRoots = new Set(graph.nodes.filter((node) => node.isEntry).map((node) => node.id));

  // Importers of each module, in edge declaration order so the result is stable.
  const importers = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.from === edge.to) continue;
    if (!ids.has(edge.from) || !ids.has(edge.to)) continue;
    const bucket = importers.get(edge.to);
    if (bucket === undefined) importers.set(edge.to, [edge.from]);
    else bucket.push(edge.from);
  }

  const parentsOf = (id: string): readonly string[] =>
    forcedRoots.has(id) ? [] : (importers.get(id) ?? []);

  const state = new Map<string, number>();
  const depth = new Map<string, number>();

  interface Frame {
    id: string;
    cursor: number;
    best: number;
  }

  for (const node of graph.nodes) {
    if ((state.get(node.id) ?? UNVISITED) !== UNVISITED) continue;

    state.set(node.id, IN_PROGRESS);
    const stack: Frame[] = [{ id: node.id, cursor: 0, best: 0 }];

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame === undefined) break;

      const parents = parentsOf(frame.id);

      if (frame.cursor < parents.length) {
        const parent = parents[frame.cursor];
        if (parent === undefined) {
          frame.cursor++;
          continue;
        }

        const parentState = state.get(parent) ?? UNVISITED;
        if (parentState === RESOLVED) {
          frame.best = Math.max(frame.best, (depth.get(parent) ?? 0) + 1);
          frame.cursor++;
        } else if (parentState === IN_PROGRESS) {
          // Back edge: this is the cut point for the cycle. Skip it.
          frame.cursor++;
        } else {
          state.set(parent, IN_PROGRESS);
          stack.push({ id: parent, cursor: 0, best: 0 });
        }
        continue;
      }

      stack.pop();
      state.set(frame.id, RESOLVED);
      depth.set(frame.id, frame.best);
    }
  }

  // Group by depth, preserving the caller's node order inside each layer.
  const layers = new Map<number, string[]>();
  let maxDepth = 0;
  for (const node of graph.nodes) {
    const level = depth.get(node.id) ?? 0;
    maxDepth = Math.max(maxDepth, level);
    const bucket = layers.get(level);
    if (bucket === undefined) layers.set(level, [node.id]);
    else bucket.push(node.id);
  }

  const centreOffset = (maxDepth * LAYER_GAP) / 2;

  for (const [level, members] of layers) {
    const columnHeight = (members.length - 1) * ROW_GAP;
    members.forEach((id, index) => {
      positions.set(id, {
        x: round(level * LAYER_GAP - centreOffset),
        y: round(index * ROW_GAP - columnHeight / 2),
      });
    });
  }

  return positions;
}

// ---------------------------------------------------------------------------
// Force-directed layout
// ---------------------------------------------------------------------------

/**
 * Fruchterman–Reingold with a fixed iteration budget.
 *
 * Chosen over a quadtree/Barnes–Hut approximation deliberately: FR in its
 * naive form is about forty lines, has no tree to keep consistent, and — the
 * decisive property here — produces bit-identical output for identical input
 * on every platform. An approximation would buy speed we already bought with
 * the iteration budget, at the cost of the property the whole file exists for.
 *
 * The classic three phases per pass:
 *   1. every pair repels with `k² / distance`,
 *   2. every edge attracts with `distance² / k`,
 *   3. displacement is clamped to a temperature that cools linearly to zero.
 *
 * Self-loops and edges pointing outside the node set are ignored — a graph
 * sliced for display (see the canvas's node cap) routinely contains both.
 */
export function layoutForceDirected(
  graph: ModuleGraph,
  options: ForceLayoutOptions = {},
): Map<string, LayoutPoint> {
  const positions = new Map<string, LayoutPoint>();
  const count = graph.nodes.length;
  if (count === 0) return positions;

  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;

  const firstNode = graph.nodes[0];
  if (count === 1) {
    if (firstNode !== undefined) positions.set(firstNode.id, { x: 0, y: 0 });
    return positions;
  }

  const index = new Map<string, number>();
  graph.nodes.forEach((node, i) => index.set(node.id, i));

  // Typed arrays: the inner loop runs millions of times and object property
  // access is the difference between "instant" and "noticeable".
  const x = new Float64Array(count);
  const y = new Float64Array(count);
  const dx = new Float64Array(count);
  const dy = new Float64Array(count);

  const random = mulberry32(options.seed ?? DEFAULT_SEED);
  for (let i = 0; i < count; i++) {
    x[i] = (random() - 0.5) * width;
    y[i] = (random() - 0.5) * height;
  }

  const edgeFrom: number[] = [];
  const edgeTo: number[] = [];
  for (const edge of graph.edges) {
    const from = index.get(edge.from);
    const to = index.get(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    edgeFrom.push(from);
    edgeTo.push(to);
  }

  const requested = Math.max(1, options.iterations ?? DEFAULT_ITERATIONS);
  const affordable = Math.floor(PAIR_VISIT_BUDGET / (count * count));
  const iterations = Math.max(MIN_ITERATIONS, Math.min(requested, affordable));

  // Ideal edge length: the side of the square each node would own if the
  // drawing area were divided equally between them.
  const k = Math.sqrt((width * height) / count);
  const halfWidth = width / 2;
  const halfHeight = height / 2;

  let temperature = width / 10;
  const cooling = temperature / (iterations + 1);

  for (let pass = 0; pass < iterations; pass++) {
    dx.fill(0);
    dy.fill(0);

    for (let i = 0; i < count; i++) {
      const xi = x[i] ?? 0;
      const yi = y[i] ?? 0;

      for (let j = i + 1; j < count; j++) {
        let deltaX = xi - (x[j] ?? 0);
        let deltaY = yi - (y[j] ?? 0);

        // Coincident nodes have no direction to separate along. Nudge them
        // apart using their indices so the tie-break stays deterministic.
        if (deltaX === 0 && deltaY === 0) {
          deltaX = ((i % 7) - 3) * 0.01 || 0.01;
          deltaY = ((j % 5) - 2) * 0.01 || 0.01;
        }

        const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
        const force = (k * k) / distance;
        const unitX = (deltaX / distance) * force;
        const unitY = (deltaY / distance) * force;

        dx[i] = (dx[i] ?? 0) + unitX;
        dy[i] = (dy[i] ?? 0) + unitY;
        dx[j] = (dx[j] ?? 0) - unitX;
        dy[j] = (dy[j] ?? 0) - unitY;
      }
    }

    for (let e = 0; e < edgeFrom.length; e++) {
      const a = edgeFrom[e];
      const b = edgeTo[e];
      if (a === undefined || b === undefined) continue;

      const deltaX = (x[a] ?? 0) - (x[b] ?? 0);
      const deltaY = (y[a] ?? 0) - (y[b] ?? 0);
      const distance = Math.max(Math.sqrt(deltaX * deltaX + deltaY * deltaY), 0.01);
      const force = (distance * distance) / k;
      const unitX = (deltaX / distance) * force;
      const unitY = (deltaY / distance) * force;

      dx[a] = (dx[a] ?? 0) - unitX;
      dy[a] = (dy[a] ?? 0) - unitY;
      dx[b] = (dx[b] ?? 0) + unitX;
      dy[b] = (dy[b] ?? 0) + unitY;
    }

    for (let i = 0; i < count; i++) {
      const moveX = dx[i] ?? 0;
      const moveY = dy[i] ?? 0;
      const magnitude = Math.sqrt(moveX * moveX + moveY * moveY);
      if (magnitude === 0) continue;

      const step = Math.min(magnitude, temperature) / magnitude;
      // Clamping to the frame is what stops disconnected components — which
      // feel repulsion but no attraction — from drifting to infinity.
      x[i] = Math.max(-halfWidth, Math.min(halfWidth, (x[i] ?? 0) + moveX * step));
      y[i] = Math.max(-halfHeight, Math.min(halfHeight, (y[i] ?? 0) + moveY * step));
    }

    temperature = Math.max(0, temperature - cooling);
  }

  graph.nodes.forEach((node, i) => {
    positions.set(node.id, { x: round(x[i] ?? 0), y: round(y[i] ?? 0) });
  });

  return positions;
}

/** Flatten a layout result into an array, in the graph's own node order. */
export function toPositionedNodes(
  graph: ModuleGraph,
  positions: ReadonlyMap<string, LayoutPoint>,
): PositionedNode[] {
  const result: PositionedNode[] = [];
  for (const node of graph.nodes) {
    const point = positions.get(node.id);
    if (point === undefined) continue;
    result.push({ id: node.id, x: point.x, y: point.y });
  }
  return result;
}

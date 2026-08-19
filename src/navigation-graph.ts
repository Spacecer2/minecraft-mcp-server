/**
 * navigation-graph.ts — persistent landmark graph for the survival bot.
 * Nodes are landmarks (base, cave mouths, ore clusters, death locations,
 * villages, monuments, nether portals); edges are traversed routes between
 * them. Landmark re-sighting corrects odometer drift. Pure module (no
 * mineflayer import at top level) so tests run headless.
 */

import type { Position } from './dead-reckoning.js';

export type LandmarkType =
  | 'base'
  | 'cave'
  | 'ore'
  | 'death'
  | 'village'
  | 'monument'
  | 'nether_portal';

export type LandmarkNode = {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  type: LandmarkType;
  visitedCount: number;
  deadReckonedPos: Position | undefined;
};

export type LandmarkEdge = {
  from: string;
  to: string;
  traversedCount: number;
  lengthBlocks: number;
};

const nodesById = new Map<string, LandmarkNode>();
const edgeMap = new Map<string, LandmarkEdge>();
let lastNodeId = 0;

function canonical(from: string, to: string): [string, string] {
  return from <= to ? [from, to] : [to, from];
}

export function addNode(input: {
  name: string;
  x: number;
  y: number;
  z: number;
  type: LandmarkType;
}): LandmarkNode {
  const node: LandmarkNode = {
    id: `node-${++lastNodeId}`,
    name: input.name,
    x: Math.round(input.x),
    y: Math.round(input.y),
    z: Math.round(input.z),
    type: input.type,
    visitedCount: 1,
    deadReckonedPos: undefined
  };
  nodesById.set(node.id, node);
  return node;
}

export function getNode(id: string): LandmarkNode | undefined {
  return nodesById.get(id);
}

function requireNode(id: string): LandmarkNode {
  const node = nodesById.get(id);
  if (!node) {
    throw new Error(`Unknown node: ${id}`);
  }
  return node;
}

// Adds a known route connection (not yet walked). Traversed routes are
// recorded with markTraversed, which also bumps the traversal count.
export function addEdge(from: string, to: string): LandmarkEdge {
  requireNode(from);
  requireNode(to);
  const [f, t] = canonical(from, to);
  const key = `${f}:${t}`;
  const existing = edgeMap.get(key);
  if (existing) {
    return existing;
  }
  const edge: LandmarkEdge = { from: f, to: t, traversedCount: 0, lengthBlocks: 0 };
  edgeMap.set(key, edge);
  return edge;
}

export function markTraversed(from: string, to: string, length: number): LandmarkEdge {
  requireNode(from);
  requireNode(to);
  const [f, t] = canonical(from, to);
  const key = `${f}:${t}`;
  const existing = edgeMap.get(key);
  if (existing) {
    existing.traversedCount += 1;
    existing.lengthBlocks = Math.round(length);
    return existing;
  }
  const edge: LandmarkEdge = {
    from: f,
    to: t,
    traversedCount: 1,
    lengthBlocks: Math.round(length)
  };
  edgeMap.set(key, edge);
  return edge;
}

export function shortestPath(from: string, to: string): string[] | null {
  requireNode(from);
  requireNode(to);
  if (from === to) {
    return [from];
  }

  const adjacency = new Map<string, string[]>();
  for (const edge of edgeMap.values()) {
    const a = adjacency.get(edge.from) ?? [];
    a.push(edge.to);
    adjacency.set(edge.from, a);
    const b = adjacency.get(edge.to) ?? [];
    b.push(edge.from);
    adjacency.set(edge.to, b);
  }

  // BFS over the adjacency map — no external graph library.
  const queue: string[] = [from];
  const visited = new Set<string>([from]);
  const parent = new Map<string, string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const neighbor of adjacency.get(current) ?? []) {
      if (visited.has(neighbor)) {
        continue;
      }
      visited.add(neighbor);
      parent.set(neighbor, current);
      if (neighbor === to) {
        const path: string[] = [neighbor];
        let cursor = current;
        while (cursor !== from) {
          path.unshift(cursor);
          cursor = parent.get(cursor)!;
        }
        path.unshift(from);
        return path;
      }
      queue.push(neighbor);
    }
  }
  return null;
}

export function setDeadReckonedPos(nodeId: string, pos: Position): void {
  const node = requireNode(nodeId);
  node.deadReckonedPos = { x: pos.x, y: pos.y, z: pos.z };
}

// When a landmark is re-sighted at its actual position, the difference
// between the dead-reckoned (odometer-estimated) position and the actual
// position is the accumulated drift. Correct both toward the actual and
// return the drift vector so the caller can apply the same correction
// globally to other dead-reckoned positions.
export function reSight(nodeId: string, actualPos: Position): Position {
  const node = requireNode(nodeId);
  node.visitedCount += 1;
  if (!node.deadReckonedPos) {
    node.deadReckonedPos = { x: actualPos.x, y: actualPos.y, z: actualPos.z };
    node.x = Math.round(actualPos.x);
    node.y = Math.round(actualPos.y);
    node.z = Math.round(actualPos.z);
    return { x: 0, y: 0, z: 0 };
  }
  const drift: Position = {
    x: actualPos.x - node.deadReckonedPos.x,
    y: actualPos.y - node.deadReckonedPos.y,
    z: actualPos.z - node.deadReckonedPos.z
  };
  node.deadReckonedPos = { x: actualPos.x, y: actualPos.y, z: actualPos.z };
  node.x = Math.round(actualPos.x);
  node.y = Math.round(actualPos.y);
  node.z = Math.round(actualPos.z);
  return drift;
}

export function nodes(): LandmarkNode[] {
  return Array.from(nodesById.values());
}

export function edges(): LandmarkEdge[] {
  return Array.from(edgeMap.values());
}

export function resetNavigationGraphForTest(): void {
  nodesById.clear();
  edgeMap.clear();
  lastNodeId = 0;
}
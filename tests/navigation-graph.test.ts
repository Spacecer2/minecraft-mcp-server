import test from 'ava';
import {
  addNode,
  addEdge,
  getNode,
  nodes,
  edges,
  resetNavigationGraphForTest,
  shortestPath,
  reSight,
  markTraversed,
  setDeadReckonedPos
} from '../src/navigation-graph.js';

test.beforeEach(() => {
  resetNavigationGraphForTest();
});

test.serial('addNode adds a node and getNode/nodes return it', (t) => {
  const base = addNode({ name: 'Base', x: 10.4, y: 64.2, z: -8.7, type: 'base' });
  t.true(base.id.startsWith('node-'));
  t.is(getNode(base.id), base);
  t.is(base.visitedCount, 1);
  t.is(base.deadReckonedPos, undefined);
  t.is(base.x, 10);
  t.deepEqual(nodes(), [base]);
});

test.serial('addEdge creates a route connection between existing nodes', (t) => {
  const a = addNode({ name: 'cave-a', x: 0, y: 0, z: 0, type: 'cave' });
  const b = addNode({ name: 'cave-b', x: 10, y: 0, z: 0, type: 'cave' });
  addEdge(a.id, b.id);
  const list = edges();
  t.is(list.length, 1);
  t.is(list[0].from, a.id);
  t.is(list[0].to, b.id);
  t.is(list[0].traversedCount, 0);
});

test.serial('shortestPath finds a path through intermediate nodes', (t) => {
  const a = addNode({ name: 'base', x: 0, y: 0, z: 0, type: 'base' });
  const b = addNode({ name: 'cave', x: 10, y: 0, z: 0, type: 'cave' });
  const c = addNode({ name: 'village', x: 20, y: 0, z: 0, type: 'village' });
  addEdge(a.id, b.id);
  addEdge(b.id, c.id);
  t.deepEqual(shortestPath(a.id, c.id), [a.id, b.id, c.id]);
  t.deepEqual(shortestPath(a.id, a.id), [a.id]);
});

test.serial('shortestPath returns null when no route exists', (t) => {
  const a = addNode({ name: 'base', x: 0, y: 0, z: 0, type: 'base' });
  const c = addNode({ name: 'village', x: 20, y: 0, z: 0, type: 'village' });
  t.is(shortestPath(a.id, c.id), null);
});

test.serial('markTraversed records a traversed route and accumulates on reuse', (t) => {
  const a = addNode({ name: 'base', x: 0, y: 0, z: 0, type: 'base' });
  const b = addNode({ name: 'ore', x: 50, y: 0, z: 0, type: 'ore' });
  const first = markTraversed(a.id, b.id, 50);
  t.is(first.traversedCount, 1);
  t.is(first.lengthBlocks, 50);
  const second = markTraversed(a.id, b.id, 55);
  t.is(second.traversedCount, 2);
  t.is(second.lengthBlocks, 55);
  t.is(edges().length, 1);
});

test.serial('reSight corrects odometer drift and returns the drift vector', (t) => {
  const node = addNode({ name: 'cave', x: 10, y: 20, z: 10, type: 'cave' });
  const first = reSight(node.id, { x: 12, y: 20, z: 12 });
  t.deepEqual(first, { x: 0, y: 0, z: 0 });
  t.is(node.visitedCount, 2);
  setDeadReckonedPos(node.id, { x: 100, y: 20, z: 100 });
  const drift = reSight(node.id, { x: 12, y: 20, z: 12 });
  t.deepEqual(drift, { x: -88, y: 0, z: -88 });
  t.is(node.x, 12);
  t.is(node.z, 12);
  t.deepEqual(node.deadReckonedPos, { x: 12, y: 20, z: 12 });
});
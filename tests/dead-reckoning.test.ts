import test from 'ava';
import { returnVector, tripBudget, routeAxiom, lightReturnPath } from '../src/dead-reckoning.js';

test('returnVector returns the vector from current back to base', (t) => {
  t.deepEqual(returnVector({ x: 10, y: 20, z: 30 }, { x: 0, y: 0, z: 0 }), { x: -10, y: -20, z: -30 });
  t.deepEqual(returnVector({ x: 5, y: 10, z: 15 }, { x: 8, y: 10, z: 3 }), { x: 3, y: 0, z: -12 });
});

test('tripBudget is feasible when the return fits before the deadline', (t) => {
  const now = Date.now();
  const result = tripBudget({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 60, now + 10 * 60000, now);
  t.true(result.feasible);
  t.is(result.remainingTime, 10);
  t.is(result.returnDistance, 0);
  t.is(result.maxSafeOutreach, 300);
});

test('tripBudget is infeasible when outreach is too far for the deadline', (t) => {
  const now = Date.now();
  const result = tripBudget({ x: 1000, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 60, now + 5 * 60000, now);
  t.false(result.feasible);
  t.is(result.remainingTime, 5);
  t.is(result.returnDistance, 1000);
});

test('tripBudget clamps remaining time at zero once the deadline passes', (t) => {
  const now = Date.now();
  const result = tripBudget({ x: 10, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 60, now - 60000, now);
  t.false(result.feasible);
  t.is(result.remainingTime, 0);
});

test('routeAxiom returns a waypoint sequence through high point and village', (t) => {
  const start = { x: 0, y: 64, z: 0 };
  const landmarks = [
    { name: 'village', x: 100, y: 64, z: 100, type: 'village' },
    { name: 'hill', x: 10, y: 200, z: 5, type: 'monument' },
    { name: 'cave', x: 5, y: 30, z: 5, type: 'cave' }
  ];
  const route = routeAxiom(start, landmarks, 'plains');
  t.is(route.length, 3);
  t.deepEqual(route[0], { x: 0, y: 64, z: 0, reason: 'start' });
  t.is(route[1].x, 10);
  t.is(route[1].z, 5);
  t.true(route[1].reason.includes('plains'));
  t.is(route[2].x, 100);
  t.is(route[2].z, 100);
  t.true(route[2].reason.includes('village'));
});

test('routeAxiom falls back to the highest landmark when no monument exists', (t) => {
  const start = { x: 0, y: 64, z: 0 };
  const landmarks = [
    { name: 'low', x: 5, y: 64, z: 5, type: 'ore' },
    { name: 'high', x: 50, y: 250, z: 0, type: 'cave' }
  ];
  const route = routeAxiom(start, landmarks, 'mountains');
  t.is(route.length, 2);
  t.is(route[1].y, 250);
});

test('routeAxiom returns just the start when there are no landmarks', (t) => {
  t.deepEqual(routeAxiom({ x: 0, y: 0, z: 0 }, [], 'plains'), [
    { x: 0, y: 0, z: 0, reason: 'start' }
  ]);
});

test('lightReturnPath places torches every spacing blocks along the path', (t) => {
  const base = { x: 0, y: 0, z: 0 };
  const vec = returnVector({ x: 10, y: 0, z: 0 }, base);
  const torches = lightReturnPath(base, vec, 2);
  t.is(torches.length, 6);
  t.deepEqual(torches[0], { x: 10, y: 0, z: 0 });
  t.deepEqual(torches[1], { x: 8, y: 0, z: 0 });
  t.deepEqual(torches[5], { x: 0, y: 0, z: 0 });
});

test('lightReturnPath lights the start when the path is shorter than spacing', (t) => {
  const base = { x: 0, y: 0, z: 0 };
  const vec = returnVector({ x: 5, y: 0, z: 0 }, base);
  const torches = lightReturnPath(base, vec, 10);
  t.is(torches.length, 1);
  t.deepEqual(torches[0], { x: 5, y: 0, z: 0 });
});

test('lightReturnPath throws on invalid spacing', (t) => {
  t.throws(() => lightReturnPath({ x: 0, y: 0, z: 0 }, { x: -10, y: 0, z: 0 }, 0));
});
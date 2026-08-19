import test from 'ava';
import {
  minutesToDusk,
  phaseFor,
  returnByDuskDeadline,
  suggestedActivities
} from '../src/day-rhythm.js';

test('phaseFor: DAWN spans 0..2000', (t) => {
  t.is(phaseFor(0), 'DAWN');
  t.is(phaseFor(1000), 'DAWN');
  t.is(phaseFor(1999), 'DAWN');
});

test('phaseFor: MORNING spans 2000..6000', (t) => {
  t.is(phaseFor(2000), 'MORNING');
  t.is(phaseFor(5000), 'MORNING');
  t.is(phaseFor(5999), 'MORNING');
});

test('phaseFor: MIDDAY spans 6000..10000', (t) => {
  t.is(phaseFor(6000), 'MIDDAY');
  t.is(phaseFor(9000), 'MIDDAY');
  t.is(phaseFor(9999), 'MIDDAY');
});

test('phaseFor: LATE_AFTERNOON spans 10000..12000', (t) => {
  t.is(phaseFor(10000), 'LATE_AFTERNOON');
  t.is(phaseFor(11000), 'LATE_AFTERNOON');
  t.is(phaseFor(11999), 'LATE_AFTERNOON');
});

test('phaseFor: DUSK spans 12000..13000', (t) => {
  t.is(phaseFor(12000), 'DUSK');
  t.is(phaseFor(12500), 'DUSK');
  t.is(phaseFor(12999), 'DUSK');
});

test('phaseFor: EVENING spans 13000..14000', (t) => {
  t.is(phaseFor(13000), 'EVENING');
  t.is(phaseFor(13500), 'EVENING');
  t.is(phaseFor(13999), 'EVENING');
});

test('phaseFor: NIGHT spans 14000..24000', (t) => {
  t.is(phaseFor(14000), 'NIGHT');
  t.is(phaseFor(20000), 'NIGHT');
  t.is(phaseFor(23999), 'NIGHT');
});

test('phaseFor: wraps timeOfDay >= 24000 and handles negatives', (t) => {
  t.is(phaseFor(24000), 'DAWN'); // wraps to 0
  t.is(phaseFor(24000 + 1000), 'DAWN');
  t.is(phaseFor(-1), 'NIGHT'); // wraps to 23999
});

test('minutesToDusk: reports remaining real minutes until nightfall', (t) => {
  t.is(minutesToDusk(13000), 0);
  const atDawn = minutesToDusk(0);
  t.true(Math.abs(atDawn - 13000 / 1200) < 1e-9);
  const midday = minutesToDusk(6000);
  t.true(Math.abs(midday - 7000 / 1200) < 1e-9);
});

test('returnByDuskDeadline: true while a trip can still make it back', (t) => {
  t.true(returnByDuskDeadline(6000, 2)); // ~5.8 min left > 2 min budget
});

test('returnByDuskDeadline: false when it is already too late', (t) => {
  t.false(returnByDuskDeadline(12500, 2)); // ~0.4 min left < 2 min budget
  t.false(returnByDuskDeadline(14000, 2)); // already night
});

test('suggestedActivities: returns phase-appropriate activities', (t) => {
  const dusk = suggestedActivities('DUSK');
  t.true(dusk.length > 0);
  t.true(dusk.some((a) => a.toLowerCase().includes('torch')));
  const midday = suggestedActivities('MIDDAY');
  t.true(midday.some((a) => a.toLowerCase().includes('mine')));
});

test('suggestedActivities: returns a copy (does not mutate internal table)', (t) => {
  const a = suggestedActivities('DAWN');
  a.push('mutated');
  t.is(suggestedActivities('DAWN').length, 3);
});

import test from 'ava';
import {
  slotValue,
  packForTrip,
  HIGH_VALUE_THRESHOLD,
  LONG_TRIP_BLOCKS
} from '../src/foraging.js';

test('slotValue ranks high-value items above bulk', (t) => {
  t.true(slotValue('diamond') > slotValue('dirt'));
  t.true(slotValue('golden_apple') > slotValue('andesite'));
  t.true(slotValue('raw_iron') > slotValue('cobblestone'));
  t.true(slotValue('emerald') >= HIGH_VALUE_THRESHOLD);
});

test('slotValue handles ore and log variants', (t) => {
  t.true(slotValue('deepslate_diamond_ore') >= HIGH_VALUE_THRESHOLD);
  t.true(slotValue('oak_log') > slotValue('dirt'));
  t.true(slotValue('raw_gold') > slotValue('raw_copper'));
});

test('packForTrip keeps ore on long trips and bulk on short trips', (t) => {
  const inventory = [
    { name: 'raw_iron', count: 3 },
    { name: 'dirt', count: 32 }
  ];

  const long = packForTrip(inventory, LONG_TRIP_BLOCKS + 1);
  t.deepEqual(long.carry.map((i) => i.name), ['raw_iron']);
  t.deepEqual(long.dropFirst.map((i) => i.name), ['dirt']);

  const short = packForTrip(inventory, 20);
  t.deepEqual(short.carry.map((i) => i.name).sort(), ['dirt', 'raw_iron']);
  t.deepEqual(short.dropFirst, []);
});

test('packForTrip drops lowest-value items first', (t) => {
  const result = packForTrip(
    [
      { name: 'cobblestone', count: 10 },
      { name: 'dirt', count: 20 },
      { name: 'diamond', count: 1 }
    ],
    LONG_TRIP_BLOCKS + 1
  );
  t.is(result.dropFirst[0].name, 'dirt');
  t.is(result.dropFirst[1].name, 'cobblestone');
});


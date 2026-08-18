import test from 'ava';
import { coerceCoordinates, validateWorldY } from '../src/tools/coordinate-utils.js';

test('coerceCoordinates returns numeric values for numeric strings', (t) => {
  const result = coerceCoordinates('10' as unknown as number, '64.5' as unknown as number, '-3' as unknown as number);

  t.deepEqual(result, { x: 10, y: 64.5, z: -3 });
});

test('coerceCoordinates throws when any coordinate is not a finite number', (t) => {
  t.throws(() => coerceCoordinates(Number.NaN, 1, 2), { message: 'x, y, and z must be valid numbers' });
  t.throws(() => coerceCoordinates(1, Number.POSITIVE_INFINITY, 2), { message: 'x, y, and z must be valid numbers' });
  t.throws(() => coerceCoordinates(1, 2, Number.NEGATIVE_INFINITY), { message: 'x, y, and z must be valid numbers' });
});

test('validateWorldY accepts y within the default world height range', (t) => {
  t.notThrows(() => validateWorldY(-64));
  t.notThrows(() => validateWorldY(0));
  t.notThrows(() => validateWorldY(320));
});

test('validateWorldY throws when y is below the world floor', (t) => {
  t.throws(() => validateWorldY(-65), { message: 'y coordinate -65 is outside the valid world height range -64..320' });
});

test('validateWorldY throws when y is above the world ceiling', (t) => {
  t.throws(() => validateWorldY(321), { message: 'y coordinate 321 is outside the valid world height range -64..320' });
});

test('validateWorldY respects custom world height bounds', (t) => {
  t.notThrows(() => validateWorldY(100, 0, 256));
  t.throws(() => validateWorldY(-1, 0, 256), { message: 'y coordinate -1 is outside the valid world height range 0..256' });
  t.throws(() => validateWorldY(257, 0, 256), { message: 'y coordinate 257 is outside the valid world height range 0..256' });
});

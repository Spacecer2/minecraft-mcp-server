import test from 'ava';
import {
  recordDeath,
  statistics,
  queryGuards,
  riskAt,
  resetDeathRegisterForTest,
  deathRegister,
  persist
} from '../src/death-register.js';

// ava's beforeEach hook does not fire under this tsx/esm setup, so each test
// resets the shared module-level register explicitly.

test('recordDeath + statistics aggregate count, cause and locations', (t) => {
  resetDeathRegisterForTest();
  recordDeath({ location: 'cave-alpha', cause: 'hostile', hpAtDeath: 6, action: 'caving' });
  recordDeath({ location: 'cave-alpha', cause: 'hostile', hpAtDeath: 5, action: 'caving' });
  recordDeath({ location: 'ravine', cause: 'fall', hpAtDeath: 12, action: 'mining' });

  const s = statistics();
  t.is(s.count, 3);
  t.is(s.mostCommonCause, 'hostile');
  t.deepEqual(s.locations.sort(), ['cave-alpha', 'ravine']);
  t.is(s.causes.hostile, 2);
  t.is(s.causes.fall, 1);
});

test('recordDeath stamps a timestamp when none is provided', (t) => {
  resetDeathRegisterForTest();
  const e = recordDeath({ location: 'x', cause: 'lava', hpAtDeath: 2 });
  t.truthy(e.timestamp);
  t.is(deathRegister.count(), 1);
});

test('queryGuards injects torch + HP guards for caving after a cave death', (t) => {
  resetDeathRegisterForTest();
  recordDeath({ location: 'cave-alpha', cause: 'hostile', hpAtDeath: 6, action: 'caving' });

  const res = queryGuards('caving', { action: 'caving', location: 'cave-alpha' });
  t.true(res.learned);
  const guards = res.guards.map((g) => g.guard);
  t.true(guards.includes('torches>=8'));
  t.true(guards.includes('hp>=10'));
  const torch = res.guards.find((g) => g.guard === 'torches>=8')!;
  t.is(torch.threshold, 8);
  t.false(torch.satisfied); // a hostile/creeper death marks the torch guard unmet
});

test('queryGuards marks hp guard unmet after a low-HP cave death', (t) => {
  resetDeathRegisterForTest();
  recordDeath({ location: 'cave-beta', cause: 'creeper', hpAtDeath: 3, action: 'caving' });
  const res = queryGuards('caving', { action: 'caving', location: 'cave-beta' });
  const hp = res.guards.find((g) => g.guard === 'hp>=10')!;
  t.false(hp.satisfied);
});

test('queryGuards returns a safe default for caving with no history', (t) => {
  resetDeathRegisterForTest();
  const res = queryGuards('caving', { action: 'caving' });
  t.false(res.learned);
  t.true(res.guards.length > 0);
});

test('queryGuards does not inject guards for a non-dangerous goal', (t) => {
  resetDeathRegisterForTest();
  const res = queryGuards('eat-bread', { action: 'eat-bread' });
  t.is(res.guards.length, 0);
});

test('riskAt rises with repeated deaths at a location', (t) => {
  resetDeathRegisterForTest();
  t.is(riskAt('cave-alpha'), 0);
  recordDeath({ location: 'cave-alpha', cause: 'hostile', hpAtDeath: 6 });
  const one = riskAt('cave-alpha');
  recordDeath({ location: 'cave-alpha', cause: 'hostile', hpAtDeath: 4 });
  recordDeath({ location: 'cave-alpha', cause: 'fall', hpAtDeath: 8 });
  const many = riskAt('cave-alpha');
  t.true(one > 0);
  t.true(many > one);
  t.true(many <= 1);
});

test('riskAt ignores deaths elsewhere', (t) => {
  resetDeathRegisterForTest();
  recordDeath({ location: 'ravine', cause: 'fall', hpAtDeath: 10 });
  t.is(riskAt('cave-alpha'), 0);
});

test('resetDeathRegisterForTest clears all entries', (t) => {
  resetDeathRegisterForTest();
  recordDeath({ location: 'x', cause: 'void', hpAtDeath: 0 });
  t.is(deathRegister.count(), 1);
  resetDeathRegisterForTest();
  t.is(deathRegister.count(), 0);
  t.is(statistics().count, 0);
});

test('persist writes a summary when the bot exposes remember', async (t) => {
  resetDeathRegisterForTest();
  recordDeath({ location: 'cave-alpha', cause: 'hostile', hpAtDeath: 6 });
  let written = '';
  await persist({ remember: async (k: string, v: string) => { written = `${k}:${v}`; } });
  t.true(written.startsWith('death-register:'));
  const parsed = JSON.parse(written.slice('death-register:'.length));
  t.is(parsed.count, 1);
  t.deepEqual(parsed.locations, ['cave-alpha']);
});

test('persist is a no-op without a remember function', async (t) => {
  resetDeathRegisterForTest();
  recordDeath({ location: 'x', cause: 'other', hpAtDeath: 10 });
  await t.notThrowsAsync(() => persist(null));
  await t.notThrowsAsync(() => persist({}));
});

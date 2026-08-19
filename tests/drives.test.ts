import test from 'ava';
import {
  arbitrate,
  driveScore,
  duskPreemptActive,
  healthDrive,
  hungerDrive,
  inventoryDrive,
  nightDrive,
  oxygenDrive,
  threatDrive,
  toolDrive
} from '../src/drives.js';

test('healthDrive: urgency is 0 in the 14..20 set-zone', (t) => {
  t.is(healthDrive({ health: 14 }).urgency, 0);
  t.is(healthDrive({ health: 20 }).urgency, 0);
});

test('healthDrive: urgency grows below the set-zone and peaks at 0 HP', (t) => {
  const at13 = healthDrive({ health: 13 }).urgency;
  const at6 = healthDrive({ health: 6 }).urgency;
  const at0 = healthDrive({ health: 0 }).urgency;
  t.true(at13 > 0);
  t.true(at6 > at13);
  t.true(at0 > at6);
  t.true(at0 <= 1);
});

test('healthDrive: time-to-harm shortens as HP drops', (t) => {
  t.true(healthDrive({ health: 4 }).timeToHarmSeconds < healthDrive({ health: 16 }).timeToHarmSeconds);
});

test('hungerDrive: hysteresis — eats at 6, stops at 12', (t) => {
  t.true(hungerDrive({ food: 6 }).urgency > 0);
  t.is(hungerDrive({ food: 12 }).urgency, 0);
  t.is(hungerDrive({ food: 20 }).urgency, 0);
});

test('hungerDrive: urgency steepens below 6', (t) => {
  const at10 = hungerDrive({ food: 10 }).urgency;
  const at6 = hungerDrive({ food: 6 }).urgency;
  const at2 = hungerDrive({ food: 2 }).urgency;
  t.true(at10 > 0);
  t.true(at6 > at10);
  t.true(at2 > at6);
});

test('oxygenDrive: zero at set-point 10, near-exponential below, highest rate boost', (t) => {
  t.is(oxygenDrive({ oxygenLevel: 10 }).urgency, 0);
  const at5 = oxygenDrive({ oxygenLevel: 5 }).urgency;
  const at0 = oxygenDrive({ oxygenLevel: 0 }).urgency;
  t.true(at5 > 0);
  t.true(at0 > at5);
  t.is(oxygenDrive({ oxygenLevel: 0 }).rateBoost, 2);
});

test('threatDrive: quadratic near contact, creeper outweighs zombie', (t) => {
  const far = threatDrive({ nearestHostileDist: 16 }).urgency;
  const mid = threatDrive({ nearestHostileDist: 8 }).urgency;
  const close = threatDrive({ nearestHostileDist: 2 }).urgency;
  const contact = threatDrive({ nearestHostileDist: 0 }).urgency;
  t.is(far, 0);
  t.true(mid > far);
  t.true(close > mid);
  t.is(contact, 1);
  t.true(threatDrive({ nearestHostileDist: 2, hostileIsCreeper: true }).lethalityWeight > 0.8);
});

test('inventoryDrive: flat until blocking (<4 free slots)', (t) => {
  t.is(inventoryDrive({ freeSlots: 20 }).urgency, 0);
  t.is(inventoryDrive({ freeSlots: 3 }).urgency, 1);
});

test('toolDrive: linear below replace threshold, zero above', (t) => {
  t.is(toolDrive({ toolDurability: 0.5 }).urgency, 0);
  t.is(toolDrive({ toolDurability: 0 }).urgency, 1);
  t.is(toolDrive({ toolDurability: 0.05 }).urgency, 0.5);
  t.true(toolDrive({ toolDurability: 0.08 }).urgency > 0);
  t.true(toolDrive({ toolDurability: 0.08 }).urgency < 1);
});

test('arbitrate: low HP beats low hunger because its time-to-harm is shorter', (t) => {
  const health = healthDrive({ health: 4 });
  const hunger = hungerDrive({ food: 4 });
  t.true(health.timeToHarmSeconds < hunger.timeToHarmSeconds);
  const decision = arbitrate([hunger, health]);
  t.is(decision.action, 'drive');
  t.is(decision.winner!.id, 'health');
});

test('arbitrate: ranks drives descending by score', (t) => {
  const drives = [
    hungerDrive({ food: 4 }),
    healthDrive({ health: 4 }),
    inventoryDrive({ freeSlots: 3 })
  ];
  const decision = arbitrate(drives);
  t.is(decision.action, 'drive');
  const scores = decision.ranked.map(driveScore);
  for (let i = 1; i < scores.length; i++) {
    t.true(scores[i - 1] >= scores[i]);
  }
  t.is(decision.winner!.id, decision.ranked[0].id);
});

test('arbitrate: returns continue_goal when no drive exceeds the base threshold', (t) => {
  const decision = arbitrate([
    healthDrive({ health: 20 }),
    hungerDrive({ food: 20 }),
    oxygenDrive({ oxygenLevel: 20 })
  ]);
  t.is(decision.action, 'continue_goal');
  t.is(decision.winner, null);
});

test('arbitrate: empty drive list yields continue_goal', (t) => {
  const decision = arbitrate([]);
  t.is(decision.action, 'continue_goal');
  t.is(decision.winner, null);
});

test('duskPreemptActive: false mid-day, true within 10 min of dusk, true at night', (t) => {
  t.false(duskPreemptActive(6000)); // mid-day
  t.true(duskPreemptActive(11000)); // within the pre-dusk window
  t.true(duskPreemptActive(13000)); // nightfall
  t.true(duskPreemptActive(14000)); // deep night
});

test('duskPreemptActive: false at dawn', (t) => {
  t.false(duskPreemptActive(0));
  t.false(duskPreemptActive(1000));
});

test('duskPreemptActive: honors a custom minutes-before-dusk window', (t) => {
  // With a 1-minute window the ramp starts much closer to dusk, so mid-day stays off.
  t.false(duskPreemptActive(11000, 1));
  t.true(duskPreemptActive(12900, 1));
});

test('nightDrive: urgency 0 when indoors with light', (t) => {
  const d = nightDrive({ timeOfDay: 14000, isIndoors: true, hasLight: true });
  t.is(d.urgency, 0);
});

test('nightDrive: ramps before dusk and spikes after dark when exposed', (t) => {
  const ramping = nightDrive({ timeOfDay: 11000 }).urgency;
  const exposedNight = nightDrive({ timeOfDay: 14000 }).urgency;
  const midday = nightDrive({ timeOfDay: 6000 }).urgency;
  t.is(midday, 0);
  t.true(ramping > 0 && ramping < 1);
  t.is(exposedNight, 1);
});

test('nightDrive: time-to-harm shortens toward dusk', (t) => {
  const before = nightDrive({ timeOfDay: 11000 }).timeToHarmSeconds;
  const afterDark = nightDrive({ timeOfDay: 14000 }).timeToHarmSeconds;
  t.true(before > afterDark);
});

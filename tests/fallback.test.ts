import test from 'ava';
import {
  commitLadder,
  descendLadder,
  resourceCushionOK,
  twoStrikeShouldSwitch
} from '../src/fallback.js';

test('commitLadder: pre-commits 4 plans', (t) => {
  const ladder = commitLadder('mine_iron', {
    aggressive: 'strip mine at high speed',
    conservative: 'branch mine slowly with backup',
    surrender: 'return to base',
    passive: 'hide in shelter until safe'
  });
  t.is(ladder.goal, 'mine_iron');
  t.is(ladder.planA.rung, 'A');
  t.true(ladder.planA.aggressive);
  t.is(ladder.planB.rung, 'B');
  t.is(ladder.planC.rung, 'C');
  t.is(ladder.planD.rung, 'D');
});

test('descendLadder: A -> B -> C -> D', (t) => {
  const ladder = commitLadder('mine_iron', {
    aggressive: 'a', conservative: 'b', surrender: 'c', passive: 'd'
  });
  t.is(descendLadder(ladder, 'A')!.rung, 'B');
  t.is(descendLadder(ladder, 'B')!.rung, 'C');
  t.is(descendLadder(ladder, 'C')!.rung, 'D');
  t.is(descendLadder(ladder, 'D'), null);
});

test('resourceCushionOK: blocks caving when HP or food is low', (t) => {
  t.false(resourceCushionOK({ health: 4, food: 10, toolDurabilityPercent: 50 }, 'cave'));
  t.false(resourceCushionOK({ health: 12, food: 5, toolDurabilityPercent: 50 }, 'cave'));
  t.false(resourceCushionOK({ health: 12, food: 12, toolDurabilityPercent: 3 }, 'cave'));
  t.true(resourceCushionOK({ health: 12, food: 12, toolDurabilityPercent: 50 }, 'cave'));
});

test('resourceCushionOK: unknown values pass (defensive)', (t) => {
  t.true(resourceCushionOK({}, 'cave'));
});

test('resourceCushionOK: generic has looser thresholds', (t) => {
  t.true(resourceCushionOK({ health: 5, food: 5 }, 'generic'));
});

test('twoStrikeShouldSwitch: true after 2 failed mitigations', (t) => {
  t.false(twoStrikeShouldSwitch(1, ['dig faster']));
  t.false(twoStrikeShouldSwitch(2, ['dig faster', 'dig faster']));
  t.true(twoStrikeShouldSwitch(2, ['dig faster', 'use a pickaxe']));
  t.false(twoStrikeShouldSwitch(0, ['a', 'b']));
});

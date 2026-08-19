import test from 'ava';
import { Vec3 } from 'vec3';
import type mineflayer from 'mineflayer';
import { planGoal } from '../src/tools/task-runner-tools.js';
import { knownGoodLevels } from '../src/mining-strategy.js';

function makeBot(): mineflayer.Bot {
  return {
    entity: { position: new Vec3(0, 64, 0) }
  } as unknown as mineflayer.Bot;
}

test('planGoal collect ore annotates branch mining with known good levels', (t) => {
  const plan = planGoal('collect 32 diamond_ore', { bot: makeBot() });
  t.true(plan.ok);
  if (plan.ok) {
    t.is(plan.mining?.strategy, 'branch');
    t.true(plan.mining!.yLevels.includes(-59));
    t.true(plan.mining!.spacing > 0);
    t.true(plan.mining!.plan.branches.length > 0);
  }
});

test('planGoal collect non-ore has no mining annotation', (t) => {
  const plan = planGoal('collect 32 wood', { bot: makeBot() });
  t.true(plan.ok);
  if (plan.ok) {
    t.is(plan.mining, undefined);
  }
});

test('planGoal UCB exploration decays when the same gather goal is planned repeatedly', (t) => {
  const first = planGoal('collect 32 wood', { bot: makeBot() });
  const second = planGoal('collect 32 wood', { bot: makeBot() });
  t.true(first.ok && second.ok);
  if (first.ok && second.ok) {
    t.true(first.exploration!.ucbScore > second.exploration!.ucbScore);
    t.is(first.exploration!.recommended.length > 0, true);
  }
});

test('knownGoodLevels iron includes the good mining levels', (t) => {
  const levels = knownGoodLevels('iron');
  t.true(levels.includes(15));
  t.true(levels.includes(-59));
});

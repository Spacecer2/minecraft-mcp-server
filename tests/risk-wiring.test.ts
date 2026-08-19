import test from 'ava';
import type mineflayer from 'mineflayer';
import {
  utility,
  riskAwareUtility,
  botDeathProbability,
  bestOption,
  DEFAULT_WEIGHTS,
  UtilityInput
} from '../src/utility.js';
import {
  createGoalContext,
  executeGoal,
  GoalSpec,
  GoalStep,
  pickBestFallback,
  preFlightSafetyCheck,
  WeightedFallback
} from '../src/goal-core.js';
import { recordDeath, resetDeathRegisterForTest, queryGuards } from '../src/death-register.js';

function fakeBot(health?: number, torchCount = 0): mineflayer.Bot {
  return {
    health,
    inventory: {
      items: () => Array.from({ length: torchCount }, () => ({ name: 'torch', count: 1 }))
    }
  } as unknown as mineflayer.Bot;
}

function step(name: string, result: { status: 'done'; report: string }): GoalStep {
  return { name, run: async () => result };
}

// ava's beforeEach hook does not fire under this tsx/esm setup, so each test
// resets the shared death register explicitly.

test('utility: pDeath raises the risk cost (lower score) vs without', (t) => {
  const base: UtilityInput = { value: 0.8, importance: 0.8, risk: 0.2 };
  const without = utility(base, DEFAULT_WEIGHTS);
  const withPD = utility({ ...base, pDeath: 0.3 }, DEFAULT_WEIGHTS);
  t.true(withPD < without);
  t.true(Number.isFinite(withPD));
});

test('utility: behavior unchanged when pDeath is absent (or zero)', (t) => {
  const base: UtilityInput = { value: 0.8, importance: 0.8, risk: 0.2 };
  const without = utility(base, DEFAULT_WEIGHTS);
  const withZero = utility({ ...base, pDeath: 0 }, DEFAULT_WEIGHTS);
  t.is(withZero, without);
});

test('utility: pDeath scales with the risk weight (risk-averse)', (t) => {
  const input: UtilityInput = { value: 0.8, importance: 0.8, risk: 0.2, pDeath: 0.4 };
  const cautious = utility(input, { ...DEFAULT_WEIGHTS, riskWeight: 2 });
  const relaxed = utility(input, { ...DEFAULT_WEIGHTS, riskWeight: 0.5 });
  t.true(cautious < relaxed);
});

test('riskAwareUtility: low-health + nearby hostile scores lower than healthy+safe', (t) => {
  const input: UtilityInput = { value: 0.9, importance: 0.9 };
  const healthySafe = riskAwareUtility(
    { health: 20, entity: { position: { x: 0, y: 64, z: 0 } }, entities: new Map() },
    input,
    DEFAULT_WEIGHTS
  );
  const lowHpHostile = riskAwareUtility(
    {
      health: 3,
      entity: { position: { x: 0, y: 64, z: 0 } },
      entities: new Map([[1, { type: 'mob', position: { x: 2, y: 64, z: 0 } }]])
    },
    input,
    DEFAULT_WEIGHTS
  );
  t.true(lowHpHostile < healthySafe);
});

test('botDeathProbability: thin wrapper derives pDeath from bot state', (t) => {
  const safe = botDeathProbability({ health: 20, entity: { position: { x: 0, y: 64, z: 0 } } });
  const lethal = botDeathProbability({ health: 20, entity: { position: { x: 0, y: -100, z: 0 } } });
  t.true(safe < 0.3);
  t.is(lethal, 1);
});

test('botDeathProbability: unknown bot state is defensive (near-zero risk)', (t) => {
  t.true(botDeathProbability(null) < 0.1);
  t.true(botDeathProbability(undefined) < 0.1);
});

test('pickBestFallback: with a bot, a safe nearby option beats a risky far option', (t) => {
  const options: WeightedFallback[] = [
    {
      id: 'harvest',
      input: { value: 0.8, importance: 0.9, distanceBlocks: 2, timeSeconds: 5, risk: 0 }
    },
    {
      id: 'villager',
      input: { value: 0.9, importance: 0.9, distanceBlocks: 40, timeSeconds: 20, risk: 0.6 }
    }
  ];
  // Bot in mortal danger: low health + a hostile mob at arm's reach -> pDeath ~1.
  const dangerousBot = {
    health: 3,
    entity: { position: { x: 0, y: 64, z: 0 } },
    entities: new Map([[1, { type: 'mob', position: { x: 1, y: 64, z: 0 } }]])
  };
  t.true(botDeathProbability(dangerousBot) > 0.5); // fixture is genuinely dangerous
  t.is(pickBestFallback(options, dangerousBot), 'harvest');
  const safeBot = { health: 20, entity: { position: { x: 0, y: 64, z: 0 } }, entities: new Map() };
  t.is(pickBestFallback(options, safeBot), 'harvest');
});

test('pickBestFallback: 1-arg call is unchanged (raw bestOption path)', (t) => {
  const options: WeightedFallback[] = [
    { id: 'harvest', input: { value: 0.8, importance: 0.9, distanceBlocks: 2, timeSeconds: 5, risk: 0 } },
    { id: 'villager', input: { value: 0.9, importance: 0.9, distanceBlocks: 40, timeSeconds: 20, risk: 0.6 } }
  ];
  const expected = bestOption(options, (o) => o.input)?.id ?? null;
  t.is(pickBestFallback(options), expected);
  t.is(pickBestFallback(options), 'harvest');
});

test('preFlightSafetyCheck includes guard requirements for a caving goal after a recorded death', (t) => {
  resetDeathRegisterForTest();
  recordDeath({ location: 'cave-alpha', cause: 'hostile', hpAtDeath: 6, action: 'caving' });

  // The register learns the torch + HP guards from that death.
  const guards = queryGuards('caving', { action: 'caving' });
  t.true(guards.guards.some((g) => g.guard === 'torches>=8'));
  t.true(guards.guards.some((g) => g.guard === 'hp>=10'));

  // Low HP + no torches -> both guards unmet -> reflected in the result.
  const bot = fakeBot(6, 0);
  const result = preFlightSafetyCheck(bot, 'caving');
  t.false(result.ok);
  t.true(Array.isArray(result.guards));
  t.true(result.guards!.includes('torches>=8'));
  t.true(result.guards!.includes('hp>=10'));
  t.true(result.violated.includes('torches>=8'));

  resetDeathRegisterForTest();
});

test('preFlightSafetyCheck passes caving guards when the bot satisfies them', (t) => {
  resetDeathRegisterForTest();
  recordDeath({ location: 'cave-alpha', cause: 'hostile', hpAtDeath: 6, action: 'caving' });

  const bot = fakeBot(18, 10);
  const result = preFlightSafetyCheck(bot, 'caving');
  t.true(result.ok);
  t.is(result.guards?.length ?? 0, 0);

  resetDeathRegisterForTest();
});

test('preFlightSafetyCheck stays backward compatible with no goal name (no guards)', (t) => {
  resetDeathRegisterForTest();
  const result = preFlightSafetyCheck(fakeBot(18), undefined);
  t.true(result.ok);
  t.deepEqual(result.violated, []);
  t.is(result.guards, undefined);

  resetDeathRegisterForTest();
});

test('executeGoal constraint_violation includes guard requirements in context', async (t) => {
  resetDeathRegisterForTest();
  recordDeath({ location: 'cave-alpha', cause: 'hostile', hpAtDeath: 6, action: 'caving' });

  const ctx = createGoalContext(fakeBot(5, 0));
  const spec: GoalSpec = {
    name: 'caving',
    steps: [step('explore', { status: 'done', report: 'X' })]
  };
  const out = await executeGoal(ctx, spec);
  t.is(out.status, 'blocked');
  t.truthy(out.needDecision);
  t.is(out.needDecision!.reason, 'constraint_violation');
  const context = out.needDecision!.context as { violated: string[]; guards?: string[] };
  t.true(context.guards!.includes('torches>=8'));
  t.true(context.guards!.includes('hp>=10'));

  resetDeathRegisterForTest();
});
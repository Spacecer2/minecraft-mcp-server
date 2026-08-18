import test from 'ava';
import type mineflayer from 'mineflayer';
import {
  createGoalContext,
  executeGoal,
  GoalSpec,
  GoalStep,
  GoalStepResult
} from '../src/goal-core.js';
import { setInterrupt, clearInterrupt } from '../src/interrupt.js';

function fakeBot(): mineflayer.Bot {
  return {} as mineflayer.Bot;
}

function step(name: string, result: GoalStepResult): GoalStep {
  return { name, run: async () => result };
}

test('executeGoal returns done and concatenates per-step reports', async (t) => {
  const ctx = createGoalContext(fakeBot());
  const spec: GoalSpec = {
    name: 'test',
    steps: [
      step('a', { status: 'done', report: 'A' }),
      step('b', { status: 'done', report: 'B' })
    ]
  };
  const out = await executeGoal(ctx, spec);
  t.is(out.status, 'done');
  t.is(out.report, 'A → B');
  t.deepEqual(ctx.report, ['A', 'B']);
});

test('executeGoal continues past a blocked<3 step and still finishes done', async (t) => {
  const ctx = createGoalContext(fakeBot());
  const spec: GoalSpec = {
    name: 'test',
    steps: [
      step('a', { status: 'blocked', intensity: 2, reason: 'skip me', context: { x: 1 } }),
      step('b', { status: 'done', report: 'B' })
    ]
  };
  const out = await executeGoal(ctx, spec);
  t.is(out.status, 'done');
  t.is(out.report, 'B');
});

test('executeGoal returns needDecision when a step blocks at intensity >= 3', async (t) => {
  const ctx = createGoalContext(fakeBot());
  const spec: GoalSpec = {
    name: 'makeBread',
    steps: [
      step('makeFood', { status: 'blocked', intensity: 3, reason: 'no wheat available', context: { missing: 'wheat' } })
    ]
  };
  const out = await executeGoal(ctx, spec);
  t.is(out.status, 'blocked');
  t.truthy(out.needDecision);
  t.is(out.needDecision!.goal, 'makeBread');
  t.is(out.needDecision!.step, 'makeFood');
  t.is(out.needDecision!.reason, 'no wheat available');
  t.deepEqual(out.needDecision!.context, { missing: 'wheat' });
});

test('executeGoal stops at blocked>=3 and does not run later steps', async (t) => {
  let bRan = false;
  const ctx = createGoalContext(fakeBot());
  const spec: GoalSpec = {
    name: 'test',
    steps: [
      step('a', { status: 'blocked', intensity: 3, reason: 'blocked', context: {} }),
      { name: 'b', run: async () => { bRan = true; return { status: 'done', report: 'B' }; } }
    ]
  };
  const out = await executeGoal(ctx, spec);
  t.is(out.status, 'blocked');
  t.truthy(out.needDecision);
  t.is(out.needDecision!.step, 'a');
  t.false(bRan);
});

test('executeGoal returns interrupted when the interrupt flag is set', async (t) => {
  clearInterrupt();
  setInterrupt('watchdog: low health');
  t.teardown(() => clearInterrupt());

  const ctx = createGoalContext(fakeBot());
  const spec: GoalSpec = { name: 'test', steps: [step('a', { status: 'done', report: 'A' })] };
  const out = await executeGoal(ctx, spec);
  t.is(out.status, 'interrupted');
  t.true(out.report.includes('[INTERRUPTED]'));
  t.true(out.report.includes('watchdog'));
});

test('executeGoal returns interrupted when a step reports interrupted', async (t) => {
  clearInterrupt();
  t.teardown(() => clearInterrupt());

  const ctx = createGoalContext(fakeBot());
  const spec: GoalSpec = { name: 'test', steps: [step('a', { status: 'interrupted', reason: 'bailed' })] };
  const out = await executeGoal(ctx, spec);
  t.is(out.status, 'interrupted');
  t.true(out.report.includes('[INTERRUPTED]'));
  t.true(out.report.includes('bailed'));
});

test('executeGoal returns done with a single-step report', async (t) => {
  const ctx = createGoalContext(fakeBot());
  const spec: GoalSpec = {
    name: 'test',
    steps: [step('only', { status: 'done', report: 'only result' })]
  };
  const out = await executeGoal(ctx, spec);
  t.is(out.status, 'done');
  t.is(out.report, 'only result');
});

test('executeGoal skips empty reports from no-op steps', async (t) => {
  const ctx = createGoalContext(fakeBot());
  const spec: GoalSpec = {
    name: 'test',
    steps: [
      step('a', { status: 'done', report: 'A' }),
      step('noop', { status: 'done', report: '' }),
      step('c', { status: 'done', report: 'C' })
    ]
  };
  const out = await executeGoal(ctx, spec);
  t.is(out.status, 'done');
  t.is(out.report, 'A → C');
  t.deepEqual(ctx.report, ['A', 'C']);
});

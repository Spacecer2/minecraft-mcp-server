import test from 'ava';
import type mineflayer from 'mineflayer';
import { GoalSpec, GoalStep, GoalStepResult } from '../src/goal-core.js';
import { orchestrateGoal, hasStandingInterrupt, standingInterruptReason } from '../src/goal-orchestrator.js';
import { setInterrupt, clearInterrupt } from '../src/interrupt.js';
import { resetWatchdogForTest } from '../src/watchdog.js';

function fakeBot(): mineflayer.Bot {
  return {} as mineflayer.Bot;
}

function step(name: string, result: GoalStepResult): GoalStep {
  return { name, run: async () => result };
}

test.beforeEach(() => {
  resetWatchdogForTest();
  clearInterrupt();
});

test.serial('orchestrateGoal runs a simple goal to done when no interrupt is pending', async (t) => {
  const spec: GoalSpec = {
    name: 'test',
    steps: [step('a', { status: 'done', report: 'A' }), step('b', { status: 'done', report: 'B' })]
  };
  const out = await orchestrateGoal(fakeBot(), spec);
  t.is(out.status, 'done');
  t.is(out.report, 'A → B');
});

test.serial('orchestrateGoal pauses with watchdog-paused when a standing interrupt exists', async (t) => {
  setInterrupt('hostiles within 5 blocks');
  const spec: GoalSpec = {
    name: 'test',
    steps: [step('a', { status: 'done', report: 'A' })]
  };
  const out = await orchestrateGoal(fakeBot(), spec);
  t.is(out.status, 'watchdog-paused');
  t.true(out.report.includes('Paused before starting'));
  t.true(out.report.includes('hostiles within 5 blocks'));
  clearInterrupt();
});

test.serial('orchestrateGoal surfaces needDecision on a blocked-3 step', async (t) => {
  const spec: GoalSpec = {
    name: 'test',
    steps: [step('a', { status: 'blocked', intensity: 3, reason: 'no wheat', context: { missing: 'wheat' } })]
  };
  const out = await orchestrateGoal(fakeBot(), spec);
  t.is(out.status, 'blocked');
  t.truthy(out.needDecision);
  t.is(out.needDecision!.reason, 'no wheat');
  t.deepEqual(out.needDecision!.context, { missing: 'wheat' });
});

test.serial('orchestrateGoal continues past a blocked<3 step', async (t) => {
  const spec: GoalSpec = {
    name: 'test',
    steps: [
      step('a', { status: 'blocked', intensity: 2, reason: 'skip me', context: {} }),
      step('b', { status: 'done', report: 'B' })
    ]
  };
  const out = await orchestrateGoal(fakeBot(), spec);
  t.is(out.status, 'done');
  t.is(out.report, 'B');
});

test.serial('hasStandingInterrupt reflects the interrupt flag', async (t) => {
  t.false(hasStandingInterrupt());
  setInterrupt('test');
  t.true(hasStandingInterrupt());
  t.is(standingInterruptReason(), 'test');
  clearInterrupt();
  t.false(hasStandingInterrupt());
});

import test from 'ava';
import type mineflayer from 'mineflayer';
import {
  planGoal,
  dominantDrive,
  dayPhaseForBot,
  resetTaskRuns
} from '../src/tools/task-runner-tools.js';
import { phaseFor, minutesToDusk } from '../src/day-rhythm.js';

type AnyBot = Partial<mineflayer.Bot>;

function makeBot(timeOfDay?: number): AnyBot {
  const bot: AnyBot = {
    version: '1.21',
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: { items: () => [] }
  };
  if (timeOfDay !== undefined) {
    (bot as { time?: { timeOfDay?: number } }).time = { timeOfDay };
  }
  return bot;
}

test.serial('planGoal allows an outdoor gather goal at mid-day (timeOfDay 6000)', (t) => {
  resetTaskRuns();
  const bot = makeBot(6000);
  const plan = planGoal('collect 16 wood', { bot: bot as mineflayer.Bot });
  t.true(plan.ok);
  if (plan.ok) {
    t.is(plan.goalName, 'collect 16 wood');
    t.true(plan.steps.length >= 1);
    t.is(plan.steps[plan.steps.length - 1].name, 'gatherItem');
    t.is(plan.dayPhase, 'MIDDAY');
    t.deepEqual(plan.suggestedActivities, ['hunt', 'mine', 'build', 'high-risk high-precision tasks']);
  }
});

test.serial('planGoal refuses an outdoor gather goal near dusk (timeOfDay 11900)', (t) => {
  resetTaskRuns();
  t.true(minutesToDusk(11900) < 10, 'sanity: 11900 is within 10 real minutes of dusk');
  const bot = makeBot(11900);
  const plan = planGoal('collect 16 wood', { bot: bot as mineflayer.Bot });
  t.false(plan.ok);
  if (!plan.ok) {
    t.true(plan.error.includes('Too late in the day to start collect 16 wood'));
    t.true(plan.error.includes('dusk clock'));
    t.true(plan.error.includes(`phase: ${phaseFor(11900)}`));
  }
});

test.serial('planGoal keeps build goals allowed near dusk', (t) => {
  resetTaskRuns();
  const bot = makeBot(11900);
  const plan = planGoal('build a house', { template: 'house', bot: bot as mineflayer.Bot });
  t.true(plan.ok);
  if (plan.ok) {
    t.is(plan.goalName, 'build house');
    t.true(plan.steps.length >= 1);
  }
});

test.serial('dominantDrive returns hunger as the winner when food is very low and health is full', (t) => {
  const bot = {
    health: 20,
    food: 2,
    inventory: { items: () => [] }
  } as AnyBot;
  const decision = dominantDrive(bot as mineflayer.Bot);
  t.is(decision.action, 'drive');
  t.truthy(decision.winner);
  t.is(decision.winner!.id, 'hunger');
  t.true(decision.winner!.urgency > 0.6);
});

test.serial('dayPhaseForBot returns the phase derived from bot time', (t) => {
  t.is(dayPhaseForBot(makeBot(6000) as mineflayer.Bot), 'MIDDAY');
  t.is(dayPhaseForBot(makeBot(11900) as mineflayer.Bot), 'LATE_AFTERNOON');
  t.is(dayPhaseForBot(makeBot(15000) as mineflayer.Bot), 'NIGHT');
});

test.serial('dominantDrive stays on continue_goal when all bars are full', (t) => {
  const bot = {
    health: 20,
    food: 20,
    oxygenLevel: 20,
    inventory: { items: () => [] }
  } as AnyBot;
  const decision = dominantDrive(bot as mineflayer.Bot);
  t.is(decision.action, 'continue_goal');
  t.is(decision.winner, null);
});

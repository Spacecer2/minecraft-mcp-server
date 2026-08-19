import test from 'ava';
import type mineflayer from 'mineflayer';
import { GoalSpec, GoalStep, GoalStepResult } from '../src/goal-core.js';
import {
  startGoalRun,
  statusOf,
  resolveRun,
  resetGoalRuns,
  setGoalMessageStoreResolver
} from '../src/goal-runner.js';
import { lessonStore } from '../src/postmortem.js';
import type { MessageStore } from '../src/message-store.js';

const BOT_USERNAME = 'learning-bot';
let captured: { content: string }[] = [];

function fakeBot(): mineflayer.Bot {
  return {
    entity: { position: { x: 0, y: 64, z: 0 } },
    username: BOT_USERNAME
  } as unknown as mineflayer.Bot;
}

function blockedStep(name: string, reason: string): GoalStep {
  return {
    name,
    run: async (): Promise<GoalStepResult> => ({
      status: 'blocked',
      reason,
      intensity: 3,
      context: { step: name }
    })
  };
}

/** Blocks on the first call (deep block), then succeeds once resumed. */
function blockThenSucceedStep(name: string, reason: string): GoalStep {
  let calls = 0;
  return {
    name,
    run: async (): Promise<GoalStepResult> => {
      calls += 1;
      if (calls === 1) {
        return { status: 'blocked', reason, intensity: 3, context: { step: name } };
      }
      return { status: 'done', report: `${name} with the correct tool` };
    }
  };
}

function makeSpec(name: string, steps: GoalStep[]): GoalSpec {
  return { name, steps };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
  intervalMs = 10
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function captureMessages(): void {
  captured = [];
  setGoalMessageStoreResolver((name: string): MessageStore | undefined => {
    if (name !== BOT_USERNAME) return undefined;
    return {
      addMessage: (_u: string, content: string) => {
        captured.push({ content });
      }
    } as unknown as MessageStore;
  });
}

function allLines(): string {
  return captured.map((m) => m.content).join('\n');
}

test.serial('preventable deep block records a lesson and enriches needDecision.context.lesson', async (t) => {
  lessonStore.resetPostmortemForTest();
  resetGoalRuns();
  captureMessages();

  const id = startGoalRun(
    fakeBot(),
    makeSpec('mine_ore', [blockedStep('break', 'missing tool to break stone')]),
    'mine ore test',
    5
  );
  t.true(id > 0);
  await waitFor(() => statusOf(id)?.status === 'awaiting-decision');

  t.is(lessonStore.getLessonCount(), 1);

  const goal = statusOf(id)!;
  t.truthy(goal.needDecision);
  const ctx = goal.needDecision!.context;
  t.truthy(ctx.lesson, 'needDecision.context should include a lesson');
  t.is(typeof (ctx.lesson as { ifState: string }).ifState, 'string');
  t.is(typeof (ctx.lesson as { thenMitigation: string }).thenMitigation, 'string');

  const lines = allLines();
  t.true(lines.includes('[IMPASSE]'), 'should write an IMPASSE line');
  t.true(lines.includes('BLOCKED'), 'should keep the BLOCKED line');

  resetGoalRuns();
});

test.serial('repeated deep block triggers the two-strike suggestion line', async (t) => {
  lessonStore.resetPostmortemForTest();
  resetGoalRuns();
  captureMessages();

  const id = startGoalRun(
    fakeBot(),
    makeSpec('mine_ore', [blockedStep('break', 'missing tool to break stone')]),
    'mine ore two-strike',
    5
  );
  await waitFor(() => statusOf(id)?.status === 'awaiting-decision');

  resolveRun(id, 'try a different tool');

  await waitFor(() => statusOf(id)?.status === 'awaiting-decision');

  const lines = allLines();
  t.true(lines.includes('[TWO-STRIKE]'), 'two-strike line should be written after 2 consecutive blocks');
  t.true(lines.includes('[LADDER]'), 'ladder line should be written');

  resetGoalRuns();
});

test.serial('random/RNG-classifiable block does NOT grow the lesson store', async (t) => {
  lessonStore.resetPostmortemForTest();
  resetGoalRuns();
  captureMessages();

  const id = startGoalRun(
    fakeBot(),
    makeSpec('hunt', [blockedStep('attack', 'random creeper spawn blocked the path')]),
    'hunt test',
    5
  );
  await waitFor(() => statusOf(id)?.status === 'awaiting-decision');

  t.is(lessonStore.getLessonCount(), 0, 'random blocks must not record a lesson');

  const goal = statusOf(id)!;
  const ctx = goal.needDecision!.context;
  t.falsy(ctx.lesson, 'random blocks must not add a lesson to context');

  resetGoalRuns();
});

test.serial('deep block creates a subgoal and later success chunks a lesson (feedback loop)', async (t) => {
  lessonStore.resetPostmortemForTest();
  resetGoalRuns();
  captureMessages();

  const id = startGoalRun(
    fakeBot(),
    makeSpec('mine_ore', [blockThenSucceedStep('break', 'missing tool to break stone')]),
    'mine ore chunk feedback',
    5
  );
  await waitFor(() => statusOf(id)?.status === 'awaiting-decision');

  // The impasse creates a subgoal that ONLY removes the blockage.
  const goal = statusOf(id)!;
  t.truthy(goal.needDecision);
  const ctx = goal.needDecision!.context;
  t.truthy(ctx.diagnosis, 'needDecision.context should include a diagnosis');
  t.truthy(ctx.subgoal, 'needDecision.context should include the impasse subgoal');
  const subgoal = ctx.subgoal as { goal: string; action: string };
  t.is(subgoal.goal, 'mine_ore');
  t.true(subgoal.action.length > 0, 'subgoal action should be non-empty');

  const countBefore = lessonStore.getLessonCount();

  // Resume with an instruction; the same step now succeeds -> CHUNK the fix.
  resolveRun(id, 'use a stone pickaxe');
  await waitFor(() => statusOf(id)?.status === 'done');

  t.true(
    lessonStore.getLessonCount() > countBefore,
    'chunked lesson should be recorded once the subgoal fix succeeds'
  );
  t.true(allLines().includes('[CHUNK]'), 'should write a [CHUNK] line when the fix is chunked');

  resetGoalRuns();
});

test.serial('learned guards are injected into needDecision context for re-planning', async (t) => {
  lessonStore.resetPostmortemForTest();
  resetGoalRuns();
  captureMessages();

  const id = startGoalRun(
    fakeBot(),
    makeSpec('mine_ore', [blockedStep('break', 'missing tool to break stone')]),
    'mine ore guards',
    5
  );
  await waitFor(() => statusOf(id)?.status === 'awaiting-decision');

  const goal = statusOf(id)!;
  const ctx = goal.needDecision!.context;
  t.truthy(Array.isArray(ctx.guardsToInject), 'context should carry an injected-guards array');
  t.true(
    (ctx.guardsToInject as unknown[]).length >= 1,
    'a lesson learned for the same goal should be injected as a guard'
  );
  const first = (ctx.guardsToInject as { lessonId: string; ifState: string; thenMitigation: string }[])[0];
  t.is(typeof first.lessonId, 'string');
  t.is(typeof first.ifState, 'string');
  t.is(typeof first.thenMitigation, 'string');

  resetGoalRuns();
});

test.serial('fallbackState fully resets after a successful step', async (t) => {
  lessonStore.resetPostmortemForTest();
  resetGoalRuns();
  captureMessages();

  const id = startGoalRun(
    fakeBot(),
    makeSpec('mine_ore', [blockThenSucceedStep('break', 'missing tool to break stone')]),
    'mine ore reset',
    5
  );
  await waitFor(() => statusOf(id)?.status === 'awaiting-decision');

  const mid = statusOf(id)!;
  t.truthy(mid.fallbackState, 'deep block should establish fallbackState');
  t.is(mid.fallbackState!.consecutiveBlocks, 1);
  t.truthy(mid.pendingImpasse, 'deep block should leave a pending impasse');

  resolveRun(id, 'use a stone pickaxe');
  await waitFor(() => statusOf(id)?.status === 'done');

  const after = statusOf(id)!;
  t.truthy(after.fallbackState, 'fallbackState object should still exist after success');
  t.is(after.fallbackState!.consecutiveBlocks, 0, 'consecutiveBlocks should reset');
  t.is(after.fallbackState!.mitigations.length, 0, 'mitigations should reset');
  t.is(after.fallbackState!.ladder, null, 'ladder should reset');
  t.is(after.fallbackState!.currentRung, 'A', 'currentRung should reset');
  t.falsy(after.pendingImpasse, 'pending impasse should be cleared on success');

  resetGoalRuns();
});

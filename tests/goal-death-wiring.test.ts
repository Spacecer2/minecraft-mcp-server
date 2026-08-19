import test from 'ava';
import type mineflayer from 'mineflayer';
import { GoalSpec, GoalStep, GoalStepResult } from '../src/goal-core.js';
import {
  startGoalRun,
  abortRun,
  resetGoalRuns,
  setGoalMessageStoreResolver
} from '../src/goal-runner.js';
import { lessonStore } from '../src/postmortem.js';
import { deathRegister, resetDeathRegisterForTest } from '../src/death-register.js';
import type { MessageStore } from '../src/message-store.js';

const BOT_USERNAME = 'death-wiring-bot';
let captured: { content: string }[] = [];

function fakeBot(): mineflayer.Bot {
  return {
    entity: { position: { x: 0, y: 64, z: 0 } },
    username: BOT_USERNAME
  } as unknown as mineflayer.Bot;
}

/** A step that always dies with the given reason (report-then-resume path). */
function deathStep(name: string, reason: string): GoalStep {
  return {
    name,
    run: async (): Promise<GoalStepResult> => ({
      status: 'interrupted',
      reason
    })
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

test.serial('preventable death records a lesson, [LESSON] line, and death-register entry', async (t) => {
  lessonStore.resetPostmortemForTest();
  resetDeathRegisterForTest();
  resetGoalRuns();
  captureMessages();

  const id = startGoalRun(
    fakeBot(),
    makeSpec('mine_ore', [deathStep('break', 'bot fell into a ravine and died')]),
    'mine ore death',
    5
  );
  t.true(id > 0);

  await waitFor(() => lessonStore.getLessonCount() === 1);
  await waitFor(() => deathRegister.count() === 1);

  t.is(lessonStore.getLessonCount(), 1, 'preventable death must record exactly one lesson');
  t.is(deathRegister.count(), 1, 'preventable death must be recorded in the death register');

  const lines = allLines();
  t.true(lines.includes('[LESSON]'), 'should write a [LESSON] line for a preventable death');
  t.true(lines.includes('[DIED]'), 'should keep the [DIED] report-then-resume line');

  const entry = deathRegister.get()[0];
  t.is(entry.location, '(0,64,0)', 'death-register location should come from bot position');
  t.true(String(entry.cause).includes('fell'), 'death-register cause should reflect the reason');

  abortRun(id);
  resetGoalRuns();
});

test.serial('random death does NOT grow the lesson store but DOES record to the death register', async (t) => {
  lessonStore.resetPostmortemForTest();
  resetDeathRegisterForTest();
  resetGoalRuns();
  captureMessages();

  const id = startGoalRun(
    fakeBot(),
    makeSpec('hunt', [deathStep('attack', 'random creeper explosion caused death')]),
    'hunt death',
    5
  );
  t.true(id > 0);

  await waitFor(() => deathRegister.count() === 1);

  t.is(lessonStore.getLessonCount(), 0, 'random deaths must not record a lesson');
  t.is(deathRegister.count(), 1, 'random deaths must still be recorded in the death register');

  const lines = allLines();
  t.false(lines.includes('[LESSON]'), 'random deaths must not emit a [LESSON] line');

  abortRun(id);
  resetGoalRuns();
});

test.serial('same-reason repeated death is recorded only once (dedup)', async (t) => {
  lessonStore.resetPostmortemForTest();
  resetDeathRegisterForTest();
  resetGoalRuns();
  captureMessages();

  const id = startGoalRun(
    fakeBot(),
    makeSpec('mine_ore', [deathStep('break', 'bot fell into a ravine and died')]),
    'mine ore dedup',
    5
  );
  t.true(id > 0);

  // The death step keeps re-firing on every loop iteration; the postmortem must
  // fire exactly once for the distinct reason.
  await waitFor(() => deathRegister.count() === 1);
  await waitFor(() => lessonStore.getLessonCount() === 1);

  // Let a few more iterations spin past the first death.
  await new Promise((r) => setTimeout(r, 200));

  t.is(deathRegister.count(), 1, 'repeated same-reason death must not double-record');
  t.is(lessonStore.getLessonCount(), 1, 'repeated same-reason death must not double the lesson');

  abortRun(id);
  resetGoalRuns();
});

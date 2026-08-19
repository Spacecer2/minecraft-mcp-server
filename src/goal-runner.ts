/**
 * goal-runner.ts — background goal runner.
 *
 * Fixes "LLM idleness": run-goal was a single blocking tool call that ran a
 * deterministic goal to completion while the LLM sat idle. This module runs a
 * goal as a BACKGROUND loop that advances one step at a time (sleeping/yielding
 * between steps), writes progress lines to the bot's MessageStore, and pauses
 * on watchdog interrupts or deep blocks (awaiting-decision) so the front brain
 * stays responsive and can resolve decisions / resume the goal.
 */
import mineflayer from 'mineflayer';
import { GoalOutcome, GoalSpec, GoalStep, GoalStepResult, createGoalContext } from './goal-core.js';
import { isInterrupted, getInterruptReason, isInterruptError } from './interrupt.js';
import { isDeathInterrupt } from './goal-orchestrator.js';
import type { MessageStore } from './message-store.js';
import {
  classifyFailure,
  attributeCause,
  generateLesson,
  lessonStore,
  injectGuards,
  FailureEpisode,
  GuardRule
} from './postmortem.js';
import {
  diagnoseImpasse,
  makeSubgoal,
  chunkLesson,
  escalate,
  BlockedInfo,
  Diagnosis,
  Subgoal
} from './impasse.js';
import { recordDeath } from './death-register.js';
import {
  commitLadder,
  descendLadder,
  twoStrikeShouldSwitch,
  FallbackLadder,
  LadderVariants,
  Rung
} from './fallback.js';

export type GoalTaskStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'awaiting-decision'
  | 'watchdog-paused';

/**
 * Per-task learning state for deep-block postmortems: tracks how many
 * consecutive deep blocks the goal has hit, the mitigations attempted, and
 * the pre-committed fallback ladder (Plan A/B/C/D).
 */
export interface FallbackState {
  consecutiveBlocks: number;
  mitigations: string[];
  ladder: FallbackLadder | null;
  currentRung: Rung;
}

export interface GoalTask {
  id: number;
  description: string;
  status: GoalTaskStatus;
  spec: GoalSpec;
  stepIndex: number;
  lastReport: string;
  needDecision?: GoalOutcome['needDecision'];
  error?: string;
  autoAdvanceMs: number;
  running: boolean;
  /** Learning state for postmortem / impasse / fallback modules (lazy). */
  fallbackState?: FallbackState;
  /**
   * Pending SOAR impasse state: the subgoal created when this task's step
   * deep-blocked, plus its diagnosis. Cleared once the step succeeds so the
   * fix can be chunked into a cached lesson.
   */
  pendingImpasse?: { subgoal: Subgoal; diagnosis: Diagnosis };
}

const goalTasks = new Map<number, GoalTask>();
const taskBots = new Map<number, mineflayer.Bot>();
/** Loop generation per task so a resume supersedes a stale loop still winding down. */
const taskEpochs = new Map<number, number>();
let lastGoalTaskId = 0;

// PROGRESS-LINE WIRING. This module has no reference to BotManager (which owns
// the per-bot MessageStores), so the host wires one resolver once at startup:
//
//   setGoalMessageStoreResolver((name) => manager.getStore(name));
//
// Until set, progress lines are skipped (graceful no-op). This keeps
// startGoalRun's signature exactly as the public API specifies. Username on
// each message is the bot's own, so read-new-chat surfaces it like any other
// bot line.
let storeResolver: ((botUsername: string) => MessageStore | undefined) | undefined;

export function setGoalMessageStoreResolver(
  resolver: ((botUsername: string) => MessageStore | undefined) | null | undefined
): void {
  storeResolver = resolver ?? undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeLine(bot: mineflayer.Bot, task: GoalTask, line: string): void {
  if (!storeResolver) return;
  const store = storeResolver(bot.username);
  if (store) {
    store.addMessage(bot.username, `[GOAL #${task.id}] ${line}`);
  }
}

// ---------------------------------------------------------------------------
// DEEP-BLOCK LEARNING PIPELINE (postmortem / impasse / fallback)
// ---------------------------------------------------------------------------

/**
 * Small default set of candidate guard rules used to attribute a preventable
 * / mitigable deep block to its cheapest guard. Kept purposefully small so
 * attributeCause stays deterministic for common step failures.
 */
const DEFAULT_CANDIDATE_RULES: GuardRule[] = [
  { id: 'gather_resources_beforehand', cause: 'resource', cost: 2, generality: 3 },
  { id: 'ensure_tool_durability', cause: 'durability', cost: 1, generality: 2 },
  { id: 'place_torch_in_dark', cause: 'torch', cost: 1, generality: 2 },
  { id: 'avoid_dangerous_fall', cause: 'fell', cost: 3, generality: 2 },
  { id: 'carry_food', cause: 'hunger', cost: 1, generality: 2 }
];

/** Build the A/B/C/D fallback ladder variants from the task description. */
function ladderVariantsFor(task: GoalTask): LadderVariants {
  return {
    aggressive: `push harder on "${task.description}"`,
    conservative: `re-attempt "${task.description}" more safely`,
    surrender: 'return to base',
    passive: 'passive survival (shelter, hide, sleep)'
  };
}

/**
 * Run the deep-block learning pipeline for a blocked step at intensity >= 3
 * (the awaiting-decision branch). This is purely additive: it records lessons,
 * writes IMPASSE / LADDER / TWO-STRIKE progress lines, and returns the
 * enriched needDecision context. It never changes the status flow.
 */
function handleDeepBlock(
  task: GoalTask,
  bot: mineflayer.Bot,
  step: GoalStep,
  result: Extract<GoalStepResult, { status: 'blocked' }>
): Record<string, unknown> {
  if (!task.fallbackState) {
    task.fallbackState = { consecutiveBlocks: 0, mitigations: [], ladder: null, currentRung: 'A' };
  }
  const fallback = task.fallbackState;
  fallback.consecutiveBlocks += 1;
  const context: Record<string, unknown> = { ...result.context };

  // The whole learning pipeline is additive and best-effort: a learning bug
  // must never break the awaiting-decision flow, so it is wrapped and on error
  // we return the base context untouched.
  try {
    // --- 1. Postmortem -----------------------------------------------------
    const episode: FailureEpisode = {
      goal: task.spec.name,
      plan: task.description,
      stateSnapshot: { step: step.name, reason: result.reason, ...result.context },
      outcome: 'blocked',
      observedCause: result.reason
    };

    const failureClass = classifyFailure(episode);
    if (failureClass === 'preventable' || failureClass === 'mitigable') {
      const cause = attributeCause(episode, DEFAULT_CANDIDATE_RULES);
      const mitigation = cause
        ? `apply guard ${cause}`
        : `avoid the condition: ${result.reason}`;
      const lesson = generateLesson(episode, mitigation, cause ?? undefined);
      lessonStore.recordLesson(lesson);
      context.lesson = { ifState: lesson.ifState, thenMitigation: lesson.thenMitigation };
    }
    // random-classified failures are skipped (no lesson) to avoid overfitting.

    // --- 2. Impasse -> subgoal (SOAR) ---------------------------------------
    const blocked: BlockedInfo = {
      goal: task.spec.name,
      step: step.name,
      reason: result.reason,
      context: result.context
    };
    const diagnosis = diagnoseImpasse(blocked, {});
    context.diagnosis = diagnosis;
    writeLine(
      bot,
      task,
      `[IMPASSE] ${diagnosis.kind}: ${diagnosis.detail ?? diagnosis.reason}`
    );

    const subgoal = makeSubgoal(task.spec.name, diagnosis);
    task.pendingImpasse = { subgoal, diagnosis };
    context.subgoal = subgoal;

    // Repeated deep block: the subgoal also failed -> escalate and surface a
    // backup goal so the front brain has a concrete fallback to re-plan with.
    if (fallback.consecutiveBlocks > 1) {
      const backupGoal = fallback.ladder?.planC?.description ?? undefined;
      const escalation = escalate(task.spec.name, diagnosis, backupGoal);
      context.escalation = {
        backupGoal: escalation.backupGoal,
        lesson: {
          ifState: escalation.lesson.ifState,
          thenMitigation: escalation.lesson.thenMitigation
        }
      };
      writeLine(
        bot,
        task,
        `[ESCALATE] Subgoal blocked again — backup goal: ${escalation.backupGoal}.`
      );
    }

    // --- 3. Learned guard injection (downgrade-then-retry) -------------------
    // A lesson already learned for this goal becomes an auto-injected guard the
    // front brain / re-plan should honor on the next attempt.
    const guardsToInject = injectGuards(task.spec.name, lessonStore.lessonsFor(task.spec.name));
    if (guardsToInject.length > 0) {
      context.guardsToInject = guardsToInject;
    }

    // --- 4. Fallback ladder + two-strike -----------------------------------
    if (!fallback.ladder) {
      fallback.ladder = commitLadder(task.spec.name, ladderVariantsFor(task));
      fallback.currentRung = 'A';
    }
    // Repeated failure: descend one rung (A -> B -> C -> D) so the next
    // mitigation is categorically different, which is what two-strike needs.
    if (fallback.consecutiveBlocks > 1) {
      const next = descendLadder(fallback.ladder, fallback.currentRung);
      if (next) {
        fallback.currentRung = next.rung;
        writeLine(
          bot,
          task,
          `[LADDER] Plan failed again — descending to Plan ${next.rung} (${next.description}).`
        );
      }
    }
    const currentPlan =
      fallback.ladder[`plan${fallback.currentRung}` as 'planA' | 'planB' | 'planC' | 'planD'];
    if (!fallback.mitigations.includes(currentPlan.description)) {
      fallback.mitigations.push(currentPlan.description);
    }
    writeLine(
      bot,
      task,
      `[LADDER] On Plan ${currentPlan.rung} (${currentPlan.description}); this step blocked.`
    );
    if (twoStrikeShouldSwitch(fallback.consecutiveBlocks, fallback.mitigations)) {
      writeLine(
        bot,
        task,
        '[TWO-STRIKE] 2 mitigations failed — switch to a categorically different approach; consider Plan C (return to base) or Plan D (passive survival).'
      );
    }
  } catch (err) {
    writeLine(
      bot,
      task,
      `[LEARNING] deep-block pipeline error: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return context;
}

/** A compact position key for the death register location field. */
function posKey(position?: { x: number; y: number; z: number }): string {
  if (!position) return 'unknown';
  return `(${position.x},${position.y},${position.z})`;
}

/**
 * Run the death-learning pipeline when the bot dies (report-then-resume).
 * Purely additive: classifies the death, records a lesson for
 * preventable/mitigable causes, always writes the death to the register, and
 * emits a `[LESSON]` progress line. It never changes the status flow.
 *
 * Random-classified deaths are recorded to the register but SKIPPED for the
 * lesson store to avoid overfitting to RNG.
 */
function handleDeath(
  bot: mineflayer.Bot,
  task: GoalTask,
  reason: string,
  position?: { x: number; y: number; z: number }
): void {
  const episode: FailureEpisode = {
    goal: task.spec.name,
    plan: task.description,
    stateSnapshot: {
      stepIndex: task.stepIndex,
      reason,
      position: posKey(position)
    },
    outcome: 'death',
    observedCause: reason
  };

  const failureClass = classifyFailure(episode);
  if (failureClass === 'preventable' || failureClass === 'mitigable') {
    const cause = attributeCause(episode, DEFAULT_CANDIDATE_RULES);
    const mitigation = cause
      ? `apply guard ${cause}`
      : `avoid the condition: ${reason}`;
    const lesson = generateLesson(episode, mitigation, cause ?? undefined);
    lessonStore.recordLesson(lesson);
    writeLine(bot, task, `[LESSON] ${lesson.ifState} → ${lesson.thenMitigation}`);
  }
  // random-classified deaths are skipped (no lesson) to avoid overfitting.

  recordDeath({
    location: posKey(position),
    cause: reason,
    hpAtDeath: 0,
    action: task.spec.name,
    timestamp: Date.now()
  });
}


async function runLoop(id: number, bot: mineflayer.Bot): Promise<void> {
  const task = goalTasks.get(id);
  if (!task) return;
  // Each runLoop invocation bumps the epoch; any earlier loop for this task
  // becomes stale and exits at its next yield, so a resume can never run two
  // loops for the same task (double-stepping) nor leave the task stuck.
  const epoch = (taskEpochs.get(id) ?? 0) + 1;
  taskEpochs.set(id, epoch);
  task.running = true;
  task.status = 'running';
  const ctx = createGoalContext(bot);
  // The interrupt flag stays set until the watchdog clears it, so a death
  // interrupt would otherwise re-log a [DIED] line every step; dedup by reason.
  let loggedInterrupt: string | null = null;
  try {
    while (task.status === 'running' && task.stepIndex < task.spec.steps.length) {
      const step = task.spec.steps[task.stepIndex];

      await sleep(task.autoAdvanceMs);
      if (task.status !== 'running' || taskEpochs.get(id) !== epoch) break;

      // Watchdog pre-check. Death = report-then-resume (bot auto-respawned);
      // any other interrupt pauses the goal until watchdog-resume.
      if (isInterrupted()) {
        const reason = getInterruptReason() ?? '';
        if (isDeathInterrupt()) {
          if (reason !== loggedInterrupt) {
            loggedInterrupt = reason;
            handleDeath(bot, task, reason, bot.entity?.position);
            writeLine(bot, task, '[DIED] The bot died and respawned. Reported the death; resuming goal.');
          }
        } else {
          task.status = 'watchdog-paused';
          task.lastReport =
            `[WATCHDOG] Paused after ${task.stepIndex} step(s): ${reason}. ` +
            `Read read-interrupt, switch mode, then watchdog-resume to continue.`;
          writeLine(bot, task, task.lastReport);
          break;
        }
      }

      let result: GoalStepResult;
      try {
        result = await step.run(ctx);
      } catch (err) {
        if (isInterruptError(err)) {
          const reason = getInterruptReason() ?? 'Action cancelled by watchdog';
          if (isDeathInterrupt() || /died|death|DIED/i.test(reason)) {
            if (reason !== loggedInterrupt) {
              loggedInterrupt = reason;
              handleDeath(bot, task, reason, bot.entity?.position);
              writeLine(bot, task, `[DIED] ${reason} Reported the death; resuming goal.`);
            }
            continue;
          }
          task.status = 'watchdog-paused';
          task.lastReport =
            `[WATCHDOG] Paused mid-step: ${reason}. ` +
            `Read read-interrupt, switch mode, then watchdog-resume to continue.`;
          writeLine(bot, task, task.lastReport);
          break;
        }
        throw err;
      }

      if (result.status === 'interrupted') {
        if (isDeathInterrupt() || /died|death|DIED/i.test(result.reason)) {
          if (result.reason !== loggedInterrupt) {
            loggedInterrupt = result.reason;
            handleDeath(bot, task, result.reason, bot.entity?.position);
            writeLine(bot, task, `[DIED] ${result.reason} Reported the death; resuming goal.`);
          }
          continue;
        }
        task.status = 'watchdog-paused';
        task.lastReport = `[WATCHDOG] ${result.reason}`;
        writeLine(bot, task, task.lastReport);
        break;
      }

      if (result.status === 'done') {
        // SOAR feedback loop: if this step was deep-blocked and a subgoal was
        // pending, CHUNK the successful fix into a cached lesson so the same
        // goal learns the (context -> fix) mapping for next time.
        if (task.pendingImpasse) {
          try {
            const pending = task.pendingImpasse;
            const lesson = chunkLesson(
              pending.subgoal.goal,
              pending.diagnosis,
              pending.subgoal,
              true
            );
            if (lesson) {
              lessonStore.recordLesson(lesson);
              writeLine(bot, task, `[CHUNK] ${lesson.ifState} → ${lesson.thenMitigation}`);
            }
          } catch {
            // learning must never break the goal flow
          }
          task.pendingImpasse = undefined;
        }
        // A step succeeded — reset the FULL repeated-failure learning state so
        // the two-strike / ladder escalation only fires across consecutive
        // blocks and ladder/mitigation state cannot leak across successes.
        if (task.fallbackState) {
          task.fallbackState.consecutiveBlocks = 0;
          task.fallbackState.mitigations = [];
          task.fallbackState.ladder = null;
          task.fallbackState.currentRung = 'A';
        }
        task.stepIndex++;
        if (result.report) ctx.record(result.report);
        task.lastReport = result.report || `step '${step.name}' done`;
        writeLine(bot, task, `Step ${task.stepIndex}/${task.spec.steps.length} '${step.name}': ${result.report || 'done'}`);
        continue;
      }

      // result.status === 'blocked'
      if (result.intensity >= 3) {
        const context = handleDeepBlock(task, bot, step, result);
        task.status = 'awaiting-decision';
        task.needDecision = {
          goal: task.spec.name,
          step: step.name,
          reason: result.reason,
          context
        };
        task.lastReport =
          `BLOCKED at step '${step.name}': ${result.reason}. ` +
          `Awaiting your input — call resolve-run <instruction> or abort-run.`;
        writeLine(bot, task, task.lastReport);
        break;
      }
      // blocked with intensity < 3 is recoverable: skip to the next step.
      task.stepIndex++;
      task.lastReport = `Step '${step.name}' blocked (recoverable, skipped): ${result.reason}`;
      writeLine(bot, task, task.lastReport);
    }

    if (task.status === 'running') {
      task.status = 'done';
      const report = ctx.report.join(' → ') || task.spec.name;
      task.lastReport = report;
      writeLine(bot, task, `Goal #${task.id} complete: ${report}`);
    }
  } catch (err) {
    task.status = 'failed';
    task.error = err instanceof Error ? err.message : String(err);
    task.lastReport = `FAILED: ${task.error}`;
    writeLine(bot, task, task.lastReport);
  } finally {
    if (taskEpochs.get(id) === epoch) {
      task.running = false;
    }
  }
}

export function startGoalRun(
  bot: mineflayer.Bot,
  spec: GoalSpec,
  description: string,
  autoAdvanceMs = 1200
): number {
  if (!bot || !bot.entity) {
    return -1;
  }
  const id = ++lastGoalTaskId;
  const task: GoalTask = {
    id,
    description,
    status: 'pending',
    spec,
    stepIndex: 0,
    lastReport: 'pending',
    autoAdvanceMs,
    running: false
  };
  goalTasks.set(id, task);
  taskBots.set(id, bot);

  // SUPERSEDE: one active goal per bot. We ALWAYS create the new task, but mark
  // any prior non-terminal task for the same bot as failed so only the newest
  // goal's loop runs.
  for (const [tid, prior] of goalTasks) {
    if (tid === id) continue;
    if (taskBots.get(tid) !== bot) continue;
    if (
      prior.status === 'running' ||
      prior.status === 'pending' ||
      prior.status === 'awaiting-decision' ||
      prior.status === 'watchdog-paused'
    ) {
      prior.status = 'failed';
      prior.error = 'superseded by a new goal';
      prior.running = false;
      writeLine(bot, prior, 'Superseded by a new goal.');
    }
  }

  writeLine(bot, task, `Started goal "${description}" (${task.spec.steps.length} step(s)).`);
  void runLoop(id, bot);
  return id;
}

export function statusOf(id?: number): GoalTask | undefined {
  if (id !== undefined) return goalTasks.get(id);
  if (lastGoalTaskId > 0) return goalTasks.get(lastGoalTaskId);
  return undefined;
}

export function resumeRun(id?: number): void {
  const task = statusOf(id);
  if (!task) return;
  if (task.status === 'done' || task.status === 'failed') return;
  const bot = taskBots.get(task.id);
  if (!bot || !bot.entity) {
    task.status = 'failed';
    task.error = 'bot unavailable';
    task.running = false;
    task.lastReport = `FAILED: ${task.error}`;
    return;
  }
  task.lastReport = 'Resuming...';
  writeLine(bot, task, 'Resuming goal...');
  void runLoop(task.id, bot);
}

export function resolveRun(id: number | undefined, instruction: string): string {
  const task = statusOf(id);
  if (!task) {
    return id !== undefined ? `Goal task ${id} not found.` : 'No goal task found.';
  }
  if (task.status !== 'awaiting-decision') {
    return `Goal #${task.id} is not awaiting a decision (status: ${task.status}).`;
  }
  task.lastReport = `Decision: "${instruction}"`;
  const bot = taskBots.get(task.id);
  if (bot) {
    writeLine(bot, task, `Decision received: "${instruction}" — resuming.`);
  }
  resumeRun(task.id);
  return `Goal #${task.id} resumed after your input. Watch progress with read-new-chat or goal-run-status.`;
}

export function abortRun(id?: number): void {
  const task = statusOf(id);
  if (!task) return;
  task.status = 'failed';
  task.error = 'aborted by user';
  task.running = false;
  task.lastReport = 'Aborted by user.';
  const bot = taskBots.get(task.id);
  if (bot) {
    writeLine(bot, task, 'Goal aborted by user.');
  }
}

export function resetGoalRuns(): void {
  for (const task of goalTasks.values()) {
    task.status = 'failed';
    task.running = false;
  }
  goalTasks.clear();
  taskBots.clear();
  taskEpochs.clear();
  lastGoalTaskId = 0;
}

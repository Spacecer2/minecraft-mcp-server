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
import { GoalOutcome, GoalSpec, GoalStepResult, createGoalContext } from './goal-core.js';
import { isInterrupted, getInterruptReason, isInterruptError } from './interrupt.js';
import { isDeathInterrupt } from './goal-orchestrator.js';
import type { MessageStore } from './message-store.js';

export type GoalTaskStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'awaiting-decision'
  | 'watchdog-paused';

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
        task.stepIndex++;
        if (result.report) ctx.record(result.report);
        task.lastReport = result.report || `step '${step.name}' done`;
        writeLine(bot, task, `Step ${task.stepIndex}/${task.spec.steps.length} '${step.name}': ${result.report || 'done'}`);
        continue;
      }

      // result.status === 'blocked'
      if (result.intensity >= 3) {
        task.status = 'awaiting-decision';
        task.needDecision = {
          goal: task.spec.name,
          step: step.name,
          reason: result.reason,
          context: result.context
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

export function pauseRun(id?: number): void {
  const task = statusOf(id);
  if (!task) return;
  if (task.status === 'running' || task.status === 'pending') {
    task.status = 'watchdog-paused';
    task.lastReport = 'Paused by request. Call resume-run to continue.';
  }
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

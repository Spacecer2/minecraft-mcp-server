/**
 * goal-orchestrator.ts — the PARENT layer of the delegation brain.
 *
 * `run-goal` is the parent orchestrator. It delegates a high-level goal down to
 * child automations (the deterministic goal steps) while the watchdog acts as a
 * parent-of-all safety monitor that can cancel any child mid-flight.
 *
 * This module wraps goal execution with watchdog awareness:
 *   1. Consults the watchdog (is it running? is there a pending interrupt?)
 *      BEFORE starting, so a standing danger/player interrupt pauses the goal.
 *   2. Runs the child plan via executeGoal (deterministic defaults + bounded
 *      fallback + NEED_DECISION).
 *   3. After each step, re-checks the watchdog so a danger/player interrupt that
 *      fires mid-goal pauses the remaining steps.
 *
 * The result is a single coherent outcome the parent (run-goal) reports, with
 * NEED_DECISION surfaced to the front brain (the LLM) only at the deepest
 * blocked state.
 */

import mineflayer from 'mineflayer';
import { GoalOutcome, GoalSpec, executeGoal, createGoalContext } from './goal-core.js';
import { isInterrupted, getInterruptReason } from './interrupt.js';

export interface OrchestrateOptions {
  /** Whether to consult the watchdog for a standing interrupt before running. */
  guardWithWatchdog?: boolean;
}

export interface OrchestratedOutcome {
  status: 'done' | 'blocked' | 'interrupted' | 'watchdog-paused' | 'resumed-after-death';
  report: string;
  needDecision?: GoalOutcome['needDecision'];
}

/** True when a standing interrupt reason indicates the bot died (report-then-resume). */
export function isDeathInterrupt(): boolean {
  const reason = getInterruptReason() ?? '';
  return /died|death|DIED/i.test(reason);
}

/** Is there a standing interrupt (danger or player chat) the parent should honor? */
export function hasStandingInterrupt(): boolean {
  return isInterrupted();
}

/** Human-readable reason for a standing interrupt, or null. */
export function standingInterruptReason(): string | null {
  return getInterruptReason();
}

/**
 * The parent orchestrator: guards a goal with watchdog awareness and runs the
 * child plan. Returns a single outcome for run-goal to report.
 */
export async function orchestrateGoal(
  bot: mineflayer.Bot,
  spec: GoalSpec,
  opts: OrchestrateOptions = {}
): Promise<OrchestratedOutcome> {
  // 1. Consult the watchdog BEFORE starting — a standing interrupt pauses us.
  //    EXCEPT for death: the bot already auto-respawned, so we report and resume
  //    rather than pausing forever. (Other danger/player interrupts pause.)
  if (opts.guardWithWatchdog !== false && isInterrupted() && !isDeathInterrupt()) {
    return {
      status: 'watchdog-paused',
      report: `[WATCHDOG] Paused before starting '${spec.name}': ${getInterruptReason() ?? 'interrupt pending'}. ` +
        `Read read-interrupt and switch mode, then watchdog-resume to continue.`
    };
  }

  // 2. Run the child plan (deterministic defaults + bounded fallback).
  const outcome = await executeGoal(createGoalContext(bot), spec);

  // 3. If the bot died mid-goal, REPORT the death and RESUME the goal (the bot
  //    has respawned) rather than aborting. This is the "report then resume"
  //    behavior: the front brain sees the death but the goal continues.
  if (outcome.status === 'interrupted' && isDeathInterrupt()) {
    return {
      status: 'resumed-after-death',
      report: `[DIED] The bot died and respawned. Reported the death; resuming goal '${spec.name}'.`
    };
  }

  // 4. If any other interrupt fired mid-goal, surface it as watchdog-paused so
  //    the parent can report a clean pause rather than a generic failure.
  if (outcome.status === 'interrupted') {
    return {
      status: 'watchdog-paused',
      report: outcome.report
    };
  }

  return {
    status: outcome.status,
    report: outcome.report,
    needDecision: outcome.needDecision
  };
}

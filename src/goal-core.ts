/**
 * goal-core.ts — the generic "back brain" goal engine.
 *
 * Runs ANY goal as: deterministic default plan -> circumstance check per step ->
 * bounded fallback -> NEED_DECISION (only at the deepest blocked state).
 *
 * Steps do deterministic fallback internally (intensity 1-2) and only return
 * `blocked` with intensity 3 when deterministic options are exhausted. That is
 * when the engine stops and surfaces a structured `needDecision` for the front
 * brain (the LLM) to resolve.
 */
import mineflayer from 'mineflayer';
import { checkInterrupt, isInterruptError, getInterruptReason } from './interrupt.js';
import { bestOption, UtilityInput, checkConstraints } from './utility.js';

export type GoalStepResult =
  | { status: 'done'; report: string }
  | { status: 'blocked'; reason: string; intensity: number; context: Record<string, unknown> }
  | { status: 'interrupted'; reason: string };

export interface GoalContext {
  bot: mineflayer.Bot;
  /** Collected per-step verified reports, joined with ' → ' at the end. */
  report: string[];
  /** Helper to record a verified result into the report list. */
  record(report: string): void;
}

export interface GoalStep {
  name: string;
  /** Returns a result; internally checks circumstances + fallbacks. */
  run(ctx: GoalContext): Promise<GoalStepResult>;
}

export interface GoalSpec {
  name: string;
  steps: GoalStep[];
}

export interface GoalOutcome {
  status: 'done' | 'blocked' | 'interrupted';
  report: string;
  needDecision?: {
    goal: string;
    step: string;
    reason: string;
    context: Record<string, unknown>;
  };
}

export function createGoalContext(bot: mineflayer.Bot): GoalContext {
  return {
    bot,
    report: [],
    record(report: string): void {
      this.report.push(report);
    }
  };
}

/**
 * P0 pre-flight safety gate. Checks the hard constraints (drowning / lava /
 * void / low-health) against the bot. Safety is a SELECTION-TIME gate here,
 * not just a runtime interrupt: a violated invariant blocks the goal before
 * the step runs. Defensive: unknown bot state passes.
 */
export function preFlightSafetyCheck(bot: mineflayer.Bot): { ok: boolean; violated: string[] } {
  return checkConstraints(bot);
}

export async function executeGoal(ctx: GoalContext, spec: GoalSpec): Promise<GoalOutcome> {
  for (const step of spec.steps) {
    try {
      checkInterrupt();
    } catch (err) {
      if (isInterruptError(err)) {
        return { status: 'interrupted', report: `[INTERRUPTED] ${getInterruptReason() ?? 'Action cancelled by watchdog'}` };
      }
      throw err;
    }

    // P0 hard-constraint veto: never run a step while a safety invariant is
    // violated. Returns a blocked outcome at intensity 3 (NEED_DECISION) so
    // the front brain must resolve the danger before the goal continues.
    const safety = preFlightSafetyCheck(ctx.bot);
    if (!safety.ok) {
      return {
        status: 'blocked',
        report: ctx.report.join(' → '),
        needDecision: {
          goal: spec.name,
          step: step.name,
          reason: 'constraint_violation',
          context: { violated: safety.violated }
        }
      };
    }

    let result: GoalStepResult;
    try {
      result = await step.run(ctx);
    } catch (err) {
      if (isInterruptError(err)) {
        return { status: 'interrupted', report: `[INTERRUPTED] ${getInterruptReason() ?? 'Action cancelled by watchdog'}` };
      }
      throw err;
    }

    if (result.status === 'interrupted') {
      return { status: 'interrupted', report: `[INTERRUPTED] ${result.reason}` };
    }

    if (result.status === 'done') {
      // Empty reports (steps that had nothing to do) are skipped so they don't
      // pollute the joined report with dangling ' → ' segments.
      if (result.report) {
        ctx.record(result.report);
      }
      continue;
    }

    // result.status === 'blocked'
    if (result.intensity >= 3) {
      return {
        status: 'blocked',
        report: ctx.report.join(' → '),
        needDecision: {
          goal: spec.name,
          step: step.name,
          reason: result.reason,
          context: result.context
        }
      };
    }
    // blocked with intensity < 3 is recoverable: skip to the next step
  }

  return { status: 'done', report: ctx.report.join(' → ') };
}

/** A named fallback option with its utility input, used to pick the best one. */
export interface WeightedFallback {
  id: string;
  input: UtilityInput;
}

/**
 * Choose the highest-utility fallback (the "dopamine" weighting). Returns the
 * id of the best option, or null if there are none. Steps use this to decide
 * among alternatives (e.g. walk to a far villager vs. harvest nearby wheat) by
 * cost/benefit rather than hardcoded order.
 */
export function pickBestFallback(options: WeightedFallback[]): string | null {
  if (options.length === 0) return null;
  const best = bestOption(options, (opt) => opt.input);
  return best ? best.id : null;
}

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
import {
  DEFAULT_WEIGHTS,
  RiskBot,
  UtilityInput,
  UtilityWeights,
  bestOption,
  checkConstraints,
  riskAwareUtility
} from './utility.js';
import { queryGuards, GuardRequirement } from './death-register.js';

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
 * void / low-health) against the bot, then also consults the death register's
 * learned guards for the goal (e.g. torches>=8 / hp>=10 for caving). Unmet
 * guard requirements are appended to `violated` AND surfaced in the optional
 * `guards` field so callers can see the exact guard that failed. Safety is a
 * SELECTION-TIME gate here, not just a runtime interrupt: a violated invariant
 * blocks the goal before the step runs. Defensive: unknown bot state passes.
 */
export interface PreFlightResult {
  ok: boolean;
  violated: string[];
  /** Unmet death-register guard requirements (e.g. 'torches>=8', 'hp>=10'). */
  guards?: string[];
}

/** True when the bot's current state satisfies a death-register guard. */
function guardSatisfied(bot: mineflayer.Bot, g: GuardRequirement): boolean {
  if (g.guard === 'hp>=10' || g.guard.startsWith('hp>=')) {
    if (typeof bot.health === 'number') return bot.health >= g.threshold;
    return g.satisfied; // unknown state -> trust the register
  }
  if (g.guard === 'torches>=8' || g.guard.startsWith('torches>=')) {
    const torches = countTorches(bot);
    if (typeof torches === 'number') return torches >= g.threshold;
    return g.satisfied; // unknown state -> trust the register
  }
  return g.satisfied;
}

function countTorches(bot: mineflayer.Bot): number | undefined {
  try {
    const items = (bot as { inventory?: { items?: () => Array<{ name?: string; count?: number }> } }).inventory?.items?.();
    if (!Array.isArray(items)) return undefined;
    let total = 0;
    for (const it of items) {
      if (it && it.name === 'torch') total += typeof it.count === 'number' ? it.count : 1;
    }
    return total;
  } catch {
    return undefined;
  }
}

export function preFlightSafetyCheck(bot: mineflayer.Bot, goalName?: string): PreFlightResult {
  const base = checkConstraints(bot);
  const guards = queryGuards(goalName ?? '', {}).guards.filter((g) => !guardSatisfied(bot, g));
  if (guards.length === 0) return base;
  const unmet = guards.map((g) => g.guard);
  return { ok: false, violated: [...base.violated, ...unmet], guards: unmet };
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
    const safety = preFlightSafetyCheck(ctx.bot, spec.name);
    if (!safety.ok) {
      return {
        status: 'blocked',
        report: ctx.report.join(' → '),
        needDecision: {
          goal: spec.name,
          step: step.name,
          reason: 'constraint_violation',
          context:
            safety.guards && safety.guards.length > 0
              ? { violated: safety.violated, guards: safety.guards }
              : { violated: safety.violated }
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
 *
 * When a bot is supplied, options are scored through `riskAwareUtility`, so the
 * bot's estimated death probability (L4 risk evaluator) is folded into each
 * score and lowers risky options. Without a bot the raw `bestOption` path is
 * used — identical behavior to before (backward compatible). A constraint
 * violation still vetoes outright (-Infinity) regardless of pDeath.
 */
export function pickBestFallback(
  options: WeightedFallback[],
  bot?: RiskBot | null,
  w: UtilityWeights = DEFAULT_WEIGHTS
): string | null {
  if (options.length === 0) return null;
  if (!bot) {
    const best = bestOption(options, (opt) => opt.input);
    return best ? best.id : null;
  }
  let bestId: string | null = null;
  let bestScore = -Infinity;
  for (const opt of options) {
    const s = riskAwareUtility(bot, opt.input, w);
    if (s > bestScore) {
      bestScore = s;
      bestId = opt.id;
    }
  }
  return bestId;
}

/**
 * utility.ts — the "dopamine" cost-benefit weighting system.
 *
 * Humans (and smart agents) don't blindly pick the first option. They weigh
 * how much an outcome is worth against how far it is, how long it takes, and
 * how risky it is. This module provides a deterministic utility function the
 * orchestrator uses to choose among fallback options (e.g. walk to a far
 * villager vs. harvest nearby wheat vs. escalate to the front brain).
 *
 *   utility = (value * importance) / (1 + distanceCost + timeCost + risk)
 *
 * Higher is better. All inputs are normalized to comparable scales (0..1 or a
 * rough tick/block count). The weights are tunable so the brain can be made
 * more or less "patient" / "risk-averse".
 *
 * P0 HARD CONSTRAINTS: above the soft weighting, a set of safety invariants
 * (drowning / lava / void / low-health) act as a VETO. When one is violated the
 * option scores -Infinity and is never selected — safety cannot be traded away
 * by a weighted objective. See checkConstraints() / safeInput() below.
 */

import { Vec3 } from 'vec3';
import { weightsFromArousal } from './arousal.js';
import { estimatePDeath, ThreatInput } from './risk-evaluator.js';

export interface UtilityWeights {
  /** Multiplier on distance cost. Higher = more distance-averse. */
  distanceWeight: number;
  /** Multiplier on time cost. Higher = more time-averse (impatient). */
  timeWeight: number;
  /** Multiplier on risk cost. Higher = more risk-averse (cautious). */
  riskWeight: number;
  /** Base importance floor so a tiny value isn't instantly worthless. */
  importanceFloor: number;
}

export const DEFAULT_WEIGHTS: UtilityWeights = {
  distanceWeight: 1,
  timeWeight: 1,
  riskWeight: 1.5,
  importanceFloor: 0.1
};

/**
 * Arousal-aware default weights. Returns the current global weights modulated
 * by the arousal system (anxiety/boredom). Callers that want arousal-aware
 * weighting call `utility(input, defaultWeights())`. `utility()` and
 * `bestOption()` keep their pure `DEFAULT_WEIGHTS` default so existing
 * deterministic behavior is preserved unless a caller opts in.
 */
export function defaultWeights(): UtilityWeights {
  return weightsFromArousal();
}

export interface UtilityInput {
  /** How valuable the outcome is, 0..1 (e.g. bread is high-value when hungry). */
  value: number;
  /** Importance/priority of the goal, 0..1 (e.g. survival > decoration). */
  importance: number;
  /** How far the option is, in blocks (0 = here). */
  distanceBlocks?: number;
  /** Estimated time to complete, in seconds (0 = instant). */
  timeSeconds?: number;
  /** Risk 0..1 (0 = safe, 1 = certain death/loss). */
  risk?: number;
  /**
   * Estimated probability of death 0..1 (from the L4 risk evaluator). Treated
   * as an additional risk contributor: `riskWeight * pDeath` is added into the
   * denominator, so a riskier option scores lower all else equal. Optional —
   * when absent the score is unchanged (backward compatible).
   */
  pDeath?: number;
  /**
   * HARD-CONSTRAINT VETO (P0). When true the option violates a safety
   * invariant (drowning / lava / void / low health) and is disqualified
   * outright: utility() returns -Infinity, so bestOption can never select it.
   * This is a veto ON TOP of the soft risk weighting below — belt and
   * suspenders. Defaults to false so existing callers are unaffected.
   */
  constraintViolated?: boolean;
}

/**
 * Compute a deterministic utility score for one option.
 * Higher is better; the orchestrator picks the max among fallbacks.
 */
export function utility(input: UtilityInput, w: UtilityWeights = DEFAULT_WEIGHTS): number {
  // P0 hard-constraint veto: a violated safety invariant can never be traded
  // away by the weighted objective. -Infinity keeps bestOption from picking it.
  if (input.constraintViolated) return -Infinity;
  const value = clamp01(input.value);
  const importance = Math.max(clamp01(input.importance), w.importanceFloor);
  const distanceCost = w.distanceWeight * ((input.distanceBlocks ?? 0) / 100);
  const timeCost = w.timeWeight * ((input.timeSeconds ?? 0) / 120);
  const riskCost = w.riskWeight * clamp01(input.risk ?? 0);
  const pDeathCost = w.riskWeight * clamp01(input.pDeath ?? 0);
  const denominator = 1 + distanceCost + timeCost + riskCost + pDeathCost;
  return (value * importance) / denominator;
}

/**
 * Pick the option with the highest utility. Returns null if none.
 * An optional `filter` can veto options before scoring (e.g. drop options
 * whose path enters lava) — this runs before utility(), so hard constraints
 * short-circuit the soft weighting.
 */
export function bestOption<T>(
  options: T[],
  score: (opt: T) => UtilityInput,
  w: UtilityWeights = DEFAULT_WEIGHTS,
  filter?: (opt: T) => boolean
): T | null {
  let best: T | null = null;
  let bestScore = -Infinity;
  for (const opt of options) {
    if (filter && !filter(opt)) continue;
    const s = utility(score(opt), w);
    if (s > bestScore) {
      bestScore = s;
      best = opt;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// P0 HARD SAFETY CONSTRAINTS
//
// Soft risk only divides the utility score; a constraint VETOES. The invariants
// below mirror the watchdog events, so "never drown / never die in lava / never
// void-fall / never act at critical health" cannot be traded away by any
// weighted objective. Evaluation is defensive: when the bot state is unknown
// the constraint is treated as satisfied (safe), so callers that pass a partial
// or fake bot never get falsely vetoed.
// ---------------------------------------------------------------------------

/**
 * The minimal structural view of a bot that the constraints read. `mineflayer.Bot`
 * satisfies this shape, and tests can pass partial fakes.
 */
export interface SafetyBot {
  health?: number;
  oxygenLevel?: number;
  entity?: {
    position?: { x: number; y: number; z: number };
    /** Air left in ticks; 300 = full, 10 is ~0.5s left (watchdog parity). */
    air?: number;
  };
  blockAt?: (pos: Vec3, extraInfos?: boolean) => { name?: string } | null | undefined;
}

export interface Constraint {
  /** Stable identifier; matches the corresponding watchdog event name. */
  name: string;
  /** Returns true when the bot satisfies the invariant (safe). */
  check: (bot: SafetyBot) => boolean;
}

/** Air/oxygen level below which the bot is drowning (watchdog default). */
const DROWNING_THRESHOLD = 10;
/** Health below which the bot is at critical risk (watchdog lowHealth default). */
const LOW_HEALTH_THRESHOLD = 6;
/** Y below which the bot is falling into the void (watchdog voidY default). */
const VOID_Y = -60;

export const HARD_CONSTRAINTS: Constraint[] = [
  {
    name: 'drowning',
    check: (bot) => {
      const oxygen = bot.oxygenLevel;
      const air = bot.entity?.air;
      if (typeof oxygen === 'number' && oxygen < DROWNING_THRESHOLD) return false;
      if (typeof air === 'number' && air < DROWNING_THRESHOLD) return false;
      return true;
    }
  },
  {
    name: 'lava',
    check: (bot) => {
      if (typeof bot.blockAt !== 'function') return true;
      const pos = bot.entity?.position;
      if (!pos) return true;
      const x = Math.floor(pos.x);
      const y = Math.floor(pos.y);
      const z = Math.floor(pos.z);
      const cells = [
        new Vec3(x, y, z),
        new Vec3(x + 1, y, z),
        new Vec3(x - 1, y, z),
        new Vec3(x, y, z + 1),
        new Vec3(x, y, z - 1),
        new Vec3(x, y - 1, z)
      ];
      for (const cell of cells) {
        try {
          const block = bot.blockAt(cell);
          const name = block?.name;
          if (name === 'lava' || name === 'flowing_lava') return false;
        } catch {
          // unreadable cell — do not veto on a failed read
        }
      }
      return true;
    }
  },
  {
    name: 'void',
    check: (bot) => {
      const y = bot.entity?.position?.y;
      if (typeof y !== 'number') return true;
      return y >= VOID_Y;
    }
  },
  {
    name: 'low-health',
    check: (bot) => {
      const health = bot.health;
      if (typeof health !== 'number') return true;
      return health >= LOW_HEALTH_THRESHOLD;
    }
  }
];

export interface ConstraintCheckResult {
  ok: boolean;
  /** Names of the violated constraints (empty when ok is true). */
  violated: string[];
}

/**
 * Evaluate all hard constraints against the bot. Returns `{ ok: true }` when
 * every invariant holds (or the bot state is unreadable), otherwise
 * `{ ok: false, violated: string[] }` listing the broken invariants.
 */
export function checkConstraints(bot: SafetyBot | null | undefined): ConstraintCheckResult {
  if (!bot) return { ok: true, violated: [] };
  const violated: string[] = [];
  for (const c of HARD_CONSTRAINTS) {
    try {
      if (!c.check(bot)) violated.push(c.name);
    } catch {
      // unreadable state — do not veto on a failed read
    }
  }
  return violated.length > 0 ? { ok: false, violated } : { ok: true, violated: [] };
}

/**
 * Mark a UtilityInput as vetoed when the bot violates any hard constraint.
 * The returned input has `constraintViolated` set so utility() returns
 * -Infinity and bestOption will never select it. Pass-through when safe.
 */
export function safeInput(bot: SafetyBot | null | undefined, input: UtilityInput): UtilityInput {
  if (bot && !checkConstraints(bot).ok) {
    return { ...input, constraintViolated: true };
  }
  return { ...input, constraintViolated: false };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Euclidean distance (blocks) from the bot to a position. Returns Infinity if
 * the bot or the target position is unavailable.
 */
export function estimateDistance(
  bot: { entity?: { position?: { x: number; y: number; z: number } } } | null | undefined,
  pos: { x: number; y: number; z: number } | null | undefined
): number {
  if (!bot?.entity?.position || !pos) return Infinity;
  const p = bot.entity.position;
  const dx = p.x - pos.x;
  const dy = p.y - pos.y;
  const dz = p.z - pos.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Estimate danger (0..1) from nearby mobs within a radius. Defensive: returns 0
 * if the bot's entity map is unavailable. 1+ hostile mob => 1.0, else scaled.
 */
export function estimateRiskNearby(
  bot: {
    entity?: { position?: { x: number; y: number; z: number } };
    entities?: Map<number, { type?: string; position?: unknown }> | Record<number, { type?: string; position?: unknown }>;
  } | null | undefined,
  radius = 8
): number {
  if (!bot || !bot.entity) return 0;
  const entities = bot.entities as Map<number, { type?: string; position?: unknown }> | Record<number, { type?: string; position?: unknown }> | undefined;
  if (!entities) return 0;
  let mobs = 0;
  const iterable = entities instanceof Map ? Array.from(entities.values()) : Object.values(entities);
  for (const e of iterable) {
    if (!e || e.type !== 'mob') continue;
    const d = estimateDistance(
      { entity: { position: bot.entity.position } },
      e.position as { x: number; y: number; z: number }
    );
    if (d <= radius) mobs++;
  }
  if (mobs <= 0) return 0;
  return Math.min(1, mobs * 0.5);
}

// ---------------------------------------------------------------------------
// RISK-AWARE UTILITY (L4 risk-evaluator wiring)
//
// Thin glue between the soft utility weighting and the pure risk evaluator:
// derive an estimated probability of death from the bot's live state and feed
// it into utility() as an additional risk term. Defensive: unknown bot state
// contributes no risk (pDeath stays 0), so partial/fake bots never inflate it.
// ---------------------------------------------------------------------------

/**
 * The minimal bot view the risk wrapper reads. Everything is optional so real
 * mineflayer bots and test fakes both work; unknown fields are skipped.
 */
export type RiskBot = SafetyBot & {
  entities?:
    | Map<number, { type?: string; position?: { x: number; y: number; z: number } }>
    | Record<number, { type?: string; position?: { x: number; y: number; z: number } }>;
  /** mineflayer fire ticks; > 0 while burning. */
  fireTicks?: number;
  entity?: SafetyBot['entity'] & { onFire?: boolean };
};

function nearestHostileDistance(bot: RiskBot | null | undefined): number | undefined {
  if (!bot?.entity?.position) return undefined;
  const entities = bot.entities;
  if (!entities) return undefined;
  const pos = bot.entity.position;
  let best = Infinity;
  const iterable = entities instanceof Map ? Array.from(entities.values()) : Object.values(entities);
  for (const e of iterable) {
    if (!e || e.type !== 'mob') continue;
    const d = estimateDistance({ entity: { position: pos } }, e.position);
    if (d < best) best = d;
  }
  return Number.isFinite(best) ? best : undefined;
}

function lavaNearby(bot: SafetyBot | null | undefined): boolean {
  if (typeof bot?.blockAt !== 'function') return false;
  const pos = bot.entity?.position;
  if (!pos) return false;
  const x = Math.floor(pos.x);
  const y = Math.floor(pos.y);
  const z = Math.floor(pos.z);
  const cells = [
    new Vec3(x, y, z),
    new Vec3(x + 1, y, z),
    new Vec3(x - 1, y, z),
    new Vec3(x, y, z + 1),
    new Vec3(x, y, z - 1),
    new Vec3(x, y - 1, z)
  ];
  for (const cell of cells) {
    try {
      const name = bot.blockAt(cell)?.name;
      if (name === 'lava' || name === 'flowing_lava') return true;
    } catch {
      // unreadable cell — ignore
    }
  }
  return false;
}

function isDrowning(bot: SafetyBot | null | undefined): boolean {
  const oxygen = bot?.oxygenLevel;
  if (typeof oxygen === 'number' && oxygen < DROWNING_THRESHOLD) return true;
  const air = bot?.entity?.air;
  if (typeof air === 'number' && air < DROWNING_THRESHOLD) return true;
  return false;
}

/**
 * Build a ThreatInput from the bot's live state. Only fields that are actually
 * readable are set; everything else stays undefined (safe in estimatePDeath).
 */
function threatInputFromBot(bot: RiskBot | null | undefined): ThreatInput {
  if (!bot) return {};
  const threat: ThreatInput = {};
  if (typeof bot.health === 'number') threat.health = bot.health;
  const dist = nearestHostileDistance(bot);
  if (typeof dist === 'number') threat.nearestHostileDist = dist;
  const fireTicks = bot.fireTicks;
  if (typeof fireTicks === 'number' && fireTicks > 0) threat.onFire = true;
  else if (bot.entity?.onFire) threat.onFire = true;
  const y = bot.entity?.position?.y;
  if (typeof y === 'number' && y < VOID_Y) threat.inVoid = true;
  if (lavaNearby(bot)) threat.lavaNearby = true;
  if (isDrowning(bot)) threat.drowning = true;
  return threat;
}

/**
 * Thin wrapper: derive the bot's estimated probability of death (0..1) from its
 * live state via the L4 risk evaluator. Defensive — returns ~0 for unknown state.
 */
export function botDeathProbability(bot: RiskBot | null | undefined): number {
  return estimatePDeath(threatInputFromBot(bot));
}

/**
 * Convenience: merge the bot-derived probability of death into a UtilityInput
 * so the L4 risk term is explicit. Returns the input UNCHANGED when the bot is
 * null/unknown (or the estimate is ~0), so partial/fake bots never inflate risk
 * — backward compatible with callers that don't pass a bot.
 */
export function riskAdjustedInput(bot: RiskBot | null | undefined, input: UtilityInput): UtilityInput {
  if (!bot) return input;
  const pDeath = botDeathProbability(bot);
  if (pDeath === 0) return input;
  return { ...input, pDeath };
}

/**
 * Risk-aware utility: estimate pDeath from the bot's state and feed it into
 * utility() as an extra risk term. Lower score when the bot is in danger, so a
 * risk-aware orchestrator never picks a suicidal option over a safe equivalent.
 */
export function riskAwareUtility(
  bot: RiskBot | null | undefined,
  input: UtilityInput,
  w: UtilityWeights = DEFAULT_WEIGHTS
): number {
  return utility(riskAdjustedInput(bot, input), w);
}

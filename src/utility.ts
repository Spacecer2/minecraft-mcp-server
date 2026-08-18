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
 */

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
}

/**
 * Compute a deterministic utility score for one option.
 * Higher is better; the orchestrator picks the max among fallbacks.
 */
export function utility(input: UtilityInput, w: UtilityWeights = DEFAULT_WEIGHTS): number {
  const value = clamp01(input.value);
  const importance = Math.max(clamp01(input.importance), w.importanceFloor);
  const distanceCost = w.distanceWeight * ((input.distanceBlocks ?? 0) / 100);
  const timeCost = w.timeWeight * ((input.timeSeconds ?? 0) / 120);
  const riskCost = w.riskWeight * clamp01(input.risk ?? 0);
  const denominator = 1 + distanceCost + timeCost + riskCost;
  return (value * importance) / denominator;
}

/** Pick the option with the highest utility. Returns null if none. */
export function bestOption<T>(
  options: T[],
  score: (opt: T) => UtilityInput,
  w: UtilityWeights = DEFAULT_WEIGHTS
): T | null {
  let best: T | null = null;
  let bestScore = -Infinity;
  for (const opt of options) {
    const s = utility(score(opt), w);
    if (s > bestScore) {
      bestScore = s;
      best = opt;
    }
  }
  return best;
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

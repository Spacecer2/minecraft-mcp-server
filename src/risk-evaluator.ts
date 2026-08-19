/**
 * risk-evaluator.ts — the L4 risk evaluator.
 *
 * Pure module (no mineflayer) implementing the spec risk formula:
 *
 *   score(a) = U(gain)(1 − pDeath) − pDeath·C_death − λ·risk − κ·uncertainty
 *            + UCB exploration bonus
 *
 * with state-dependent λ,κ (loss aversion; starving = risk-seeking) and a death
 * budget that scales with safety capital (risk homeostasis). Self-contained so
 * tests run without a bot.
 */

export type ThreatInput = {
  health?: number; // 0..20
  nearestHostileDist?: number; // blocks, undefined = none in view
  night?: boolean;
  exposed?: boolean; // outdoors / no shelter
  onFire?: boolean;
  lavaNearby?: boolean;
  inVoid?: boolean;
  drowning?: boolean;
  armor?: number; // 0..1 effective damage reduction
};

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);

/**
 * Estimate probability of death (0..1) from threat inputs.
 * Healthy + safe -> low; starving/low-health + exposed -> high. Continuous
 * contributions (low health, close hostiles, exposure) are summed, then any
 * one-shot lethal danger (void/lava/fire/drowning) dominates toward 1.
 */
export function estimatePDeath(input: ThreatInput): number {
  const health = clamp01((input.health ?? 20) / 20); // 1 = full
  const lowHealth = clamp01(1 - health); // 1 at 0 HP

  let hostile = 0;
  const dist = input.nearestHostileDist;
  if (typeof dist === 'number' && Number.isFinite(dist)) {
    hostile = clamp01(1 - dist / 24); // 0 at 24+ blocks, 1 at contact
  }

  const exposure = input.night || input.exposed ? 0.25 : 0;
  const noArmor = 1 - clamp01(input.armor ?? 0);

  // Base continuous death probability from accumulation of danger.
  const continuous = clamp01(
    lowHealth * 0.6 +
      hostile * 0.5 +
      exposure * 0.4 +
      (1 - health) * noArmor * 0.2
  );

  const lethal = input.inVoid || input.lavaNearby || input.onFire || input.drowning ? 1 : 0;

  return clamp01(Math.max(continuous, lethal));
}

export interface RiskInput {
  gain: number; // U(gain) — expected utility of success, 0..1
  pDeath: number; // 0..1
  deathCost: number; // C_death — cost of dying (in same units as gain)
  risk: number; // 0..1 perceived risk
  uncertainty: number; // 0..1 model uncertainty
  lambda: number; // loss-aversion weight (higher = more risk-averse)
  kappa: number; // uncertainty-aversion weight
  ucbBonus: number; // UCB exploration bonus (additive)
}

/**
 * The spec risk formula. Pure arithmetic; higher is better.
 */
export function evaluateRisk(input: RiskInput): number {
  const gain = clamp01(input.gain);
  const pDeath = clamp01(input.pDeath);
  const deathCost = Number.isFinite(input.deathCost) ? input.deathCost : 0;
  const risk = clamp01(input.risk);
  const uncertainty = clamp01(input.uncertainty);
  const lambda = Number.isFinite(input.lambda) ? input.lambda : 1;
  const kappa = Number.isFinite(input.kappa) ? input.kappa : 1;
  const ucbBonus = Number.isFinite(input.ucbBonus) ? input.ucbBonus : 0;

  return gain * (1 - pDeath) - pDeath * deathCost - lambda * risk - kappa * uncertainty + ucbBonus;
}

export interface StateParams {
  lambda: number; // loss-aversion weight
  kappa: number; // uncertainty-aversion weight
  deathBudget: number; // acceptable pDeath threshold
}

/**
 * State-dependent risk attitude. Safe+healthy = risk-averse (high λ), starving
 * = risk-seeking (low λ). The death budget scales with safety capital: richer
 * health/food/tools buys a wider (but still bounded) acceptable-death window.
 */
export function stateDependentParams(input: {
  health?: number; // 0..20
  food?: number; // 0..20
  safetyCapital?: number; // 0..1 aggregated safety capital (gear/tools/base)
}): StateParams {
  const health = clamp01((input.health ?? 20) / 20); // 1 = full
  const food = clamp01((input.food ?? 20) / 20); // 1 = full
  const starving = food < 0.3;
  const safe = health > 0.7 && !starving;
  const capital = clamp01(input.safetyCapital ?? 0.5);

  // Loss aversion: healthy+fed = cautious (λ ~2), starving = gambling (λ ~0.4).
  let lambda = 1;
  if (safe) lambda = 2;
  else if (starving) lambda = 0.4;
  // Uncertainty aversion mirrors it, slightly softer.
  const kappa = safe ? 1.5 : starving ? 0.5 : 1;

  // Death budget scales with safety capital (risk homeostasis). Higher capital
  // = wider envelope, but never lets the bot accept certain death.
  const deathBudget = clamp01(0.5 * capital + 0.1 + (1 - health) * 0.15);
  return { lambda, kappa, deathBudget };
}

/** Whether an estimated death probability is inside the acceptable envelope. */
export function withinDeathBudget(pDeath: number, deathBudget: number): boolean {
  return clamp01(pDeath) <= clamp01(deathBudget);
}

/**
 * Standard UCB1 exploration bonus: c·sqrt(ln(totalPlays+1)/(visitCount+1)).
 * Decays as an option is visited more; grows with total plays (more room to
 * explore) and with the exploration constant.
 */
export function ucbBonus(
  visitCount: number,
  totalPlays: number,
  explorationConstant: number
): number {
  const visits = Math.max(0, visitCount);
  const plays = Math.max(0, totalPlays);
  const c = Number.isFinite(explorationConstant) ? Math.max(0, explorationConstant) : 0;
  return c * Math.sqrt(Math.log(plays + 1) / (visits + 1));
}

export interface DeathEnvelope {
  acceptablePDeath: number; // 0..1
  riskAttitude: 'risk-averse' | 'risk-seeking' | 'neutral';
  guarded: boolean; // whether critical safety guards are required
}

/**
 * Worked-example helper: describe how much death risk is acceptable given the
 * bot's current health/armor/tools. Richer gear widens the envelope (design
 * rule 16); low health shrinks it.
 */
export function acceptableDeathEnvelope(input: {
  health?: number; // 0..20
  armor?: number; // 0..1 effective damage reduction
  tools?: number; // 0..1 tool quality/availability
}): DeathEnvelope {
  const health = clamp01((input.health ?? 20) / 20);
  const armor = clamp01(input.armor ?? 0);
  const tools = clamp01(input.tools ?? 0.5);

  // Base envelope widens with gear, collapses with low health.
  const acceptablePDeath = clamp01(0.05 + armor * 0.2 + tools * 0.15 - (1 - health) * 0.4);

  const riskAttitude: DeathEnvelope['riskAttitude'] =
    health > 0.7 && tools > 0.6 ? 'risk-averse' : health < 0.4 ? 'risk-seeking' : 'neutral';

  return { acceptablePDeath, riskAttitude, guarded: health < 0.5 };
}

/**
 * arousal.ts — the global AROUSAL system.
 *
 * Two sensed axes modulate the utility weights globally:
 *   - Anxiety  (bottom-up, instinct -> reason): sensed by the PRIMAL BRAIN from
 *     its sensors (hostiles, low health, low oxygen, void/lava/fire/drowning).
 *     High anxiety -> the primal directives dominate and weights become more
 *     risk-averse.
 *   - Boredom  (top-down, goal -> reason -> instinct): when goals chain with no
 *     novelty, boredom rises -> the agent seeks novelty / acts on its own
 *     long-term vision instead of being purely reactive.
 *
 * CRITICAL: arousal is SENSED here (from bot state), then the primal brain feeds
 * it via arousal.set*(). The LLM never reads logs to infer it.
 *
 * This module is self-contained and deliberately does NOT import utility.ts at
 * runtime (only the UtilityWeights type via `import type`, erased at compile
 * time) so utility.ts can import weightsFromArousal() without a runtime cycle.
 */

import type { UtilityWeights } from './utility.js';

export type ArousalState = {
  anxiety: number; // 0..1 sensed stress level (1 = panicked)
  boredom: number; // 0..1 sensed novelty-starved level (1 = extremely bored)
};

// ---------------------------------------------------------------------------
// Sensing (pure functions — the primal brain calls these, not the LLM)
// ---------------------------------------------------------------------------

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);

/**
 * Sense anxiety (0..1) from the primal brain's inputs (bot state + danger).
 * Formula: take the max of the continuous danger contributions, then let any
 * one-shot critical danger (void/lava/fire/drowning) dominate toward 1. The
 * max keeps a single severe threat from being diluted by otherwise-calm signals.
 */
export function senseAnxiety(input: {
  hostilesNearby?: number;
  health?: number; // 0..20
  oxygenLevel?: number; // 0..20
  inVoid?: boolean;
  lavaNearby?: boolean;
  onFire?: boolean;
  falling?: boolean;
  drowning?: boolean;
}): number {
  const hostiles = clamp01((input.hostilesNearby ?? 0) * 0.5); // 1 hostile = 0.5, 2+ = 1.0
  const lowHealth = clamp01(1 - (input.health ?? 20) / 20); // 0 at full, 1 at 0 HP
  const lowOxygen = clamp01(1 - (input.oxygenLevel ?? 20) / 20); // 0 at full, 1 at 0
  const falling = input.falling ? 0.5 : 0; // moderate stress from a fall

  // One-shot critical dangers dominate.
  const critical = input.inVoid || input.lavaNearby || input.onFire || input.drowning ? 1 : 0;

  const continuous = Math.max(hostiles, lowHealth, lowOxygen, falling);
  const anxiety = Math.max(continuous, critical * 0.9);
  return clamp01(anxiety);
}

// ---------------------------------------------------------------------------
// Global arousal singleton (module-level mutable state)
// ---------------------------------------------------------------------------

const state: ArousalState = { anxiety: 0, boredom: 0 };

export const arousal = {
  get(): ArousalState {
    return { ...state };
  },
  set(s: Partial<ArousalState>): void {
    if (typeof s.anxiety === 'number') state.anxiety = clamp01(s.anxiety);
    if (typeof s.boredom === 'number') state.boredom = clamp01(s.boredom);
  },
  setAnxiety(n: number): void {
    state.anxiety = clamp01(n);
  },
  setBoredom(n: number): void {
    state.boredom = clamp01(n);
  },
  reset(): void {
    state.anxiety = 0;
    state.boredom = 0;
  }
};

// ---------------------------------------------------------------------------
// Weight modulation
// ---------------------------------------------------------------------------

/**
 * THE KEY FUNCTION: modulate the utility weights from the current arousal.
 * Returns an augmented UtilityWeights the utility layer uses globally.
 *
 *   - anxiety:  riskWeight * (1 + anxiety*3)  -> 4x at anxiety 1 (risk dominates);
 *               importanceFloor rises toward 1 so safety/urgency can't be
 *               dismissed by a tiny value. distance/time kept roughly constant.
 *   - boredom:  riskWeight * (1 - boredom*0.3) -> slightly more willing to take
 *               novelty risk; noveltyBias() (== boredom) raises the effective
 *               value of novel options downstream.
 *   - clamps:   riskWeight >= 0.1, importanceFloor <= 1.
 */
export function weightsFromArousal(base?: UtilityWeights): UtilityWeights {
  const b = base ?? { distanceWeight: 1, timeWeight: 1, riskWeight: 1.5, importanceFloor: 0.1 };
  const { anxiety, boredom } = state;

  let riskWeight = b.riskWeight * (1 + anxiety * 3) * (1 - boredom * 0.3);
  if (!Number.isFinite(riskWeight) || riskWeight < 0.1) riskWeight = 0.1;

  const importanceFloor = Math.min(1, Math.max(b.importanceFloor, anxiety * 0.5));

  return {
    distanceWeight: b.distanceWeight,
    timeWeight: b.timeWeight,
    riskWeight,
    importanceFloor
  };
}

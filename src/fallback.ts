/**
 * fallback.ts — the pre-committed fallback ladder + two-strike + cushions.
 *
 * The ladder is committed BEFORE plan A executes:
 *   - Plan A: aggressive (same objective, high risk/reward)
 *   - Plan B: conservative (same objective, different, safer method)
 *   - Plan C: surrender objective, return to base
 *   - Plan D: passive survival (shelter, hide, sleep, minimize exposure)
 *
 * Two-strike heuristic: after 2 failed mitigations, switch to a categorically
 * different approach. Resource-cushion rules: risky operations are blocked
 * unless HP / food / tools exceed state-tuned thresholds.
 *
 * Pure so it is unit-testable without a bot.
 */

export type Rung = 'A' | 'B' | 'C' | 'D';

export interface FallbackPlan {
  rung: Rung;
  /** Plan name / description. */
  description: string;
  /** True when this rung is the aggressive variant. */
  aggressive?: boolean;
}

export interface FallbackLadder {
  goal: string;
  planA: FallbackPlan;
  planB: FallbackPlan;
  planC: FallbackPlan;
  planD: FallbackPlan;
}

export interface LadderVariants {
  /** Aggressive version (same objective, high risk/reward). */
  aggressive: string;
  /** Conservative version (same objective, different safer method). */
  conservative: string;
  /** Surrender objective, return to base. */
  surrender: string;
  /** Passive survival (shelter, hide, sleep). */
  passive: string;
}

const RUNG_ORDER: Rung[] = ['A', 'B', 'C', 'D'];

/**
 * Pre-commit the full fallback ladder before plan A executes.
 */
export function commitLadder(goal: string, variants: LadderVariants): FallbackLadder {
  return {
    goal,
    planA: { rung: 'A', description: variants.aggressive, aggressive: true },
    planB: { rung: 'B', description: variants.conservative },
    planC: { rung: 'C', description: variants.surrender },
    planD: { rung: 'D', description: variants.passive }
  };
}

/**
 * Descend the ladder one rung (A->B->C->D). Returns the next plan, or null
 * when already at the bottom (D).
 */
export function descendLadder(ladder: FallbackLadder, rung: Rung): FallbackPlan | null {
  const idx = RUNG_ORDER.indexOf(rung);
  if (idx < 0 || idx >= RUNG_ORDER.length - 1) return null;
  const next = RUNG_ORDER[idx + 1];
  return ladder[`plan${next}` as 'planB' | 'planC' | 'planD'];
}

/** The structural view of bot state the cushion rules read. */
export interface ResourceState {
  health?: number;
  food?: number;
  toolDurabilityPercent?: number;
}

export type RiskyOperation = 'cave' | 'mine' | 'combat' | 'swim' | 'generic';

export interface CushionThresholds {
  health: number;
  food: number;
  tool: number;
}

export const DEFAULT_CUSHION: Record<RiskyOperation, CushionThresholds> = {
  cave: { health: 10, food: 12, tool: 10 },
  mine: { health: 6, food: 8, tool: 5 },
  combat: { health: 8, food: 10, tool: 0 },
  swim: { health: 6, food: 0, tool: 0 },
  generic: { health: 4, food: 4, tool: 0 }
};

/**
 * Resource-cushion gate: risky operations are refused unless HP / food / tool
 * durability exceed the state-tuned thresholds. Unknown values pass (defensive).
 */
export function resourceCushionOK(state: ResourceState, operation: RiskyOperation = 'generic'): boolean {
  const t = DEFAULT_CUSHION[operation] ?? DEFAULT_CUSHION.generic;
  if (typeof state.health === 'number' && state.health < t.health) return false;
  if (typeof state.food === 'number' && state.food < t.food) return false;
  if (typeof state.toolDurabilityPercent === 'number' && state.toolDurabilityPercent < t.tool) return false;
  return true;
}

/**
 * Two-strike heuristic: after 2 failed mitigations (each a categorically
 * different mitigation), switch approach.
 */
export function twoStrikeShouldSwitch(strikeCount: number, mitigations: string[]): boolean {
  if (strikeCount < 2) return false;
  const distinct = new Set((mitigations ?? []).filter(Boolean)).size;
  return distinct >= 2;
}

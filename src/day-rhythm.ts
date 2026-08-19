/**
 * day-rhythm.ts — the day-cycle scheduler (pure, bot-free).
 *
 * Minecraft timeOfDay runs 0..24000 (0 = dawn). Each phase maps to
 * phase-appropriate activities and the "return-before-dusk" meta-rule is
 * enforced with deadline math. No side effects, no mineflayer import.
 */

export const DAY_TICKS = 24000;
export const SUNSET_TICK = 12000;
export const DUSK_TICK = 13000; // nightfall
export const TICKS_PER_MINUTE = 1200; // real minutes: 24000 ticks = 20 min

export type DayPhase =
  | 'DAWN'
  | 'MORNING'
  | 'MIDDAY'
  | 'LATE_AFTERNOON'
  | 'DUSK'
  | 'EVENING'
  | 'NIGHT';

const PHASE_START: [DayPhase, number][] = [
  ['DAWN', 0],
  ['MORNING', 2000],
  ['MIDDAY', 6000],
  ['LATE_AFTERNOON', 10000],
  ['DUSK', 12000],
  ['EVENING', 13000],
  ['NIGHT', 14000]
];

const ACTIVITIES: Record<DayPhase, string[]> = {
  DAWN: ['drink water', 'eat first meal', 'warm up'],
  MORNING: ['gather wood', 'gather plants', 'low-risk foraging'],
  MIDDAY: ['hunt', 'mine', 'build', 'high-risk high-precision tasks'],
  LATE_AFTERNOON: ['begin return to base', 'never end daylight far from base'],
  DUSK: ['place torch perimeter ring', 'close the door', 'stock fuel', 'cook food'],
  EVENING: ['cook', 'smelt', 'craft', 'repair tools', 'organize chests'],
  NIGHT: ['sleep', 'set spawn point', 'indoor tasks', 'keep interior lit']
};

const normalizeTimeOfDay = (tod: number): number => ((tod % DAY_TICKS) + DAY_TICKS) % DAY_TICKS;

export function phaseFor(timeOfDay: number): DayPhase {
  const tod = normalizeTimeOfDay(timeOfDay);
  let phase: DayPhase = 'NIGHT';
  for (const [p, start] of PHASE_START) {
    if (tod >= start) phase = p;
  }
  return phase;
}

export function suggestedActivities(phase: DayPhase): string[] {
  return [...ACTIVITIES[phase]];
}

/** Real minutes remaining until nightfall (0 when it is already night). */
export function minutesToDusk(timeOfDay: number): number {
  const tod = normalizeTimeOfDay(timeOfDay);
  if (tod >= DUSK_TICK) return 0;
  return (DUSK_TICK - tod) / TICKS_PER_MINUTE;
}

/**
 * True when the bot can still return to base before dusk within the given
 * minutes budget; false when it is already too late (should be returning now).
 */
export function returnByDuskDeadline(timeOfDay: number, minutesBudget: number): boolean {
  return minutesToDusk(timeOfDay) > minutesBudget;
}

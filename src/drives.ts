/**
 * drives.ts — the L1 Homeostasis / Drive Arbitrator (pure, bot-free).
 *
 * Each need is a negative-feedback controller producing a `NeedDrive`:
 *   D_i = urgency(deviation) × rateBoost × lethalityWeight
 * Drives are ranked by D_i / timeToHarmSeconds (HP at 4 beats hunger at 4
 * because its time-to-harm is far shorter). Deadband + hysteresis stop thrash
 * (eat at ≤6, stop at ≥12).
 *
 * Allostatic feedforward: the DUSK CLOCK converts a *predicted* future
 * deviation (nightfall) into a drive before it exists, preempting mining
 * ~10 min before dark. No side effects, no mineflayer import.
 */

// Minecraft day-cycle constants live in day-rhythm.ts (canonical). Imported
// here and re-exported so existing importers of drives.js keep working.
import { DAY_TICKS, DUSK_TICK, TICKS_PER_MINUTE } from './day-rhythm.js';
export { DAY_TICKS, SUNSET_TICK, DUSK_TICK, TICKS_PER_MINUTE } from './day-rhythm.js';

export interface DriveInput {
  health?: number; // 0..20
  food?: number; // 0..20
  oxygenLevel?: number; // 0..20
  timeOfDay?: number; // 0..24000
  hasLight?: boolean;
  isIndoors?: boolean;
  lightLevel?: number; // 0..15
  nearestHostileDist?: number; // blocks; Infinity = none
  hostileIsCreeper?: boolean;
  freeSlots?: number; // free inventory slots
  toolDurability?: number; // 0..1
  toolReplaceThreshold?: number; // default 0.10
}

export interface NeedDrive {
  id: string;
  urgency: number; // 0..1
  timeToHarmSeconds: number;
  lethalityWeight: number; // 0..1
  rateBoost: number; // >=1
}

export interface DriveDecision {
  action: 'drive' | 'continue_goal';
  winner: NeedDrive | null;
  ranked: NeedDrive[]; // descending by driveScore
}

// Dusk-clock timescale: "1 minute" = 300 ticks so the default 10-min preempt
// window lands in LATE-AFTERNOON→DUSK (~10000→13000) rather than all day.
export const TICKS_PER_PREEMPT_MINUTE = 300;

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);
const clamp = (n: number, lo: number, hi: number): number => (Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo);
const normalizeTimeOfDay = (tod: number): number => ((tod % DAY_TICKS) + DAY_TICKS) % DAY_TICKS;

// ---------------------------------------------------------------------------
// Time-to-harm per need (monotonic: worse state -> shorter time-to-harm)
// ---------------------------------------------------------------------------

const healthTimeToHarm = (h: number): number => 3 + (h / 20) * 57; // 3..60s
const hungerTimeToHarm = (f: number): number => 60 + (f / 20) * 140; // 60..200s
const oxygenTimeToHarm = (o: number): number => 5 + (o / 10) * 55; // 5..60s
const nightTimeToHarm = (tod: number): number =>
  tod >= DUSK_TICK ? 2 : Math.max(1, ((DUSK_TICK - tod) / TICKS_PER_MINUTE) * 60);

// ---------------------------------------------------------------------------
// Per-need controllers
// ---------------------------------------------------------------------------

export function healthDrive(input: DriveInput): NeedDrive {
  const h = clamp(input.health ?? 20, 0, 20);
  let urgency: number;
  if (h >= 14) {
    urgency = 0; // set-zone 14..20
  } else if (h >= 6) {
    urgency = ((14 - h) / (14 - 6)) * 0.6; // linear above 14->6
  } else {
    urgency = 0.6 + 0.4 * (1 - Math.exp(-(6 - h) / 3)); // exponential below 6
  }
  return { id: 'health', urgency: clamp01(urgency), timeToHarmSeconds: healthTimeToHarm(h), lethalityWeight: 1, rateBoost: 1 };
}

export function hungerDrive(input: DriveInput): NeedDrive {
  const f = clamp(input.food ?? 20, 0, 20);
  let urgency: number;
  if (f >= 12) {
    urgency = 0; // hysteresis: stop eating at 12
  } else if (f >= 6) {
    urgency = ((12 - f) / 6) * 0.5; // gentle from 12->6
  } else {
    urgency = 0.5 + 0.5 * (1 - Math.exp(-(6 - f) / 4)); // steep below 6
  }
  return { id: 'hunger', urgency: clamp01(urgency), timeToHarmSeconds: hungerTimeToHarm(f), lethalityWeight: 0.6, rateBoost: 1 };
}

export function oxygenDrive(input: DriveInput): NeedDrive {
  const o = clamp(input.oxygenLevel ?? 20, 0, 20);
  let urgency: number;
  if (o >= 10) {
    urgency = 0; // set-point 10
  } else {
    urgency = 1 - Math.exp(-(10 - o) / 3); // near-exponential
  }
  return { id: 'oxygen', urgency: clamp01(urgency), timeToHarmSeconds: oxygenTimeToHarm(o), lethalityWeight: 1, rateBoost: 2 };
}

export function nightDrive(input: DriveInput, opts?: { minutesBeforeDusk?: number }): NeedDrive {
  const minutesBeforeDusk = opts?.minutesBeforeDusk ?? 10;
  const tod = normalizeTimeOfDay(input.timeOfDay ?? 0);
  const safe = !!input.isIndoors && !!input.hasLight;
  const rampStart = (DUSK_TICK - minutesBeforeDusk * TICKS_PER_PREEMPT_MINUTE + DAY_TICKS) % DAY_TICKS;

  let urgency = 0;
  if (!safe) {
    if (tod >= DUSK_TICK) {
      urgency = 1; // after dark: spike
    } else if (tod >= rampStart) {
      const span = (DUSK_TICK - rampStart + DAY_TICKS) % DAY_TICKS || 1;
      urgency = (tod - rampStart) / span; // ramp before nightfall
    }
  }
  return { id: 'night', urgency: clamp01(urgency), timeToHarmSeconds: nightTimeToHarm(tod), lethalityWeight: 0.8, rateBoost: 1 };
}

export function threatDrive(input: DriveInput): NeedDrive {
  const dist = input.nearestHostileDist ?? Infinity;
  const creeper = !!input.hostileIsCreeper;
  let urgency = 0;
  if (Number.isFinite(dist) && dist < 16) {
    const closeness = 1 - clamp(dist, 0, 16) / 16;
    urgency = closeness * closeness; // quadratic near contact
  }
  return {
    id: 'threat',
    urgency: clamp01(urgency),
    timeToHarmSeconds: creeper ? 2 : 4, // creeper is faster to harm
    lethalityWeight: creeper ? 1 : 0.8, // creeper weight ≫ zombie
    rateBoost: 1
  };
}

export function inventoryDrive(input: DriveInput): NeedDrive {
  const free = input.freeSlots ?? 36;
  let urgency = 0;
  if (free < 4) urgency = 1; // blocking event
  else if (free < 8) urgency = 0.3; // getting tight
  return { id: 'inventory', urgency: clamp01(urgency), timeToHarmSeconds: 120, lethalityWeight: 0.1, rateBoost: 1 };
}

export function toolDrive(input: DriveInput): NeedDrive {
  const dur = clamp(input.toolDurability ?? 1, 0, 1);
  const threshold = clamp(input.toolReplaceThreshold ?? 0.1, 0, 1);
  let urgency = 0;
  if (dur < threshold && threshold > 0) {
    urgency = (threshold - dur) / threshold; // linear below replace threshold
  }
  return { id: 'tool', urgency: clamp01(urgency), timeToHarmSeconds: 60, lethalityWeight: 0.1, rateBoost: 1 };
}

// ---------------------------------------------------------------------------
// Arbiter
// ---------------------------------------------------------------------------

/** D_i = urgency × rateBoost × lethalityWeight, normalised by time-to-harm. */
export function driveScore(d: NeedDrive): number {
  const magnitude = d.urgency * d.rateBoost * d.lethalityWeight;
  const t = d.timeToHarmSeconds > 0 ? d.timeToHarmSeconds : 1;
  return magnitude / t;
}

export function arbitrate(drives: NeedDrive[], baseThreshold = 0.001): DriveDecision {
  const ranked = [...drives].sort((a, b) => driveScore(b) - driveScore(a));
  const winner = ranked.length > 0 ? ranked[0] : null;
  if (!winner || driveScore(winner) <= baseThreshold) {
    return { action: 'continue_goal', winner: null, ranked };
  }
  return { action: 'drive', winner, ranked };
}

// ---------------------------------------------------------------------------
// Dusk clock (anticipatory / allostatic)
// ---------------------------------------------------------------------------

/**
 * Whether the anticipatory night drive is active — true from the pre-dusk
 * ramp window through nightfall, false during the safe middle of the day.
 */
export function duskPreemptActive(timeOfDay: number, minutesBeforeDusk = 10): boolean {
  const tod = normalizeTimeOfDay(timeOfDay);
  const rampStart = (DUSK_TICK - minutesBeforeDusk * TICKS_PER_PREEMPT_MINUTE + DAY_TICKS) % DAY_TICKS;
  return tod >= rampStart;
}

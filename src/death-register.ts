/**
 * death-register.ts — the persistent DEATH REGISTER (L3 hard planner gates).
 *
 * Stores death episodes (location, cause, hp, threats, action, guards) and
 * exposes learned guards/risk. Mirrors arousal.ts's singleton pattern:
 * module-level `state` + exported object with get/set/reset. The core is pure
 * and self-contained (no mineflayer import at module top level); `persist(bot)`
 * optionally writes a summary into the bot's memory if available.
 */

export type DeathCause =
  | 'hostile'
  | 'creeper'
  | 'fall'
  | 'lava'
  | 'fire'
  | 'drowning'
  | 'void'
  | 'starvation'
  | 'other';

export interface DeathEntry {
  location: string; // landmark / coord key
  cause: DeathCause | string;
  hpAtDeath: number; // 0..20
  nearbyThreats?: number;
  action?: string; // what the bot was doing (e.g. 'caving')
  timestamp?: number;
  guarded?: boolean; // whether guards were in place
}

interface RegisterState {
  entries: DeathEntry[];
}

const state: RegisterState = { entries: [] };

export const deathRegister = {
  get(): DeathEntry[] {
    return state.entries.map((e) => ({ ...e }));
  },
  count(): number {
    return state.entries.length;
  },
  reset(): void {
    state.entries = [];
  }
};

/** Clear all stored deaths. Exposed for tests and teardown. */
export function resetDeathRegisterForTest(): void {
  state.entries = [];
}

/**
 * Record a death episode. Returns the stored entry (with a timestamp if none
 * was provided).
 */
export function recordDeath(entry: DeathEntry): DeathEntry {
  const stored: DeathEntry = {
    ...entry,
    timestamp: entry.timestamp ?? Date.now()
  };
  state.entries.push(stored);
  return stored;
}

export interface GuardRequirement {
  guard: string; // e.g. 'torches>=8'
  threshold: number;
  current?: number;
  satisfied: boolean;
}

export interface GuardResult {
  goal: string;
  action: string;
  guards: GuardRequirement[];
  learned: boolean; // whether any guard was learned from fatal history
}

/** Guards auto-injected by the death register for a dangerous goal. */
export function queryGuards(goal: string, context: { action?: string; location?: string } = {}): GuardResult {
  const action = context.action ?? goal;
  const location = context.location;

  const deaths = state.entries.filter((d) => {
    const matchesAction = d.action === action || d.action === goal;
    const matchesLocation = !location || d.location === location;
    return matchesAction && matchesLocation;
  });

  const guards: GuardRequirement[] = [];

  // Caving — learned from any fatal-failure history for this action/location.
  if (action === 'caving' || goal === 'caving' || deaths.length > 0) {
    const torchDeaths = deaths.filter((d) => d.cause === 'hostile' || d.cause === 'creeper').length;
    const hpDeaths = deaths.filter((d) => d.hpAtDeath < 10).length;

    guards.push({
      guard: 'torches>=8',
      threshold: 8,
      satisfied: torchDeaths === 0
    });
    guards.push({
      guard: 'hp>=10',
      threshold: 10,
      satisfied: hpDeaths === 0
    });
  }

  // Default safety baseline even without history.
  if (guards.length === 0 && (action === 'caving' || goal === 'caving')) {
    guards.push({ guard: 'torches>=8', threshold: 8, satisfied: true });
    guards.push({ guard: 'hp>=10', threshold: 10, satisfied: true });
  }

  return {
    goal,
    action,
    guards,
    learned: deaths.length > 0
  };
}

/**
 * Learned risk score (0..1) for a location, rising with repeated deaths there.
 * Doubles as a somatic marker so higher layers can avoid bad spots.
 */
export function riskAt(location: string): number {
  const deaths = state.entries.filter((d) => d.location === location).length;
  if (deaths === 0) return 0;
  return Math.min(1, deaths * 0.25);
}

export interface DeathStatistics {
  count: number;
  mostCommonCause: string | null;
  locations: string[];
  causes: Record<string, number>;
}

/** Aggregate statistics over the register. */
export function statistics(): DeathStatistics {
  const causes: Record<string, number> = {};
  const locationSet = new Set<string>();
  for (const e of state.entries) {
    causes[e.cause] = (causes[e.cause] ?? 0) + 1;
    locationSet.add(e.location);
  }
  let mostCommonCause: string | null = null;
  let max = 0;
  for (const [cause, n] of Object.entries(causes)) {
    if (n > max) {
      max = n;
      mostCommonCause = cause;
    }
  }
  return {
    count: state.entries.length,
    mostCommonCause,
    locations: [...locationSet],
    causes
  };
}

export interface MemoryLike {
  remember?: (key: string, value: string) => unknown | Promise<unknown>;
  // mineflayer.Bot has no direct remember; allow a functional bot with one.
  [key: string]: unknown;
}

/**
 * Optionally persist the register summary into the bot's memory when a
 * `remember` function is available (e.g. wrapped from memory-tools). Keeps the
 * module's core pure — this is an opt-in side effect.
 */
export async function persist(bot: MemoryLike | null | undefined): Promise<void> {
  const remember = bot?.remember;
  if (typeof remember !== 'function') return;
  const s = statistics();
  await remember(
    'death-register',
    JSON.stringify({ count: s.count, locations: s.locations, causes: s.causes })
  );
}

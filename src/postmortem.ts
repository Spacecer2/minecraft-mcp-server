/**
 * postmortem.ts — the failure-learning pipeline (L4).
 *
 * Every failure is logged as an episode, then classified (preventable /
 * mitigable / random), attributed to the cheapest guard that would have
 * prevented it, and turned into a provisional lesson `IF state THEN
 * mitigation`. Lessons are promoted to learned only on replication or
 * demonstrated prevention, and learned guards are auto-injected when the
 * same goal is replanned (downgrade-then-retry, never abort-and-forget).
 *
 * Deliberately pure + a small singleton store so the whole pipeline is
 * unit-testable without a bot.
 */

export type FailureClass = 'preventable' | 'mitigable' | 'random';

export interface FailureEpisode {
  /** Goal that was being attempted. */
  goal: string;
  /** Plan id / name that was running. */
  plan: string;
  /** Snapshot of the world / bot state at the time of failure. */
  stateSnapshot: Record<string, unknown>;
  /** What the failure was: 'death', 'blocked', 'wasted_resources', etc. */
  outcome: string;
  /** Observed cause (may be a raw string or structured marker). */
  observedCause: string;
  /** True when the failure is attributable to RNG / noise (don't overfit). */
  isRandom?: boolean;
  /** Candidate guard rule ids that, if enforced, would have prevented this. */
  candidateGuards?: string[];
}

/** A candidate guard rule the attribution step considers. */
export interface GuardRule {
  id: string;
  /** Cause/condition this guard protects against (matched to the episode). */
  cause: string;
  /** Relative cost to enforce (higher = more expensive). */
  cost: number;
  /** Higher = more general (applies across more contexts). */
  generality: number;
  /** false = world-mechanics cause (preferred); true = agent-specific. */
  agentSpecific?: boolean;
}

export interface Lesson {
  id: string;
  /** The goal this lesson applies to. */
  goal: string;
  /** The `IF state` condition. */
  ifState: string;
  /** The `THEN mitigation` action. */
  thenMitigation: string;
  /** Source episode id that produced this lesson. */
  sourceEpisodeId: string;
  /** Provisional until replicated or demonstrated prevention. */
  provisional: boolean;
  /** Confidence 0..1. */
  confidence: number;
  /** Attributed cause (guard id or human-readable cause). */
  cause?: string;
}

export interface InjectedGuard {
  lessonId: string;
  ifState: string;
  thenMitigation: string;
}

const RANDOM_MARKERS = ['rng', 'random', 'unlucky', 'noise', 'probabilistic', 'spawn', 'luck'];
const PREVENTABLE_MARKERS = [
  'fell',
  'void',
  'no_torch',
  'torch',
  'durability',
  'tool',
  'missing',
  'guard',
  'cave_without_light',
  'cave',
  'fell_off',
  'break'
];

function containsAny(haystack: string, needles: string[]): boolean {
  const lower = haystack.toLowerCase();
  return needles.some((n) => lower.includes(n));
}

/**
 * Classify a failure episode. Only preventable/mitigable failures generate
 * lessons; random deaths are recorded as noise so we don't overfit to RNG.
 */
export function classifyFailure(episode: FailureEpisode): FailureClass {
  if (episode.isRandom === true) return 'random';
  if (containsAny(episode.observedCause, RANDOM_MARKERS)) return 'random';
  if (containsAny(episode.observedCause, PREVENTABLE_MARKERS)) return 'preventable';
  return 'mitigable';
}

/**
 * Attribute cause: pick the cheapest guard that would have prevented the
 * failure. Prefer world-mechanics causes over agent-specific ones, and
 * prefer the most general rule. Returns the winning GuardRule id, or null
 * if no candidate rule matches.
 */
export function attributeCause(episode: FailureEpisode, candidateRules: GuardRule[]): string | null {
  if (!candidateRules || candidateRules.length === 0) return null;
  const lower = episode.observedCause.toLowerCase();
  const matches = candidateRules.filter((r) => {
    if (!r.cause) return true;
    return lower.includes(r.cause.toLowerCase());
  });
  if (matches.length === 0) return null;
  const winner = [...matches].sort((a, b) => {
    // world-mechanics before agent-specific
    const aAgent = a.agentSpecific === true ? 1 : 0;
    const bAgent = b.agentSpecific === true ? 1 : 0;
    if (aAgent !== bAgent) return aAgent - bAgent;
    // most general first
    if (b.generality !== a.generality) return b.generality - a.generality;
    // cheapest first
    return a.cost - b.cost;
  })[0];
  return winner.id;
}

let lessonSeq = 0;

/**
 * Generate a provisional lesson from an episode + chosen mitigation.
 * `ifState` is derived as `IF <goal> AND <cause> THEN <mitigation>` so the
 * stored rule is directly reusable as a guard.
 */
export function generateLesson(
  episode: FailureEpisode,
  mitigation: string,
  cause?: string
): Lesson {
  lessonSeq += 1;
  const ifState = `IF goal=${episode.goal} AND ${episode.observedCause}`;
  return {
    id: `lesson_${lessonSeq}`,
    goal: episode.goal,
    ifState,
    thenMitigation: mitigation,
    sourceEpisodeId: episode.plan,
    provisional: true,
    confidence: 0.5,
    cause: cause ?? episode.observedCause
  };
}

/**
 * Inject learned guards into a plan for a goal (downgrade-then-retry, not
 * abort-and-forget). Returns the guards that apply to the given goal.
 */
export function injectGuards(goal: string, lessons: Lesson[]): InjectedGuard[] {
  if (!lessons || lessons.length === 0) return [];
  return lessons
    .filter((l) => l.goal === goal || goal.includes(l.goal) || l.goal.includes(goal))
    .map((l) => ({ lessonId: l.id, ifState: l.ifState, thenMitigation: l.thenMitigation }));
}

// ---------------------------------------------------------------------------
// Lesson store singleton (mirrors the arousal.ts singleton pattern)
// ---------------------------------------------------------------------------

const store: { lessons: Lesson[]; replications: Map<string, number> } = {
  lessons: [],
  replications: new Map()
};

export const lessonStore = {
  /** Record a lesson (provisional unless caller sets provisional=false). */
  recordLesson(lesson: Lesson): void {
    store.lessons.push(lesson);
    if (!store.replications.has(lesson.id)) store.replications.set(lesson.id, 0);
  },

  /** Return lessons applicable to a context (goal or free-text keyword). */
  lessonsFor(context: string): Lesson[] {
    if (!context) return [...store.lessons];
    return store.lessons.filter(
      (l) => l.goal === context || l.ifState.includes(context) || context.includes(l.goal)
    );
  },

  /** Mark a replication of a lesson; promote to learned once replicated. */
  replicateLesson(id: string): void {
    const n = (store.replications.get(id) ?? 0) + 1;
    store.replications.set(id, n);
    if (n >= 2) lessonStore.promoteLesson(id);
  },

  /** Promote a provisional lesson to learned (replication or prevention). */
  promoteLesson(id: string): boolean {
    const lesson = store.lessons.find((l) => l.id === id);
    if (!lesson) return false;
    if (lesson.provisional) {
      lesson.provisional = false;
      lesson.confidence = Math.min(1, lesson.confidence + 0.3);
    }
    return true;
  },

  /** Number of lessons currently stored. */
  getLessonCount(): number {
    return store.lessons.length;
  },

  /** Clear all stored lessons + replication counts (tests). */
  resetPostmortemForTest(): void {
    store.lessons = [];
    store.replications.clear();
  }
};

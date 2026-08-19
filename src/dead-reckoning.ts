/**
 * dead-reckoning.ts — coordinate dead reckoning for the survival bot.
 * Always know base coords; compute the return vector before any long trip,
 * budget it against a deadline (return-before-dusk), apply the route axioms,
 * and light the return path so it is marked and spawn-proofed. Pure module.
 */

export type Position = { x: number; y: number; z: number };

export type LandmarkLike = {
  name?: string;
  x: number;
  y: number;
  z: number;
  type: string;
};

export type TripBudget = {
  feasible: boolean;
  remainingTime: number;
  returnDistance: number;
  maxSafeOutreach: number;
};

export type Waypoint = { x: number; y: number; z: number; reason: string };

function distance(a: Position, b: Position): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function nearest(target: Position, candidates: LandmarkLike[]): LandmarkLike | undefined {
  let best: LandmarkLike | undefined;
  let bestDist = Infinity;
  for (const candidate of candidates) {
    const d = distance(target, candidate);
    if (d < bestDist) {
      bestDist = d;
      best = candidate;
    }
  }
  return best;
}

// The vector from `current` back to `base` (i.e. base minus current). This is
// the heading the bot must travel to get home.
export function returnVector(current: Position, base: Position): Position {
  return { x: base.x - current.x, y: base.y - current.y, z: base.z - current.z };
}

// The return-before-dusk discipline: can the bot still get home by the
// deadline from where it is now, and how far out may it roam? `returnDeadline`
// is an epoch-millisecond timestamp; `nowMs` defaults to Date.now() but is
// injectable for deterministic tests.
export function tripBudget(
  botPos: Position,
  basePos: Position,
  distancePerMinute: number,
  returnDeadline: number,
  nowMs = Date.now()
): TripBudget {
  const speed = Number.isFinite(distancePerMinute) && distancePerMinute > 0 ? distancePerMinute : 0;
  const remainingTime = Math.max(0, (returnDeadline - nowMs) / 60000);
  const returnDistance = distance(botPos, basePos);
  const returnTime = speed > 0 ? returnDistance / speed : Infinity;
  const maxSafeOutreach = (remainingTime * speed) / 2;
  return { feasible: returnTime <= remainingTime, remainingTime, returnDistance, maxSafeOutreach };
}

// Route axioms: start from the current position, climb the nearest high point
// once per biome (monument if present, otherwise the highest landmark) for
// line-of-sight, then follow the river downstream toward the nearest village.
export function routeAxiom(start: Position, landmarks: LandmarkLike[], biome: string): Waypoint[] {
  const waypoints: Waypoint[] = [{ x: start.x, y: start.y, z: start.z, reason: 'start' }];

  const monuments = landmarks.filter((l) => l.type === 'monument');
  const villages = landmarks.filter((l) => l.type === 'village');

  let highPoint: LandmarkLike | undefined;
  if (monuments.length > 0) {
    highPoint = nearest(start, monuments);
  } else if (landmarks.length > 0) {
    highPoint = landmarks.reduce((a, b) => (b.y > a.y ? b : a));
  }
  const village = nearest(start, villages);

  if (highPoint && highPoint !== village) {
    waypoints.push({
      x: highPoint.x,
      y: highPoint.y,
      z: highPoint.z,
      reason: `climb nearest high point (${biome}) for line-of-sight`
    });
  }
  if (village) {
    waypoints.push({
      x: village.x,
      y: village.y,
      z: village.z,
      reason: 'follow river downstream toward village'
    });
  }
  return waypoints;
}

const MAX_TORCHES = 1024;

// Generate torch positions every `spacing` blocks along the segment from the
// current position (base minus the return vector) back to base. The torch
// line marks the return route and keeps it spawn-proofed.
export function lightReturnPath(basePos: Position, returnVector: Position, spacing: number): Position[] {
  if (!(spacing > 0)) {
    throw new Error('spacing must be a positive number');
  }
  const start: Position = {
    x: basePos.x - returnVector.x,
    y: basePos.y - returnVector.y,
    z: basePos.z - returnVector.z
  };
  const length = distance(start, basePos);
  if (length === 0) {
    return [];
  }
  const steps = Math.min(Math.floor(length / spacing), MAX_TORCHES);
  const torches: Position[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = steps === 0 ? 0 : i / steps;
    torches.push({
      x: Math.round(start.x + (basePos.x - start.x) * t),
      y: Math.round(start.y + (basePos.y - start.y) * t),
      z: Math.round(start.z + (basePos.z - start.z) * t)
    });
  }
  return torches;
}
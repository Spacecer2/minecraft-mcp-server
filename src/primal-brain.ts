/**
 * PRIMAL BRAIN — ETERNAL SAFETY LOOP
 *
 * The deepest layer of the agent's "action machine". Where the watchdog is a
 * reactive preemption state machine (it cancels on events) and the LLM is the
 * slow rational top layer, the primal brain is an ALWAYS-ON background loop that
 * continuously SENSES danger and, when it senses stress, issues a P0 directive
 * that CANCELS ANYTHING (higher priority than any goal or LLM action) and then
 * runs a hard-coded, efficient safety micro-task itself — WITHOUT asking the
 * LLM.
 *
 * Layering:
 *   - Primal brain (this module)  — eternal loop, senses stress, P0 cancel,
 *                                   executes low-level safety tasks directly.
 *   - Watchdog (watchdog.ts)      — event-driven preemption, P1/P3 interrupts.
 *   - Goal runner (goal-runner.ts)— background long-term goals (cooperative).
 *   - LLM / reason (top)          — slow, long-horizon planning.
 *
 * The primal loop's directives use InterruptPriority.P0 (the highest), so via
 * the shared interrupt channel (interrupt.ts) it can preempt a goal, a tool, or
 * an in-flight LLM action. Stress is SENSED here from bot sensors — not read by
 * the LLM from logs.
 */

import {
  setInterrupt,
  clearInterrupt,
  isInterrupted,
  getInterruptReason,
  getInterruptPriority,
  InterruptPriority
} from './interrupt.js';
import { isHostileEntity } from './tools/entity-tools.js';

export type PrimalDirective = {
  reason: string;         // e.g. 'hostile-threat', 'drowning', 'lava', 'void', 'low-health'
  action: string;         // the lower-level task to run, e.g. 'flee', 'surface', 'escape-lava', 'escape-void'
  priority: number;       // P0 for safety
  message: string;        // human/LLM-readable directive
};

export type PrimalSensorInput = {
  health?: number;
  oxygenLevel?: number;
  position?: { x: number; y: number; z: number };
  hostilesNearby?: number;
  lavaNearby?: boolean;
  inVoid?: boolean;
  onFire?: boolean;
  falling?: boolean;
};

// ---------------------------------------------------------------------------
// AROUSAL DECOUPLING (parallel task)
//
// src/arousal.ts is being created in parallel and does NOT exist yet when this
// module compiles. To keep this module compiling standalone (tsc --noEmit must
// pass), we do NOT hard-import './arousal.js'. Instead we expose a setter
// `setArousalSensor(fn)` that the arousal-wiring task calls with its `senseAnxiety`
// implementation (the parallel task wires `arousal.setAnxiety`). Until it is
// wired, the sensor is a no-op and anxiety stays 0.
//
// DECOUPLING CHOICE (documented): setter-injection, not static import.
// ---------------------------------------------------------------------------

export type ArousalSensor = (input: PrimalSensorInput) => number;

let senseAnxietyFn: ArousalSensor | null = null;

/**
 * Wire the arousal sensor (anxiety reader) from the parallel arousal module.
 * Call with the arousal module's `senseAnxiety` implementation once it exists.
 * Pass null to reset to the default no-op.
 */
export function setArousalSensor(fn: ArousalSensor | null): void {
  senseAnxietyFn = fn ?? null;
}

// ---------------------------------------------------------------------------
// senseDanger — priority order, FIRST match wins (deepest / highest first)
// ---------------------------------------------------------------------------

export const PRIMAL_P0 = InterruptPriority.P0;

/**
 * Sense danger from raw sensor input and compute anxiety. Returns a safety
 * directive when a safety action is required, else null (safe).
 *
 * Priority order (the first that matches wins — deepest/highest first):
 *   1. inVoid              → escape-void
 *   2. onFire              → escape-fire
 *   3. lavaNearby          → escape-lava
 *   4. drowning (O2 < 10)  → surface
 *   5. low-health (< 6)    → defend
 *   6. hostilesNearby >= 1 → flee
 *   7. else                → null (safe)
 */
export function senseDanger(input: PrimalSensorInput): PrimalDirective | null {
  if (input.inVoid) {
    return {
      reason: 'void',
      action: 'escape-void',
      priority: PRIMAL_P0,
      message: 'PRIMAL: in the void — CANCEL EVERYTHING; escape upward/away to safe ground immediately.'
    };
  }
  if (input.onFire) {
    return {
      reason: 'on-fire',
      action: 'escape-fire',
      priority: PRIMAL_P0,
      message: 'PRIMAL: ON FIRE — CANCEL EVERYTHING; move away / douse to stop burning.'
    };
  }
  if (input.lavaNearby) {
    return {
      reason: 'lava',
      action: 'escape-lava',
      priority: PRIMAL_P0,
      message: 'PRIMAL: lava nearby — CANCEL EVERYTHING; path away from lava to solid ground.'
    };
  }
  if (typeof input.oxygenLevel === 'number' && input.oxygenLevel < 10) {
    return {
      reason: 'drowning',
      action: 'surface',
      priority: PRIMAL_P0,
      message: 'PRIMAL: DROWNING (oxygen low) — CANCEL EVERYTHING; swim to the surface.'
    };
  }
  if (typeof input.health === 'number' && input.health < 6) {
    return {
      reason: 'low-health',
      action: 'defend',
      priority: PRIMAL_P0,
      message: 'PRIMAL: LOW HEALTH — CANCEL EVERYTHING; equip best weapon and defend / retreat.'
    };
  }
  if (typeof input.hostilesNearby === 'number' && input.hostilesNearby >= 1) {
    return {
      reason: 'hostile-threat',
      action: 'flee',
      priority: PRIMAL_P0,
      message: 'PRIMAL: hostiles nearby — CANCEL EVERYTHING; flee from hostiles to safety.'
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// SENSOR READING — pull danger signals straight off the live bot
// ---------------------------------------------------------------------------

/**
 * Read the danger-relevant sensors from a live mineflayer bot and produce the
 * PrimalSensorInput. Best-effort: every read is guarded so a partial or odd bot
 * never throws. `hostilesNearby` is derived from the entity map within a radius
 * (default 8 blocks). `lavaNearby` uses bot.findBlock when available.
 */
function readSensors(bot: unknown, hostileDist = 8): PrimalSensorInput {
  const input: PrimalSensorInput = {};
  try {
    const b = bot as {
      health?: number;
      oxygenLevel?: number;
      entity?: {
        id?: number;
        position?: { x: number; y: number; z: number };
        onFire?: boolean;
        fireTicks?: number;
        flameTicks?: number;
      };
      findBlock?: (opts: {
        matching: (block: { name?: string }) => boolean;
        maxDistance: number;
        count: number;
      }) => { name?: string } | null;
      entities?: unknown;
    };

    if (typeof b?.health === 'number') input.health = b.health;
    if (typeof b?.oxygenLevel === 'number') input.oxygenLevel = b.oxygenLevel;
    if (b?.entity?.position) {
      input.position = { x: b.entity.position.x, y: b.entity.position.y, z: b.entity.position.z };
    }

    // Void: below y=-60 (matches watchdog voidY default).
    if (typeof input.position?.y === 'number' && input.position.y < -60) input.inVoid = true;

    // On fire: fireTicks/flameTicks > 0.
    const entity = b?.entity as
      | { onFire?: boolean; fireTicks?: number; flameTicks?: number }
      | undefined;
    const fire =
      (typeof entity?.fireTicks === 'number' ? entity.fireTicks : 0) +
      (typeof entity?.flameTicks === 'number' ? entity.flameTicks : 0);
    if (fire > 0 || entity?.onFire) input.onFire = true;

    // Lava nearby: check the block at the bot and the 4 cardinal neighbours.
    if (typeof b?.findBlock === 'function') {
      try {
        const lava = b.findBlock({
          matching: (block) => block.name === 'lava' || block.name === 'flowing_lava',
          maxDistance: 3,
          count: 1
        });
        if (lava) input.lavaNearby = true;
      } catch {
        input.lavaNearby = false;
      }
    }

    // Hostiles nearby: count hostile mobs within radius.
    try {
      const selfId = b?.entity?.id;
      const origin = b?.entity?.position;
      let hostiles = 0;
      const raw = b?.entities;
      const records =
        raw instanceof Map
          ? Array.from(raw.values())
          : raw
            ? Object.values(raw as Record<string, unknown>)
            : [];
      for (const e of records) {
        const ent = e as {
          id?: number;
          name?: string;
          mobType?: string;
          type?: string;
          position?: { x: number; y: number; z: number };
        };
        if (selfId !== undefined && ent.id === selfId) continue;
        if (!isHostileEntity(ent as never)) continue;
        if (!ent.position || !origin) continue;
        const dx = origin.x - ent.position.x;
        const dz = origin.z - ent.position.z;
        if (Math.sqrt(dx * dx + dz * dz) <= hostileDist) hostiles++;
      }
      if (hostiles > 0) input.hostilesNearby = hostiles;
    } catch {
      // no entity map — treat as no hostiles
    }
  } catch {
    // any sensor read failure → safe-by-default
  }
  return input;
}

// ---------------------------------------------------------------------------
// ETERNAL LOOP STATE (module-level, epoch pattern like goal-runner)
// ---------------------------------------------------------------------------

let primalRunning = false;
/** Loop generation so stop/restart can never double-run (stale loop exits at yield). */
let primalEpoch = 0;
let primalBot: unknown = null;
let lastPrimalDirective: PrimalDirective | null = null;
/** The reason string of the interrupt the primal loop most recently set itself. */
let ownInterruptReason: string | null = null;
let currentCadenceMs = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// SAFETY MICRO-TASKS — hard, efficient, best-effort, wrapped in try/catch.
// The primal brain runs these DIRECTLY on the bot; it does NOT ask the LLM.
// ---------------------------------------------------------------------------

/** Hard-cancel any in-progress pathfinding / movement (deepest access). */
function hardStop(bot: unknown): void {
  try {
    const pf = (bot as { pathfinder?: { stop?: () => unknown } }).pathfinder;
    if (pf && typeof pf.stop === 'function') pf.stop();
  } catch {
    // best-effort
  }
  try {
    const controls = (bot as { setControlState?: (s: string, v: boolean) => unknown }).setControlState;
    if (typeof controls === 'function') {
      controls('forward', false);
      controls('back', false);
      controls('left', false);
      controls('right', false);
      controls('jump', false);
      controls('sprint', false);
    }
  } catch {
    // best-effort
  }
}

/** Escape the void: move up (jump/ascend) and toward safe ground. */
async function escapeVoid(bot: unknown): Promise<void> {
  hardStop(bot);
  try {
    const botC = bot as { setControlState?: (s: string, v: boolean) => unknown; jump?: () => unknown };
    if (typeof botC.jump === 'function') {
      try {
        botC.jump();
      } catch {
        /* best-effort */
      }
    }
    if (typeof botC.setControlState === 'function') {
      botC.setControlState('jump', true);
      await sleep(500);
      botC.setControlState('jump', false);
    }
  } catch {
    // best-effort
  }
}

/** Escape fire: hard-stop and move away from current facing. */
async function escapeFire(bot: unknown): Promise<void> {
  hardStop(bot);
  await moveAway(bot);
}

/** Escape lava: hard-stop and move away along the ground to solid footing. */
async function escapeLava(bot: unknown): Promise<void> {
  hardStop(bot);
  try {
    const b = bot as {
      pathfinder?: { goto?: (goal: unknown) => Promise<unknown> };
      entity?: { position?: { x: number; y: number; z: number } };
    };
    const pf = b?.pathfinder;
    if (pf && typeof pf.goto === 'function' && b?.entity?.position) {
      const p = b.entity.position;
      // Try to jump/ascend away from lava: go up and horizontally outward.
      const goal = { x: p.x + 3, y: p.y + 2, z: p.z + 3 };
      try {
        await pf.goto(goal);
      } catch {
        await moveAway(bot);
      }
    } else {
      await moveAway(bot);
    }
  } catch {
    await moveAway(bot);
  }
}

/** Surface: swim up / jump to reach the surface. */
async function surface(bot: unknown): Promise<void> {
  hardStop(bot);
  try {
    const b = bot as { setControlState?: (s: string, v: boolean) => unknown };
    const swim = b?.setControlState;
    if (typeof swim === 'function') {
      // Head up repeatedly for ~3s.
      const start = Date.now();
      while (Date.now() - start < 3000) {
        swim('jump', true);
        swim('forward', true);
        await sleep(150);
        swim('jump', false);
      }
      swim('forward', false);
      swim('jump', false);
    }
  } catch {
    // best-effort
  }
}

/** Defend: equip best weapon and attack the nearest hostile. */
async function defend(bot: unknown): Promise<void> {
  try {
    const equip = (bot as { equip?: (slot: string, dest: string) => Promise<unknown> }).equip;
    const inv = (bot as { inventory?: { items?: () => { name?: string; type?: string }[] } }).inventory;
    if (typeof equip === 'function') {
      const items = inv?.items?.() ?? [];
      const sword = items.find((i) => (i.name || '').includes('sword'));
      const axe = items.find((i) => (i.name || '').includes('axe'));
      const weapon = sword ?? axe;
      if (weapon?.name) {
        try {
          await equip(weapon.name, 'hand');
        } catch {
          // best-effort
        }
      }
    }
    const attack = (bot as { attack?: (e: unknown) => unknown }).attack;
    const b = bot as { nearestEntity?: (filter?: (e: never) => boolean) => unknown | null };
    if (typeof attack === 'function' && typeof b.nearestEntity === 'function') {
      const target = b.nearestEntity((e: never) => isHostileEntity(e));
      if (target) {
        try {
          attack(target);
        } catch {
          // best-effort
        }
      }
    }
  } catch {
    // best-effort
  }
}

/** Flee: move away from the nearest hostile. */
async function flee(bot: unknown): Promise<void> {
  hardStop(bot);
  try {
    const b = bot as {
      entity?: { position?: { x: number; y: number; z: number } };
      nearestEntity?: (filter?: (e: never) => boolean) => unknown | null;
    };
    const origin = b?.entity?.position;
    let away: { x: number; y: number; z: number } | null = null;
    if (origin && typeof b.nearestEntity === 'function') {
      const hostile = b.nearestEntity((e: never) => isHostileEntity(e)) as
        | { position?: { x: number; y: number; z: number } }
        | null;
      if (hostile?.position) {
        const dx = origin.x - hostile.position.x;
        const dz = origin.z - hostile.position.z;
        const len = Math.sqrt(dx * dx + dz * dz) || 1;
        away = {
          x: origin.x + (dx / len) * 8,
          y: origin.y,
          z: origin.z + (dz / len) * 8
        };
      }
    }
    if (away) {
      const goto = (bot as { pathfinder?: { goto?: (g: unknown) => Promise<unknown> } }).pathfinder?.goto;
      if (typeof goto === 'function') {
        try {
          await goto(away);
          return;
        } catch {
          // fall through to raw move
        }
      }
    }
    await moveAway(bot);
  } catch {
    await moveAway(bot);
  }
}

/** Raw movement away from current facing (fallback for fire/lava/flee). */
async function moveAway(bot: unknown): Promise<void> {
  try {
    const b = bot as { setControlState?: (s: string, v: boolean) => unknown };
    const set = b?.setControlState;
    if (typeof set !== 'function') return;
    const start = Date.now();
    while (Date.now() - start < 1500) {
      set('forward', true);
      set('jump', true);
      await sleep(150);
    }
    set('forward', false);
    set('jump', false);
  } catch {
    // best-effort
  }
}

/** Dispatch a directive to its low-level safety micro-task. */
async function executeDirective(bot: unknown, directive: PrimalDirective): Promise<void> {
  switch (directive.action) {
    case 'escape-void':
      await escapeVoid(bot);
      break;
    case 'escape-fire':
      await escapeFire(bot);
      break;
    case 'escape-lava':
      await escapeLava(bot);
      break;
    case 'surface':
      await surface(bot);
      break;
    case 'defend':
      await defend(bot);
      break;
    case 'flee':
      await flee(bot);
      break;
    default:
      await moveAway(bot);
  }
}

// ---------------------------------------------------------------------------
// ETERNAL LOOP
// ---------------------------------------------------------------------------

/**
 * The eternal primal loop body. Runs continuously at `cadenceMs`, sensing
 * danger and, when a safety directive is required:
 *   (a) feeds arousal (anxiety rises with danger) via the wired sensor,
 *   (b) sets a P0 interrupt on the shared channel — CANCEL ANYTHING,
 *   (c) records lastPrimalDirective,
 *   (d) executes the low-level safety micro-task directly on the bot.
 * When safe again it lowers anxiety and clears its OWN P0 interrupt (only if
 * no other interrupt is pending). Never throws unhandled.
 */
async function primalLoopBody(bot: unknown): Promise<void> {
  const epoch = ++primalEpoch;
  try {
    while (primalRunning && primalEpoch === epoch) {
      await sleep(currentCadenceMs);
      if (!primalRunning || primalEpoch !== epoch) break;

      const input = readSensors(bot);
      const directive = senseDanger(input);

      // (a) feed arousal — anxiety rises with danger, falls when safe. The
      // arousal sensor (wired by the parallel task via setArousalSensor) reads
      // `input` and sets arousal.setAnxiety itself; until wired this is a no-op.
      if (senseAnxietyFn) {
        try {
          senseAnxietyFn(input);
        } catch {
          // best-effort
        }
      }

      if (directive) {
        lastPrimalDirective = directive;
        // (b) P0 interrupt — deepest access, cancels any goal/tool/LLM action.
        const owned = setInterrupt(directive.message, PRIMAL_P0);
        if (!owned) ownInterruptReason = directive.message;
        // (d) run the safety micro-task directly (hard efficient code, no LLM).
        try {
          await executeDirective(bot, directive);
        } catch {
          // safety actions must never kill the loop
        }
      } else {
        // Safe: clear our own safety interrupt if we still own it AND no other
        // (possibly higher-layer) interrupt superseded it. Lowering anxiety back
        // to 0 is handled by the wired arousal sensor on the safe input.
        clearOwnInterruptIfSafe();
      }
    }
  } catch {
    // never throw unhandled
  } finally {
    if (primalEpoch === epoch) {
      primalRunning = false;
    }
  }
}

/**
 * INTERRUPT OWNERSHIP:
 * The primal loop sets its own P0 interrupt. It must NOT clear an interrupt set
 * by a higher/other layer (e.g. a fresh P0 from the host, or a directive another
 * subsystem set). We only clear when:
 *   - an interrupt is pending, AND
 *   - its reason matches the one we most recently set (we own it), AND
 *   - no higher-priority interrupt could have superseded it (P0 is max, but we
 *     still check it's still P0 and ours).
 * Once danger passes and we own the pending interrupt, we clear it so the agent
 * can resume; otherwise we leave the foreign interrupt intact.
 */
function clearOwnInterruptIfSafe(): void {
  if (!isInterrupted()) return;
  if (ownInterruptReason === null) return;
  const reason = getInterruptReason();
  const prio = getInterruptPriority();
  if (prio === PRIMAL_P0 && reason === ownInterruptReason) {
    clearInterrupt();
    ownInterruptReason = null;
  }
}

/**
 * Start the eternal primal safety loop in the background (not awaited). The
 * loop runs continuously at `cadenceMs` (default 500), sensing danger and
 * issuing P0 directives that CANCEL anything and delegate to low-level safety
 * tasks. Idempotent per bot; restarting bumps the epoch so no double loop runs.
 */
export function startPrimalLoop(bot: unknown, cadenceMs = 500): void {
  if (!bot) return;
  if (primalRunning && primalBot === bot) return;
  currentCadenceMs = cadenceMs > 0 ? cadenceMs : 500;
  primalBot = bot;
  primalRunning = true;
  // Epoch pattern: any stale loop (from a previous bot or restart) exits at its
  // next yield, so a restart can never run two loops simultaneously.
  primalEpoch++;
  void primalLoopBody(bot);
}

/** Stop the eternal primal loop. The running iteration yields and exits. */
export function stopPrimalLoop(): void {
  primalRunning = false;
}

/** True when the eternal primal loop is currently running. */
export function primalLoopRunning(): boolean {
  return primalRunning;
}

/** The most recently issued primal directive (or null). */
export function getLastPrimalDirective(): PrimalDirective | null {
  return lastPrimalDirective;
}

/** Reset all primal-brain state for test isolation. */
export function resetPrimalBrainForTest(): void {
  stopPrimalLoop();
  primalEpoch++;
  primalBot = null;
  lastPrimalDirective = null;
  ownInterruptReason = null;
  currentCadenceMs = 500;
  senseAnxietyFn = null;
  clearInterrupt();
}

/** Convenience: restart the loop against a (possibly new) bot. */
export function restartPrimalLoop(bot: unknown, cadenceMs = 500): void {
  stopPrimalLoop();
  startPrimalLoop(bot, cadenceMs);
}

/**
 * Test-only / diagnostic: read the current sensor snapshot from a bot.
 */
export function readPrimalSensors(bot: unknown): PrimalSensorInput {
  return readSensors(bot);
}

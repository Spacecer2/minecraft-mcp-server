import { z } from "zod";
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';
import { checkInterrupt, isInterruptError, getInterruptReason } from '../interrupt.js';
import { cushionState } from './combat-tools.js';
import { resourceCushionOK } from '../fallback.js';

type Waypoint = { x: number; y: number; z: number };
type Condition = 'night' | 'day' | 'hungry' | 'full-health' | 'low-health' | 'not-sleeping';

const HAZARDS = new Set<string>([
  'lava',
  'flowing_lava',
  'water',
  'flowing_water',
  'magma_block',
  'fire',
  'cactus',
  'bedrock'
]);

const CONDITIONS: Record<Condition, (bot: mineflayer.Bot) => boolean> = {
  'night': (bot) => bot.time.timeOfDay >= 13000,
  'day': (bot) => bot.time.timeOfDay < 13000,
  'hungry': (bot) => bot.food < 10,
  'full-health': (bot) => bot.health >= 20,
  'low-health': (bot) => bot.health < 6,
  'not-sleeping': (bot) => !bot.isSleeping
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Additive, non-blocking cushion warning surfaced when the safe path crosses
 * water. Warns about swim (and related mining) resource cushions when they are
 * not met, without vetoing the path itself.
 */
function swimCushionWarning(bot: mineflayer.Bot): string | null {
  const state = cushionState(bot);
  const notes: string[] = [];
  if (!resourceCushionOK(state, 'swim')) {
    notes.push('swim cushion not met (low HP/food for swimming)');
  }
  if (!resourceCushionOK(state, 'mine')) {
    notes.push('mining cushion not met along route');
  }
  if (notes.length === 0) return null;
  return `Cushion note: crossing water — ${notes.join('; ')}.`;
}

async function gotoLeg(
  bot: mineflayer.Bot,
  x: number,
  y: number,
  z: number,
  range: number,
  timeoutMs: number
): Promise<'ok' | 'timed-out'> {
  const goal = new goals.GoalNear(x, y, z, range);
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let timeoutPromise: Promise<never> | null = null;
  let timedOut = false;

  timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      reject(new Error(`Move timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  const gotoPromise = bot.pathfinder.goto(goal);

  try {
    await Promise.race([gotoPromise, timeoutPromise]);
    return 'ok';
  } catch (error) {
    if (timedOut) {
      return 'timed-out';
    }
    throw error;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (timedOut) {
      bot.pathfinder.stop();
      gotoPromise.catch(() => {});
    }
  }
}

export function registerMotionTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "find-safe-path",
    "Compute a list of waypoints from the bot's current position to a target that avoids known hazards (lava, water, magma, fire, cactus, bedrock)",
    {
      x: z.coerce.number().describe("Target X coordinate"),
      y: z.coerce.number().describe("Target Y coordinate"),
      z: z.coerce.number().describe("Target Z coordinate"),
      step: z.coerce.number().optional().describe("Probe interval in blocks (default: 4)")
    },
    async ({ x, y, z, step = 4 }: { x: number; y: number; z: number; step?: number }) => {
      checkInterrupt();
      const bot = getBot();
      const start = bot.entity.position;
      const sx = Math.floor(start.x);
      const sy = Math.floor(start.y);
      const sz = Math.floor(start.z);
      const safeStep = Math.max(1, step);
      const dx = x - sx;
      const dy = y - sy;
      const dz = z - sz;
      const total = Math.max(1, Math.hypot(dx, dy, dz));
      const intervals = Math.max(1, Math.ceil(total / safeStep));

      const waypoints: Waypoint[] = [];
      let hazardFound = false;
      let waterCrossed = false;

      for (let i = 1; i <= intervals && waypoints.length < 20; i++) {
        const t = Math.min(1, (i * safeStep) / total);
        const bx = Math.round(sx + t * dx);
        const by = Math.round(sy + t * dy);
        const bz = Math.round(sz + t * dz);

        const ground = bot.blockAt(new Vec3(bx, by - 1, bz));
        const block = bot.blockAt(new Vec3(bx, by, bz));
        const groundName = ground?.name ?? 'air';
        const blockName = block?.name ?? 'air';

        if (HAZARDS.has(groundName) || HAZARDS.has(blockName)) {
          hazardFound = true;
          if (groundName === 'water' || groundName === 'flowing_water' || blockName === 'water' || blockName === 'flowing_water') {
            waterCrossed = true;
          }
          waypoints.push({ x: bx + safeStep, y: by, z: bz });
          waypoints.push({ x: bx + safeStep, y: by, z: bz + safeStep });
        } else {
          waypoints.push({ x: bx, y: by, z: bz });
        }
      }

      const cushionWarning = waterCrossed
        ? swimCushionWarning(bot)
        : null;

      if (!hazardFound) {
        return factory.createResponse(
          cushionWarning
            ? `Direct path is clear (no hazards detected).\n${cushionWarning}`
            : "Direct path is clear (no hazards detected)."
        );
      }

      const lines = waypoints.map(
        (wp, idx) => `${idx + 1}. (${Math.floor(wp.x)}, ${Math.floor(wp.y)}, ${Math.floor(wp.z)})`
      );
      const base = `Safe path to (${Math.floor(x)}, ${Math.floor(y)}, ${Math.floor(z)}): ${waypoints.length} waypoint(s):\n${lines.join('\n')}`;
      return factory.createResponse(cushionWarning ? `${base}\n${cushionWarning}` : base);
    }
  );

  factory.registerTool(
    "walk-path",
    "Walk through an ordered list of waypoints, stopping early if a leg times out",
    {
      waypoints: z.array(z.object({
        x: z.coerce.number().describe("Waypoint X coordinate"),
        y: z.coerce.number().describe("Waypoint Y coordinate"),
        z: z.coerce.number().describe("Waypoint Z coordinate")
      })).min(1).max(20).describe("Ordered waypoints to visit"),
      range: z.coerce.number().optional().describe("How close to get to each waypoint (default: 1)"),
      timeoutMs: z.number().int().min(50).optional().describe("Per-leg timeout in milliseconds (default: 10000)")
    },
    async ({ waypoints: wps, range = 1, timeoutMs = 10000 }: { waypoints: Waypoint[]; range?: number; timeoutMs?: number }) => {
      const bot = getBot();
      let completed = 0;

      try {
        for (let i = 0; i < wps.length; i++) {
          checkInterrupt();
          const wp = wps[i];
          const legResult = await gotoLeg(bot, wp.x, wp.y, wp.z, range, timeoutMs);
          if (legResult === 'timed-out') {
            const pos = bot.entity.position;
            return factory.createErrorResponse(`Stopped at leg ${i + 1} (timed out); now at (${pos.x}, ${pos.y}, ${pos.z})`);
          }
          completed++;
        }

        const pos = bot.entity.position;
        return factory.createResponse(`Walked ${completed}/${wps.length} legs; now at (${pos.x}, ${pos.y}, ${pos.z})`);
      } catch (error) {
        if (isInterruptError(error)) {
          bot.pathfinder.stop();
          return factory.createErrorResponse(`Walked ${completed}/${wps.length} legs; INTERRUPTED: ${getInterruptReason() ?? 'Action cancelled by watchdog'}.`);
        }
        throw error;
      }
    }
  );

  factory.registerTool(
    "wait",
    "Pause for a given number of seconds",
    {
      seconds: z.coerce.number().positive().optional().describe("Seconds to wait (default: 1)"),
      maxSeconds: z.coerce.number().optional().describe("Upper bound on wait time (default: 60)")
    },
    async ({ seconds = 1, maxSeconds = 60 }: { seconds?: number; maxSeconds?: number }) => {
      const clamped = Math.min(Math.max(seconds, 0), maxSeconds);
      await new Promise<void>((resolve) => setTimeout(resolve, clamped * 1000));
      return factory.createResponse(`Waited ${clamped}s.`);
    }
  );

  factory.registerTool(
    "until",
    "Wait until a world or agent condition becomes true (e.g. night, day, hungry)",
    {
      condition: z.enum(['night', 'day', 'hungry', 'full-health', 'low-health', 'not-sleeping']).describe("Condition to wait for"),
      timeoutSeconds: z.coerce.number().optional().describe("Max seconds to wait (default: 120)")
    },
    async ({ condition, timeoutSeconds = 120 }: { condition: Condition; timeoutSeconds?: number }) => {
      const bot = getBot();
      const check = CONDITIONS[condition];
      const start = Date.now();
      const deadline = start + timeoutSeconds * 1000;

      while (true) {
        if (check(bot)) {
          const elapsed = ((Date.now() - start) / 1000).toFixed(1);
          return factory.createResponse(`Condition '${condition}' met after ${elapsed}s.`);
        }
        if (Date.now() >= deadline) {
          return factory.createErrorResponse(`Timed out waiting for '${condition}' after ${timeoutSeconds}s.`);
        }
        await sleep(500);
      }
    }
  );
}

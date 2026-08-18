import { z } from "zod";
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { ToolFactory } from '../tool-factory.js';
import { checkInterrupt } from '../interrupt.js';

type Waypoint = { x: number; y: number; z: number };
type Heading = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

const waypoints = new Map<string, Waypoint>();

// Minecraft convention: yaw 0 = south, increasing yaw rotates counterclockwise
// when viewed from above, so north = -z and east = +x. Maps heading -> {dx, dz}
// offset (north moves toward -z, east toward +x).
const HEADING_OFFSETS: Record<Heading, { dx: number; dz: number }> = {
  n: { dx: 0, dz: -1 },
  ne: { dx: 1, dz: -1 },
  e: { dx: 1, dz: 0 },
  se: { dx: 1, dz: 1 },
  s: { dx: 0, dz: 1 },
  sw: { dx: -1, dz: 1 },
  w: { dx: -1, dz: 0 },
  nw: { dx: -1, dz: -1 }
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function gotoNear(
  bot: mineflayer.Bot,
  x: number,
  y: number,
  z: number,
  range: number,
  timeoutMs?: number
): Promise<{ x: number; y: number; z: number }> {
  const goal = new goals.GoalNear(x, y, z, range);
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let timeoutPromise: Promise<never> | null = null;
  let timedOut = false;

  if (timeoutMs !== undefined) {
    timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        reject(new Error(`Move timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
  }

  const gotoPromise = bot.pathfinder.goto(goal);

  try {
    if (timeoutPromise) {
      await Promise.race([gotoPromise, timeoutPromise]);
    } else {
      await gotoPromise;
    }
    const pos = bot.entity.position;
    return { x: pos.x, y: pos.y, z: pos.z };
  } catch (error) {
    if (timedOut) {
      const pos = bot.entity.position;
      throw new Error(`Move timed out after ${timeoutMs}ms. Current position: (${pos.x}, ${pos.y}, ${pos.z}), target: (${x}, ${y}, ${z})`);
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

export function registerNavigationTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "move-toward",
    "Move the bot a relative distance from its current position (e.g. 'go 5 blocks north')",
    {
      dx: z.coerce.number().describe("X offset to move"),
      dy: z.coerce.number().optional().describe("Y offset to move (default: 0)"),
      dz: z.coerce.number().describe("Z offset to move"),
      range: z.coerce.number().optional().describe("How close to get to the target (default: 1)"),
      timeoutMs: z.number().int().min(50).optional().describe("Timeout in milliseconds before cancelling (min: 50, default: no timeout)")
    },
    async ({ dx, dy = 0, dz, range = 1, timeoutMs }: { dx: number; dy?: number; dz: number; range?: number; timeoutMs?: number }) => {
      checkInterrupt();
      const bot = getBot();
      const current = bot.entity.position;
      const tx = Math.floor(current.x) + dx;
      const ty = Math.floor(current.y) + dy;
      const tz = Math.floor(current.z) + dz;
      const pos = await gotoNear(bot, tx, ty, tz, range, timeoutMs);
      return factory.createResponse(`Moved to near (${tx}, ${ty}, ${tz}); now at (${pos.x}, ${pos.y}, ${pos.z})`);
    }
  );

  factory.registerTool(
    "move-toward-bearing",
    "Move the bot a distance in a compass direction (n/ne/e/se/s/sw/w/nw)",
    {
      heading: z.enum(['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']).describe("Compass heading to walk"),
      distance: z.coerce.number().positive().describe("Distance in blocks to walk"),
      timeoutMs: z.number().int().min(50).optional().describe("Timeout in milliseconds before cancelling (min: 50, default: no timeout)")
    },
    async ({ heading, distance, timeoutMs }: { heading: Heading; distance: number; timeoutMs?: number }) => {
      const bot = getBot();
      const current = bot.entity.position;
      const { dz, dx } = HEADING_OFFSETS[heading];
      const tx = Math.floor(current.x) + dx * distance;
      const ty = Math.floor(current.y);
      const tz = Math.floor(current.z) + dz * distance;
      const pos = await gotoNear(bot, tx, ty, tz, 2, timeoutMs);
      return factory.createResponse(`Moved ${distance} blocks ${heading}; now at (${pos.x}, ${pos.y}, ${pos.z})`);
    }
  );

  factory.registerTool(
    "goto-entity",
    "Follow the nearest entity of a specific type (e.g. player, mob, zombie)",
    {
      entityType: z.string().describe("Type of entity to follow"),
      timeoutMs: z.number().int().min(50).optional().describe("Timeout in milliseconds before cancelling (default: 15000)")
    },
    async ({ entityType, timeoutMs = 15000 }: { entityType: string; timeoutMs?: number }) => {
      checkInterrupt();
      const bot = getBot();
      const type = entityType.toLowerCase();
      const entity = bot.nearestEntity((e) => {
        if (type === 'player') return e.type === 'player';
        if (type === 'mob') return e.type === 'mob';
        return Boolean(e.name && e.name.includes(type));
      });

      if (!entity) {
        return factory.createErrorResponse(`No entity matching "${entityType}" found`);
      }

      const goal = new goals.GoalFollow(entity, 1);
      bot.pathfinder.setGoal(goal, true);

      const entityName = entity.name || (entity as { username?: string }).username || entity.type;
      const deadline = Date.now() + timeoutMs;

      while (true) {
        const dist = bot.entity.position.distanceTo(entity.position);
        if (dist <= 1.5) {
          break;
        }
        if (Date.now() >= deadline) {
          bot.pathfinder.stop();
          const pos = bot.entity.position;
          return factory.createErrorResponse(`Timed out following ${entityName} after ${timeoutMs}ms. Current position: (${pos.x}, ${pos.y}, ${pos.z}), target at (${entity.position.x}, ${entity.position.y}, ${entity.position.z})`);
        }
        await sleep(200);
      }

      const pos = bot.entity.position;
      return factory.createResponse(`Following ${entityName}; now at (${pos.x}, ${pos.y}, ${pos.z}), target at (${entity.position.x}, ${entity.position.y}, ${entity.position.z})`);
    }
  );

  factory.registerTool(
    "save-location",
    "Save a named landmark location for later navigation",
    {
      name: z.string().describe("Name of the location"),
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate")
    },
    async ({ name, x, y, z }: { name: string; x: number; y: number; z: number }) => {
      waypoints.set(name, { x, y, z });
      return factory.createResponse(`Saved ${name} at (${x}, ${y}, ${z})`);
    }
  );

  factory.registerTool(
    "goto-named",
    "Move to a previously saved named location",
    {
      name: z.string().describe("Name of the saved location"),
      range: z.coerce.number().optional().describe("How close to get to the target (default: 2)"),
      timeoutMs: z.number().int().min(50).optional().describe("Timeout in milliseconds before cancelling (min: 50, default: no timeout)")
    },
    async ({ name, range = 2, timeoutMs }: { name: string; range?: number; timeoutMs?: number }) => {
      checkInterrupt();
      const wp = waypoints.get(name);
      if (!wp) {
        throw new Error(`No saved location named ${name}`);
      }
      const bot = getBot();
      const pos = await gotoNear(bot, wp.x, wp.y, wp.z, range, timeoutMs);
      return factory.createResponse(`Moved to ${name} at (${wp.x}, ${wp.y}, ${wp.z}); now at (${pos.x}, ${pos.y}, ${pos.z})`);
    }
  );

  factory.registerTool(
    "list-locations",
    "List all saved named locations",
    {},
    async () => {
      if (waypoints.size === 0) {
        return factory.createResponse("No saved locations");
      }
      const lines = Array.from(waypoints.entries()).map(([name, wp]) => `${name}: (${wp.x}, ${wp.y}, ${wp.z})`);
      return factory.createResponse(lines.join('\n'));
    }
  );
}

import { z } from "zod";
import mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';

const MAX_BUILD_VOLUME = 216;
const MAX_OBSTRUCTIONS_REPORTED = 5;

const AIR_BLOCKS = new Set(['air', 'cave_air', 'void_air']);
const UNSAFE_BASE_BLOCKS = new Set(['water', 'lava', 'flowing_water', 'flowing_lava']);

const CARDINALS = ['S', 'SW', 'W', 'NW', 'N', 'NE', 'E', 'SE'] as const;

function cardinalFromYaw(yaw: number): string {
  const deg = (((-yaw * 180) / Math.PI) % 360 + 360) % 360;
  const index = Math.round(deg / 45) % 8;
  return CARDINALS[index];
}

function isAir(name?: string): boolean {
  return name !== undefined && AIR_BLOCKS.has(name);
}

function isUnsafeBase(name?: string): boolean {
  return name !== undefined && UNSAFE_BASE_BLOCKS.has(name);
}

function safeBlockAt(bot: mineflayer.Bot, pos: Vec3): { name?: string } | undefined {
  try {
    return bot.blockAt(pos) ?? undefined;
  } catch {
    return undefined;
  }
}

function raycastAhead(
  bot: mineflayer.Bot,
  origin: Vec3,
  direction: Vec3,
  range: number
): { x: number; y: number; z: number } | null {
  const world = (bot as { world?: { raycast?: (from: Vec3, dir: Vec3, range: number) => unknown } }).world;
  if (!world || typeof world.raycast !== 'function') return null;
  const hit = world.raycast(origin, direction, range) as { x?: number; y?: number; z?: number } | null;
  if (!hit || typeof hit.x !== 'number' || typeof hit.y !== 'number' || typeof hit.z !== 'number') return null;
  return { x: hit.x, y: hit.y, z: hit.z };
}

export function registerPerceptionTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "look-ahead",
    "Cast a ray in the direction the bot is facing and report the first block in the way. See what is ahead before moving or building.",
    {
      distance: z.coerce.number().optional().describe("Maximum distance to look ahead in blocks (default: 16)")
    },
    async ({ distance = 16 }: { distance?: number }) => {
      const bot = getBot();
      const range = Math.max(1, Math.floor(distance));

      const entity = bot.entity;
      const origin = entity?.position;
      if (!origin || typeof origin.x !== 'number') {
        return factory.createResponse('Looking: no bot position available');
      }

      const yaw = entity && typeof entity.yaw === 'number' ? entity.yaw : 0;
      const pitch = entity && typeof entity.pitch === 'number' ? entity.pitch : 0;
      const facing = cardinalFromYaw(yaw);
      const direction = new Vec3(
        -Math.sin(yaw) * Math.cos(pitch),
        -Math.sin(pitch),
        -Math.cos(yaw) * Math.cos(pitch)
      ).normalize();

      const ox = Math.floor(origin.x);
      const oy = Math.floor(origin.y);
      const oz = Math.floor(origin.z);

      let raycastWorked = false;
      let hit: { x: number; y: number; z: number } | null = null;
      try {
        hit = raycastAhead(bot, origin, direction, range);
        raycastWorked = true;
      } catch {
        raycastWorked = false;
      }

      if (raycastWorked) {
        if (hit) {
          const bx = Math.floor(hit.x);
          const by = Math.floor(hit.y);
          const bz = Math.floor(hit.z);
          const name = safeBlockAt(bot, new Vec3(bx, by, bz))?.name ?? 'unknown';
          const dist = origin.distanceTo(new Vec3(bx + 0.5, by + 0.5, bz + 0.5));
          return factory.createResponse(
            `Looking ${facing} from (${ox},${oy},${oz}): first block ${name} at (${bx},${by},${bz}), ${dist.toFixed(1)} blocks ahead`
          );
        }
        return factory.createResponse(`No block within ${range} blocks`);
      }

      // Raycast unavailable — sample blocks every 2 blocks along the ray instead.
      for (let d = 2; d <= range; d += 2) {
        const sample = origin.plus(direction.scaled(d)).floored();
        const block = safeBlockAt(bot, sample);
        if (block && block.name && !isAir(block.name)) {
          const dist = origin.distanceTo(sample.offset(0.5, 0.5, 0.5));
          return factory.createResponse(
            `Looking ${facing} from (${ox},${oy},${oz}): first block ${block.name} at (${sample.x},${sample.y},${sample.z}), ${dist.toFixed(1)} blocks ahead`
          );
        }
      }

      return factory.createResponse(`No block within ${range} blocks`);
    }
  );

  factory.registerTool(
    "path-status",
    "Check the reachability of a target position before committing to moving toward it. Advisory — reports voids, falls and unsafe ground.",
    {
      x: z.coerce.number().describe("Target X coordinate"),
      y: z.coerce.number().describe("Target Y coordinate"),
      z: z.coerce.number().describe("Target Z coordinate"),
      range: z.coerce.number().optional().describe("Vertical range below the target to check for ground (default: 2)")
    },
    async ({ x, y, z, range = 2 }: { x: number, y: number, z: number, range?: number }) => {
      const bot = getBot();
      const tx = Math.floor(x);
      const ty = Math.floor(y);
      const tz = Math.floor(z);
      const lookRange = Math.max(1, Math.floor(range));

      if (ty < -64) {
        return factory.createResponse('Unreachable: below world floor (void)');
      }
      if (ty > 320) {
        return factory.createResponse('Unreachable: above world height');
      }

      const target = safeBlockAt(bot, new Vec3(tx, ty, tz));
      const below = safeBlockAt(bot, new Vec3(tx, ty - 1, tz));

      // Target is in open air with nothing solid within `range` blocks below it.
      if (target && isAir(target.name) && below && isAir(below.name)) {
        let clearBelow = true;
        for (let dy = ty - 1; dy >= ty - lookRange; dy--) {
          const b = safeBlockAt(bot, new Vec3(tx, dy, tz));
          if (!b || !isAir(b.name)) {
            clearBelow = false;
            break;
          }
        }
        if (clearBelow) {
          return factory.createResponse('Unreachable: target is in open air / would fall');
        }
      }

      // Walkability of the ground directly under the target.
      if (below && isAir(below.name)) {
        return factory.createResponse('Caution: no ground under target (will fall)');
      }
      if (below && isUnsafeBase(below.name)) {
        return factory.createResponse(`Caution: ground at target is ${below.name}`);
      }

      return factory.createResponse(`Target (${tx},${ty},${tz}): reachable (likely)`);
    }
  );

  factory.registerTool(
    "check-build-site",
    "Validate that a volume is clear and buildable before building: checks ground under the base layer and scans the interior for obstructions. Max 216 blocks (6x6x6).",
    {
      x1: z.coerce.number().describe("X coordinate of first corner"),
      y1: z.coerce.number().describe("Y coordinate of first corner (base layer)"),
      z1: z.coerce.number().describe("Z coordinate of first corner"),
      x2: z.coerce.number().describe("X coordinate of second corner"),
      y2: z.coerce.number().describe("Y coordinate of second corner"),
      z2: z.coerce.number().describe("Z coordinate of second corner")
    },
    async ({ x1, y1, z1, x2, y2, z2 }: { x1: number, y1: number, z1: number, x2: number, y2: number, z2: number }) => {
      const bot = getBot();

      const [minX, maxX] = [Math.floor(x1), Math.floor(x2)].sort((a, b) => a - b);
      const [minY, maxY] = [Math.floor(y1), Math.floor(y2)].sort((a, b) => a - b);
      const [minZ, maxZ] = [Math.floor(z1), Math.floor(z2)].sort((a, b) => a - b);

      const countX = maxX - minX + 1;
      const countY = maxY - minY + 1;
      const countZ = maxZ - minZ + 1;
      const volume = countX * countY * countZ;

      if (volume > MAX_BUILD_VOLUME) {
        return factory.createErrorResponse("check-build-site too large (max 216). Narrow the volume.");
      }

      const baseIssues: string[] = [];
      const obstructions: string[] = [];

      // Base layer: the ground the build will sit on (y = minY - 1).
      for (let x = minX; x <= maxX; x++) {
        for (let z = minZ; z <= maxZ; z++) {
          const ground = safeBlockAt(bot, new Vec3(x, minY - 1, z));
          if (!ground) continue;
          if (isAir(ground.name)) {
            baseIssues.push(`no ground at (${x},${minY - 1},${z})`);
          } else if (isUnsafeBase(ground.name)) {
            baseIssues.push(`unsafe base at (${x},${minY - 1},${z}): ${ground.name}`);
          }
        }
      }

      // Interior volume (minY..maxY): non-air blocks that would obstruct the build.
      for (let y = minY; y <= maxY && obstructions.length < MAX_OBSTRUCTIONS_REPORTED; y++) {
        for (let x = minX; x <= maxX && obstructions.length < MAX_OBSTRUCTIONS_REPORTED; x++) {
          for (let z = minZ; z <= maxZ && obstructions.length < MAX_OBSTRUCTIONS_REPORTED; z++) {
            const block = safeBlockAt(bot, new Vec3(x, y, z));
            if (block && block.name && !isAir(block.name)) {
              obstructions.push(`obstruction at (${x},${y},${z}): ${block.name}`);
            }
          }
        }
      }

      if (baseIssues.length === 0 && obstructions.length === 0) {
        return factory.createResponse('Build site clear');
      }

      const lines = [
        `Build site (${countX} x ${countZ} x ${countY}): ${volume} blocks. Base: ${baseIssues.length} issue(s). Interior: ${obstructions.length} obstruction(s).`,
        ...baseIssues.map((issue) => `- ${issue}`),
        ...obstructions.map((issue) => `- ${issue}`)
      ];

      return factory.createResponse(lines.join('\n'));
    }
  );
}

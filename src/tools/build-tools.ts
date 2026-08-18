import { z } from "zod";
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';

type FaceDirection = 'up' | 'down' | 'north' | 'south' | 'east' | 'west';

const FACE_OPTIONS: { direction: FaceDirection; vector: Vec3 }[] = [
  { direction: 'down', vector: new Vec3(0, -1, 0) },
  { direction: 'north', vector: new Vec3(0, 0, -1) },
  { direction: 'south', vector: new Vec3(0, 0, 1) },
  { direction: 'east', vector: new Vec3(1, 0, 0) },
  { direction: 'west', vector: new Vec3(-1, 0, 0) },
  { direction: 'up', vector: new Vec3(0, 1, 0) }
];

const MAX_FILL_VOLUME = 216;

interface PlaceResult {
  ok: boolean;
  reason?: string;
}

async function placeAt(bot: mineflayer.Bot, pos: Vec3, face?: FaceDirection): Promise<PlaceResult> {
  const placePos = pos.floored();
  const botPos = bot.entity.position.floored();

  if (placePos.equals(botPos) || placePos.equals(botPos.offset(0, 1, 0))) {
    return { ok: false, reason: "can't place a block where the bot stands or one block above" };
  }

  const blockAtPos = bot.blockAt(placePos);
  if (blockAtPos && blockAtPos.name !== 'air') {
    return { ok: false, reason: `already a block (${blockAtPos.name}) there` };
  }

  const possibleFaces = [...FACE_OPTIONS];
  if (face !== undefined && face !== 'down') {
    const specificFace = possibleFaces.find(f => f.direction === face);
    if (specificFace) {
      possibleFaces.unshift(possibleFaces.splice(possibleFaces.indexOf(specificFace), 1)[0]);
    }
  }

  for (const candidate of possibleFaces) {
    const referencePos = placePos.plus(candidate.vector);
    const referenceBlock = bot.blockAt(referencePos);

    if (referenceBlock && referenceBlock.name !== 'air') {
      if (!bot.canSeeBlock(referenceBlock)) {
        const goal = new goals.GoalNear(referencePos.x, referencePos.y, referencePos.z, 2);
        await bot.pathfinder.goto(goal);
      }

      await bot.lookAt(placePos, true);

      try {
        await bot.placeBlock(referenceBlock, candidate.vector.scaled(-1));
        const placedBlock = bot.blockAt(placePos);
        if (!placedBlock || placedBlock.name === 'air') {
          return { ok: false, reason: 'placement failed — block not present after placing' };
        }
        return { ok: true };
      } catch {
        continue;
      }
    }
  }

  return { ok: false, reason: 'no suitable reference block found' };
}

export function registerBuildTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "place-blocks",
    "Place up to 64 blocks in a single call. Each entry is an absolute position with an optional placement face.",
    {
      blocks: z.array(z.object({
        x: z.coerce.number().describe("X coordinate"),
        y: z.coerce.number().describe("Y coordinate"),
        z: z.coerce.number().describe("Z coordinate"),
        face: z.enum(['up', 'down', 'north', 'south', 'east', 'west']).optional().describe("Direction to place against (default: down)")
      })).min(1).max(64).describe("List of blocks to place")
    },
    async ({ blocks }: { blocks: { x: number, y: number, z: number, face?: FaceDirection }[] }) => {
      const bot = getBot();
      let placed = 0;
      const failures: string[] = [];

      for (const entry of blocks) {
        const pos = new Vec3(entry.x, entry.y, entry.z).floored();
        const result = await placeAt(bot, pos, entry.face);
        if (result.ok) {
          placed++;
        } else {
          failures.push(`couldn't place (${pos.x},${pos.y},${pos.z}): ${result.reason}`);
        }
      }

      const failureText = failures.length > 0 ? `: ${failures.join('; ')}` : '';
      return factory.createResponse(`Placed ${placed} block(s); failed ${failures.length}${failureText}`);
    }
  );

  factory.registerTool(
    "fill-area",
    "Fill a cuboid volume with a block type (max 216 blocks). Skips the bot's own position and cells already filled.",
    {
      x1: z.coerce.number().describe("X coordinate of first corner"),
      y1: z.coerce.number().describe("Y coordinate of first corner"),
      z1: z.coerce.number().describe("Z coordinate of first corner"),
      x2: z.coerce.number().describe("X coordinate of second corner"),
      y2: z.coerce.number().describe("Y coordinate of second corner"),
      z2: z.coerce.number().describe("Z coordinate of second corner"),
      blockType: z.string().describe("Block type to fill the volume with")
    },
    async ({ x1, y1, z1, x2, y2, z2, blockType }: { x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, blockType: string }) => {
      const bot = getBot();

      const [minX, maxX] = [Math.floor(x1), Math.floor(x2)].sort((a, b) => a - b);
      const [minY, maxY] = [Math.floor(y1), Math.floor(y2)].sort((a, b) => a - b);
      const [minZ, maxZ] = [Math.floor(z1), Math.floor(z2)].sort((a, b) => a - b);

      const volume = (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1);
      if (volume > MAX_FILL_VOLUME) {
        return factory.createErrorResponse("fill-area too large (max 216). Narrow the volume.");
      }

      const botPos = bot.entity.position.floored();
      let filled = 0;
      const failures: string[] = [];

      for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
          for (let z = minZ; z <= maxZ; z++) {
            const pos = new Vec3(x, y, z);
            if (pos.equals(botPos) || pos.equals(botPos.offset(0, 1, 0))) {
              continue;
            }
            const current = bot.blockAt(pos);
            if (current && current.name === blockType) {
              continue;
            }
            const result = await placeAt(bot, pos);
            if (result.ok) {
              filled++;
            } else {
              failures.push(`couldn't place (${x},${y},${z}): ${result.reason}`);
            }
          }
        }
      }

      const failureText = failures.length > 0 ? `; failed ${failures.length}: ${failures.join('; ')}` : '';
      return factory.createResponse(`Filled ${filled} block(s) with ${blockType}${failureText}`);
    }
  );

  factory.registerTool(
    "place-relative",
    "Place up to 64 blocks at offsets relative to the bot's current position. Lets the agent think in offsets, not absolute coords.",
    {
      offsets: z.array(z.object({
        dx: z.coerce.number().describe("Offset along X from the bot's position"),
        dy: z.coerce.number().describe("Offset along Y from the bot's position"),
        dz: z.coerce.number().describe("Offset along Z from the bot's position"),
        face: z.enum(['up', 'down', 'north', 'south', 'east', 'west']).optional().describe("Direction to place against (default: down)")
      })).min(1).max(64).describe("List of offsets to place at")
    },
    async ({ offsets }: { offsets: { dx: number, dy: number, dz: number, face?: FaceDirection }[] }) => {
      const bot = getBot();
      const botPos = bot.entity.position.floored();
      let placed = 0;
      const failures: string[] = [];

      for (const entry of offsets) {
        const pos = new Vec3(botPos.x + entry.dx, botPos.y + entry.dy, botPos.z + entry.dz).floored();
        const result = await placeAt(bot, pos, entry.face);
        if (result.ok) {
          placed++;
        } else {
          failures.push(`couldn't place (${pos.x},${pos.y},${pos.z}): ${result.reason}`);
        }
      }

      const failureText = failures.length > 0 ? `: ${failures.join('; ')}` : '';
      return factory.createResponse(`Placed ${placed} block(s); failed ${failures.length}${failureText}`);
    }
  );
}

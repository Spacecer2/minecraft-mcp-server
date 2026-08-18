import { z } from "zod";
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';

const MAX_INSPECT_VOLUME = 512;
const MAX_ISSUES_LISTED = 10;
const MAX_LIGHTS = 16;

type FaceDirection = 'up' | 'down' | 'north' | 'south' | 'east' | 'west';

const FACE_OPTIONS: { direction: FaceDirection; vector: Vec3 }[] = [
  { direction: 'down', vector: new Vec3(0, -1, 0) },
  { direction: 'north', vector: new Vec3(0, 0, -1) },
  { direction: 'south', vector: new Vec3(0, 0, 1) },
  { direction: 'east', vector: new Vec3(1, 0, 0) },
  { direction: 'west', vector: new Vec3(-1, 0, 0) },
  { direction: 'up', vector: new Vec3(0, 1, 0) }
];

interface PlaceResult {
  ok: boolean;
  reason?: string;
}

function isAirName(name: string | undefined): boolean {
  return name === undefined || name === 'air' || name === 'unknown';
}

function isSolidName(name: string | undefined): boolean {
  return !isAirName(name);
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

export function registerQATools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "inspect-build",
    "Analyze a finished build volume and report quality issues the agent can fix: material histogram, floating blocks (non-air block with air below), and interior gaps (air with non-air above and below). Max 512 blocks (8x8x8).",
    {
      x1: z.coerce.number().describe("X coordinate of first corner"),
      y1: z.coerce.number().describe("Y coordinate of first corner"),
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

      if (volume > MAX_INSPECT_VOLUME) {
        return factory.createErrorResponse("inspect-build too large (max 512). Narrow the volume.");
      }

      const histogram = new Map<string, number>();
      let nonAir = 0;
      const floating: { pos: Vec3; name: string }[] = [];
      const gaps: Vec3[] = [];

      for (let y = minY; y <= maxY; y++) {
        for (let z = minZ; z <= maxZ; z++) {
          for (let x = minX; x <= maxX; x++) {
            const pos = new Vec3(x, y, z);
            const name = bot.blockAt(pos)?.name ?? 'unknown';
            histogram.set(name, (histogram.get(name) ?? 0) + 1);

            if (isAirName(name)) {
              const aboveName = bot.blockAt(pos.offset(0, 1, 0))?.name;
              const belowName = bot.blockAt(pos.offset(0, -1, 0))?.name;
              if (isSolidName(aboveName) && isSolidName(belowName) && gaps.length < MAX_ISSUES_LISTED) {
                gaps.push(pos);
              }
              continue;
            }

            nonAir++;
            const belowName = bot.blockAt(pos.offset(0, -1, 0))?.name;
            if (isAirName(belowName) && floating.length < MAX_ISSUES_LISTED) {
              floating.push({ pos, name });
            }
          }
        }
      }

      const materials = [...histogram.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([name, count]) => `- ${name}: ${count}`);

      let msg = `Build volume (${countX} x ${countZ} x ${countY}): ${volume} cells, ${nonAir} non-air.\nMaterials:\n${materials.join('\n')}`;

      if (floating.length === 0 && gaps.length === 0) {
        msg += '\nNo issues found.';
        return factory.createResponse(msg);
      }

      msg += `\nIssues:\n- ${floating.length} floating block(s), ${gaps.length} gap(s)`;
      for (const { pos, name } of floating) {
        msg += `\n- floating at (${pos.x},${pos.y},${pos.z}): ${name}`;
      }
      for (const pos of gaps) {
        msg += `\n- gap at (${pos.x},${pos.y},${pos.z})`;
      }

      return factory.createResponse(msg);
    }
  );

  factory.registerTool(
    "secure-perimeter",
    "Place light sources (torches/lanterns) around the bot to prevent mob spawns: a ring around the perimeter plus a few in the middle, at floor level. Bounded to a maximum of 16 lights.",
    {
      radius: z.coerce.number().optional().describe("Radius of the perimeter ring (default: 8)"),
      blockType: z.string().optional().describe("Block type to place (default: torch)")
    },
    async ({ radius = 8, blockType = 'torch' }: { radius?: number, blockType?: string }) => {
      const bot = getBot();
      const center = bot.entity.position.floored();
      const floorY = center.y;

      const r = Math.max(1, Math.floor(radius));
      const perimeterCount = Math.min(14, Math.max(4, Math.round((2 * Math.PI * r) / 8)));
      const middleCount = Math.min(2, MAX_LIGHTS - perimeterCount);

      const targets: Vec3[] = [];
      for (let i = 0; i < perimeterCount; i++) {
        const angle = (2 * Math.PI * i) / perimeterCount;
        targets.push(new Vec3(
          Math.round(center.x + Math.cos(angle) * r),
          floorY,
          Math.round(center.z + Math.sin(angle) * r)
        ).floored());
      }
      const middleStep = Math.max(1, Math.floor(r / 3));
      for (let i = 0; i < middleCount; i++) {
        targets.push(new Vec3(center.x + (i + 1) * middleStep, floorY, center.z).floored());
      }

      let placed = 0;
      let failed = 0;
      const failures: string[] = [];

      for (const target of targets) {
        let result: PlaceResult;
        try {
          const base = bot.findBlock({
            matching: (b: { name: string }) => b.name !== 'air',
            maxDistance: Math.max(8, r + 2)
          });
          if (base) {
            result = await placeAt(bot, target, 'down');
          } else {
            result = await placeAt(bot, target);
          }
        } catch {
          result = await placeAt(bot, target);
        }

        if (result.ok) {
          placed++;
        } else {
          failed++;
          failures.push(`couldn't place (${target.x},${target.y},${target.z}): ${result.reason}`);
        }
      }

      let msg = `Secured perimeter: placed ${placed} ${blockType}.`;
      if (failures.length > 0) {
        msg += `\nFailed ${failed}: ${failures.join('; ')}`;
      }
      return factory.createResponse(msg);
    }
  );
}
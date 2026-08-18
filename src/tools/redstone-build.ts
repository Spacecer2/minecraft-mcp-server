import { z } from "zod";
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';

type FaceDirection = 'up' | 'down' | 'north' | 'south' | 'east' | 'west';
type Orientation = 'north' | 'south' | 'east' | 'west';
type RedstoneType = 'door' | 'lamp' | 'trap' | 'piston' | 'rsswitch' | 'auto-farm';

const FACE_OPTIONS: { direction: FaceDirection; vector: Vec3 }[] = [
  { direction: 'down', vector: new Vec3(0, -1, 0) },
  { direction: 'north', vector: new Vec3(0, 0, -1) },
  { direction: 'south', vector: new Vec3(0, 0, 1) },
  { direction: 'east', vector: new Vec3(1, 0, 0) },
  { direction: 'west', vector: new Vec3(-1, 0, 0) },
  { direction: 'up', vector: new Vec3(0, 1, 0) }
];

const DIRECTION_VECTORS: Record<Orientation, Vec3> = {
  north: new Vec3(0, 0, -1),
  south: new Vec3(0, 0, 1),
  east: new Vec3(1, 0, 0),
  west: new Vec3(-1, 0, 0)
};

interface PlaceResult {
  ok: boolean;
  reason?: string;
}

interface PlaceSpec {
  pos: Vec3;
  blockType: string;
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

function placementsFor(type: RedstoneType, x: number, y: number, z: number, orientation?: Orientation): PlaceSpec[] {
  const anchor = new Vec3(x, y, z).floored();
  switch (type) {
    case 'lamp':
      return [
        { pos: anchor, blockType: 'redstone_lamp' },
        { pos: anchor.offset(1, 0, 0), blockType: 'lever' },
        { pos: anchor.offset(0, -1, 0), blockType: 'redstone_dust' },
        { pos: anchor.offset(1, -1, 0), blockType: 'redstone_dust' }
      ];
    case 'door': {
      const dir = DIRECTION_VECTORS[orientation ?? 'north'];
      return [
        { pos: anchor, blockType: 'pressure_plate' },
        { pos: anchor.plus(dir), blockType: 'redstone_dust' },
        { pos: anchor.plus(dir.scaled(2)), blockType: 'redstone_dust' },
        { pos: anchor.plus(dir.scaled(3)), blockType: 'redstone_dust' }
      ];
    }
    case 'piston':
      return [
        { pos: anchor, blockType: 'sticky_piston' },
        { pos: anchor.offset(1, 0, 0), blockType: 'redstone_dust' },
        { pos: anchor.offset(2, 0, 0), blockType: 'lever' }
      ];
    case 'trap':
    case 'rsswitch':
    case 'auto-farm':
      return [{ pos: anchor, blockType: 'redstone_block' }];
  }
}

function summaryFor(type: RedstoneType, x: number, y: number, z: number, orientation?: Orientation): string {
  switch (type) {
    case 'lamp':
      return 'redstone lamp with a lever beside it and redstone dust in a trench underneath';
    case 'door': {
      const dir = DIRECTION_VECTORS[orientation ?? 'north'];
      const doorPos = new Vec3(x, y, z).plus(dir.scaled(2));
      return `pressure plate + redstone trench placed; place the door at (${doorPos.x},${doorPos.y},${doorPos.z}).`;
    }
    case 'piston':
      return 'sticky piston facing up with redstone dust behind it and a lever at the end';
    case 'trap':
      return 'marker redstone block placed; use redstone-layout for the full tripwire trap wiring from this anchor';
    case 'rsswitch':
      return 'marker redstone block placed; use redstone-layout for the RS-NOR latch wiring from this anchor';
    case 'auto-farm':
      return 'marker redstone block placed; use redstone-layout for the auto-farm wiring from this anchor';
  }
}

export function registerRedstoneBuildTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "place-redstone",
    "Place a simple redstone starter circuit at an anchor position. 'lamp' places a lamp + lever + dust trench, 'door' places a pressure plate + dust trail toward the door opening, 'piston' places a sticky piston + dust + lever, and 'trap'/'rsswitch'/'auto-farm' place a marker block and point at redstone-layout for the full wiring.",
    {
      type: z.enum(['door', 'lamp', 'trap', 'piston', 'rsswitch', 'auto-farm']).describe("Which redstone build to start"),
      x: z.coerce.number().describe("X coordinate of the anchor"),
      y: z.coerce.number().describe("Y coordinate of the anchor"),
      z: z.coerce.number().describe("Z coordinate of the anchor"),
      orientation: z.enum(['north', 'south', 'east', 'west']).optional().describe("Which way the circuit faces (default: south)")
    },
    async ({ type, x, y, z, orientation = 'south' }: { type: RedstoneType, x: number, y: number, z: number, orientation?: Orientation }) => {
      const bot = getBot();
      const placements = placementsFor(type, x, y, z, orientation);

      let placed = 0;
      const failures: string[] = [];

      for (const spec of placements) {
        const result = await placeAt(bot, spec.pos);
        if (result.ok) {
          placed++;
        } else {
          failures.push(`couldn't place (${spec.pos.x},${spec.pos.y},${spec.pos.z}): ${result.reason}`);
        }
      }

      const summary = summaryFor(type, x, y, z, orientation);
      let msg = `Placed ${type} redstone starter at (${x},${y},${z}): ${summary}`;
      if (failures.length > 0) {
        msg += `\n${placed} placed, ${failures.length} failed: ${failures.join('; ')}`;
      } else {
        msg += `\n${placed} placed, 0 failed.`;
      }
      return factory.createResponse(msg);
    }
  );
}
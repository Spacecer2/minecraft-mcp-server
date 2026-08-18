import { z } from "zod";
import mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { ToolFactory } from '../tool-factory.js';

type Landmark = {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  type: string;
  dimension: string;
  discoveredAt: number;
};

const worldMap = new Map<string, Landmark>();
let lastLandmarkId = 0;

const MAX_EXPLORE_PROBES = 400;

const FUNCTIONAL_BLOCKS = new Set([
  'chest', 'crafting_table', 'furnace', 'torch', 'water', 'lava',
  'flowing_water', 'flowing_lava'
]);

const ORE_TYPES = [
  'coal', 'iron', 'gold', 'diamond', 'redstone', 'lapis', 'emerald', 'copper'
];

function buildDefaultNotable(): Set<string> {
  const set = new Set(FUNCTIONAL_BLOCKS);
  for (const ore of ORE_TYPES) {
    set.add(`${ore}_ore`);
    set.add(`deepslate_${ore}_ore`);
  }
  return set;
}

const DEFAULT_NOTABLE = buildDefaultNotable();
const STRUCTURE_KEYWORDS = ['village', 'temple', 'ruin', 'shipwreck'];

function dimensionOf(bot: mineflayer.Bot): string {
  return bot.game?.dimension ?? 'unknown';
}

function distance3d(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number
): number {
  return Math.hypot(ax - bx, ay - by, az - bz);
}

function landmarkNear(lm: Landmark, x: number, y: number, z: number, tolerance = 2): boolean {
  return Math.abs(lm.x - x) <= tolerance
    && Math.abs(lm.y - y) <= tolerance
    && Math.abs(lm.z - z) <= tolerance;
}

function addLandmark(
  name: string,
  x: number,
  y: number,
  z: number,
  type: string,
  dimension: string
): boolean {
  for (const lm of worldMap.values()) {
    if (lm.type === type && landmarkNear(lm, x, y, z)) {
      return false;
    }
  }
  const id = `landmark-${++lastLandmarkId}`;
  worldMap.set(id, {
    id,
    name,
    x: Math.round(x),
    y: Math.round(y),
    z: Math.round(z),
    type,
    dimension,
    discoveredAt: Date.now()
  });
  return true;
}

function classifyBlock(name: string, notable: Set<string>): string | undefined {
  if (notable.has(name)) return name;
  for (const keyword of STRUCTURE_KEYWORDS) {
    if (name.includes(keyword)) return keyword;
  }
  return undefined;
}

export function registerMapTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "map-mark",
    "Record a discovered landmark (village, cave, chest, etc.) in the persistent world map",
    {
      name: z.string().describe("Landmark name"),
      x: z.coerce.number().optional().describe("X coordinate (defaults to the bot's current position)"),
      y: z.coerce.number().optional().describe("Y coordinate (defaults to the bot's current position)"),
      z: z.coerce.number().optional().describe("Z coordinate (defaults to the bot's current position)"),
      type: z.string().optional().describe("Landmark type (e.g. village, cave, chest)")
    },
    async ({ name, x, y, z, type }) => {
      const bot = getBot();
      const pos = bot.entity?.position;
      const lx = x ?? (pos ? pos.x : 0);
      const ly = y ?? (pos ? pos.y : 0);
      const lz = z ?? (pos ? pos.z : 0);
      addLandmark(name, lx, ly, lz, type ?? 'mark', dimensionOf(bot));
      const typeSuffix = type ? ` [${type}]` : '';
      return factory.createResponse(`Marked ${name} at (${Math.round(lx)}, ${Math.round(ly)}, ${Math.round(lz)})${typeSuffix}.`);
    }
  );

  factory.registerTool(
    "map-list",
    "List all landmarks in the world map, optionally filtered by type",
    {
      type: z.string().optional().describe("Only show landmarks of this type")
    },
    async ({ type }) => {
      let list = Array.from(worldMap.values());
      if (type) list = list.filter((lm) => lm.type === type);
      if (list.length === 0) {
        return factory.createResponse("Map empty");
      }
      list.sort((a, b) => a.discoveredAt - b.discoveredAt);
      const lines = list.map((lm) =>
        `- ${lm.name} (${lm.type}) at (${lm.x},${lm.y},${lm.z}) [${lm.dimension}]`
      );
      return factory.createResponse(lines.join('\n'));
    }
  );

  factory.registerTool(
    "map-clear",
    "Clear all landmarks from the world map",
    {},
    async () => {
      const count = worldMap.size;
      worldMap.clear();
      return factory.createResponse(`Map cleared (${count} landmark${count === 1 ? '' : 's'} removed).`);
    }
  );

  factory.registerTool(
    "map-nearby",
    "List landmarks within a radius of the bot's current position, sorted by distance",
    {
      radius: z.coerce.number().finite().optional().describe("Radius in blocks (default: 64)"),
      type: z.string().optional().describe("Only show landmarks of this type")
    },
    async ({ radius = 64, type }) => {
      const bot = getBot();
      const pos = bot.entity?.position;
      if (!pos) {
        return factory.createResponse("No position available");
      }
      let list = Array.from(worldMap.values());
      if (type) list = list.filter((lm) => lm.type === type);
      const nearby = list
        .map((lm) => ({ lm, distance: distance3d(lm.x, lm.y, lm.z, pos.x, pos.y, pos.z) }))
        .filter(({ distance }) => distance <= radius)
        .sort((a, b) => a.distance - b.distance);
      if (nearby.length === 0) {
        return factory.createResponse(`No landmarks within ${radius} blocks`);
      }
      const lines = nearby.map(({ lm, distance }) =>
        `- ${lm.name} at (${lm.x},${lm.y},${lm.z}), ${distance.toFixed(1)} blocks away`
      );
      return factory.createResponse(lines.join('\n'));
    }
  );

  factory.registerTool(
    "explore",
    "Sweep a circular area around the bot and record notable blocks (ores, chests, structures) as landmarks in the world map",
    {
      radius: z.coerce.number().finite().optional().describe("Sweep radius in blocks (default: 32)"),
      sectors: z.coerce.number().int().positive().optional().describe("Number of radial directions to sweep (default: 8)"),
      discover: z.array(z.string()).optional().describe("Additional block types to look for")
    },
    async ({ radius = 32, sectors = 8, discover = [] }) => {
      const bot = getBot();
      const origin = bot.entity?.position;
      if (!origin) {
        return factory.createResponse("No position available");
      }

      const dimension = dimensionOf(bot);
      addLandmark('explore-start', origin.x, origin.y, origin.z, 'start', dimension);

      const notable = new Set(DEFAULT_NOTABLE);
      for (const item of discover) {
        notable.add(item);
      }

      const probesPerSector = Math.max(1, Math.ceil(radius / 4));
      const effectiveSectors = Math.max(1, Math.min(sectors, Math.floor(MAX_EXPLORE_PROBES / probesPerSector)));
      const maxDistance = Math.max(4, radius);

      const discovered: string[] = [];

      for (let s = 0; s < effectiveSectors; s++) {
        const angle = (s / effectiveSectors) * 2 * Math.PI;
        const dirX = Math.cos(angle);
        const dirZ = Math.sin(angle);
        for (let d = 4; d <= maxDistance; d += 4) {
          const px = Math.floor(origin.x + dirX * d);
          const py = Math.floor(origin.y);
          const pz = Math.floor(origin.z + dirZ * d);
          let blockName: string | undefined;
          try {
            blockName = bot.blockAt(new Vec3(px, py, pz))?.name;
          } catch {
            blockName = undefined;
          }
          if (!blockName) continue;
          const type = classifyBlock(blockName, notable);
          if (!type) continue;
          if (addLandmark(blockName, px, py, pz, type, dimension)) {
            discovered.push(blockName);
          }
        }
      }

      if (typeof bot.findBlocks === 'function') {
        const mcData = minecraftData(bot.version);
        for (const blockType of notable) {
          const blockId = mcData.blocksByName[blockType]?.id;
          if (blockId === undefined) continue;
          let positions: Vec3[] = [];
          try {
            positions = bot.findBlocks({
              point: origin,
              matching: blockId,
              maxDistance,
              count: 10
            });
          } catch {
            positions = [];
          }
          for (const p of positions) {
            if (addLandmark(blockType, p.x, p.y, p.z, blockType, dimension)) {
              discovered.push(blockType);
            }
          }
        }

        for (const keyword of STRUCTURE_KEYWORDS) {
          const ids = Object.values(mcData.blocksByName)
            .filter((b) => b.name.includes(keyword))
            .map((b) => b.id);
          if (ids.length === 0) continue;
          let positions: Vec3[] = [];
          try {
            positions = bot.findBlocks({
              point: origin,
              matching: ids,
              maxDistance,
              count: 10
            });
          } catch {
            positions = [];
          }
          for (const p of positions) {
            if (addLandmark(keyword, p.x, p.y, p.z, keyword, dimension)) {
              discovered.push(keyword);
            }
          }
        }
      }

      if (discovered.length === 0) {
        return factory.createResponse(`Explored radius ${radius}: nothing new.`);
      }
      return factory.createResponse(
        `Explored radius ${radius}: discovered ${discovered.length} landmark(s): ${discovered.join(', ')}`
      );
    }
  );
}

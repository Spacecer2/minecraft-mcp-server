import { z } from "zod";
import mineflayer from 'mineflayer';
import type { Item } from 'prismarine-item';
import type { Block } from 'prismarine-block';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { ToolFactory } from '../tool-factory.js';
import { log } from '../logger.js';
import { coerceCoordinates } from './coordinate-utils.js';
import { resolveItem, formatAmbiguousMatch } from './inventory-tools.js';

const CROP_BLOCKS: Record<string, string> = {
  wheat: 'wheat',
  wheat_seeds: 'wheat',
  seeds: 'wheat',
  carrots: 'carrots',
  potatoes: 'potatoes',
  beetroot: 'beetroots',
  beetroot_seeds: 'beetroots',
  pumpkin: 'pumpkin_stem',
  pumpkin_seeds: 'pumpkin_stem',
  melon: 'melon_stem',
  melon_seeds: 'melon_stem'
};

const CROP_AGES: Record<string, { max: number }> = {
  wheat: { max: 7 },
  carrots: { max: 7 },
  potatoes: { max: 7 },
  beetroots: { max: 7 },
  nether_wart: { max: 3 }
};

const ALWAYS_HARVESTABLE = new Set(['pumpkin', 'melon']);

const COOKING_MAP: Record<string, string> = {
  raw_beef: 'cooked_beef',
  beef: 'cooked_beef',
  raw_chicken: 'cooked_chicken',
  chicken: 'cooked_chicken',
  raw_porkchop: 'cooked_porkchop',
  porkchop: 'cooked_porkchop',
  raw_mutton: 'cooked_mutton',
  mutton: 'cooked_mutton',
  raw_rabbit: 'cooked_rabbit',
  rabbit: 'cooked_rabbit',
  potato: 'baked_potato',
  raw_cod: 'cooked_cod',
  cod: 'cooked_cod',
  raw_salmon: 'cooked_salmon',
  salmon: 'cooked_salmon',
  kelp: 'dried_kelp'
};

const FUEL_NAMES = [
  'coal',
  'charcoal',
  'oak_log',
  'spruce_log',
  'birch_log',
  'jungle_log',
  'acacia_log',
  'dark_oak_log',
  'mangrove_log',
  'cherry_log',
  'oak_planks'
];

const FURNACE_BLOCKS = new Set(['furnace', 'blast_furnace', 'smoker']);
const COOK_TIMEOUT_MS = 60000;

type EntityLike = { name?: string; mobType?: string; type?: string; position: Vec3 };

interface FaceOption {
  vector: Vec3;
}

const PLACE_FACES: FaceOption[] = [
  { vector: new Vec3(0, -1, 0) },
  { vector: new Vec3(0, 0, -1) },
  { vector: new Vec3(0, 0, 1) },
  { vector: new Vec3(1, 0, 0) },
  { vector: new Vec3(-1, 0, 0) },
  { vector: new Vec3(0, 1, 0) }
];

function entityDisplayName(entity: EntityLike): string {
  return entity.name || entity.mobType || entity.type || 'entity';
}

function isMatureCrop(block: { name: string; metadata?: number }): boolean {
  const name = block.name;
  if (ALWAYS_HARVESTABLE.has(name)) return true;
  const cropInfo = CROP_AGES[name];
  if (!cropInfo) return false;
  if (typeof block.metadata === 'number') {
    return block.metadata >= cropInfo.max;
  }
  return true;
}

async function placeCropBlock(
  bot: mineflayer.Bot,
  pos: Vec3
): Promise<string | null> {
  for (const face of PLACE_FACES) {
    const referencePos = pos.plus(face.vector);
    const referenceBlock = bot.blockAt(referencePos);
    if (referenceBlock && referenceBlock.name !== 'air') {
      try {
        await bot.placeBlock(referenceBlock, face.vector.scaled(-1));
        const placedBlock = bot.blockAt(pos);
        if (!placedBlock || placedBlock.name === 'air') {
          return `Placement failed — block not present at (${pos.x}, ${pos.y}, ${pos.z})`;
        }
        return null;
      } catch (err) {
        log('warn', `Failed to place crop using face ${face.vector}: ${err}`);
      }
    }
  }
  return `Failed to place block at (${pos.x}, ${pos.y}, ${pos.z}): No suitable reference block found`;
}

export function registerFarmingTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "plant-crop",
    "Plant a crop at the specified position (or a small row when count > 1)",
    {
      crop: z.string().describe("Name of the crop to plant (e.g. wheat, carrots, potatoes, beetroot, pumpkin, melon)"),
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
      count: z.coerce.number().int().positive().optional().describe("Number of crops to plant (default: 1)")
    },
    async ({ crop, x, y, z, count = 1 }: { crop: string; x: number; y: number; z: number; count?: number }) => {
      const normalizedCrop = crop.trim().toLowerCase();
      const blockName = CROP_BLOCKS[normalizedCrop];
      if (!blockName) {
        return factory.createErrorResponse(`Unknown crop: ${crop}.`);
      }

      ({ x, y, z } = coerceCoordinates(x, y, z));
      const bot = getBot();
      let planted = 0;

      for (let i = 0; i < count; i++) {
        const placePos = new Vec3(x + i, y, z).floored();
        const existing = bot.blockAt(placePos);
        if (existing && existing.name !== 'air') {
          return factory.createErrorResponse(
            `There's already a block (${existing.name}) at (${placePos.x}, ${placePos.y}, ${placePos.z})`
          );
        }
        const error = await placeCropBlock(bot, placePos);
        if (error) {
          return factory.createErrorResponse(error);
        }
        planted += 1;
      }

      return factory.createResponse(`Planted ${planted} ${normalizedCrop} at (${x}, ${y}, ${z}).`);
    }
  );

  factory.registerTool(
    "harvest-crop",
    "Scan a volume of up to 216 blocks and break any mature crops",
    {
      x1: z.coerce.number().describe("First corner X"),
      y1: z.coerce.number().describe("First corner Y"),
      z1: z.coerce.number().describe("First corner Z"),
      x2: z.coerce.number().describe("Second corner X"),
      y2: z.coerce.number().describe("Second corner Y"),
      z2: z.coerce.number().describe("Second corner Z")
    },
    async ({ x1, y1, z1, x2, y2, z2 }: { x1: number; y1: number; z1: number; x2: number; y2: number; z2: number }) => {
      const c1 = coerceCoordinates(x1, y1, z1);
      const c2 = coerceCoordinates(x2, y2, z2);

      const minX = Math.min(Math.floor(c1.x), Math.floor(c2.x));
      const minY = Math.min(Math.floor(c1.y), Math.floor(c2.y));
      const minZ = Math.min(Math.floor(c1.z), Math.floor(c2.z));
      const maxX = Math.max(Math.floor(c1.x), Math.floor(c2.x));
      const maxY = Math.max(Math.floor(c1.y), Math.floor(c2.y));
      const maxZ = Math.max(Math.floor(c1.z), Math.floor(c2.z));

      const volume = (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1);
      if (volume > 216) {
        return factory.createErrorResponse(`Scan area too large (${volume} blocks); max 216.`);
      }

      const bot = getBot();
      const tally = new Map<string, number>();

      for (let cx = minX; cx <= maxX; cx++) {
        for (let cy = minY; cy <= maxY; cy++) {
          for (let cz = minZ; cz <= maxZ; cz++) {
            const pos = new Vec3(cx, cy, cz);
            const block = bot.blockAt(pos);
            if (!block || !isMatureCrop(block)) continue;
            try {
              await bot.dig(block);
              tally.set(block.name, (tally.get(block.name) ?? 0) + 1);
            } catch (err) {
              log('warn', `Failed to harvest ${block.name} at (${cx}, ${cy}, ${cz}): ${err}`);
            }
          }
        }
      }

      if (tally.size === 0) {
        return factory.createResponse('No mature crops in the area.');
      }

      const total = Array.from(tally.values()).reduce((a, b) => a + b, 0);
      const primary = Array.from(tally.entries()).sort((a, b) => b[1] - a[1])[0][0];
      return factory.createResponse(`Harvested ${total} ${primary}(s).`);
    }
  );

  factory.registerTool(
    "feed-animal",
    "Feed (and breed) the nearest animal using a food item from inventory",
    {
      entityType: z.string().optional().describe("Type of animal to feed (default: 'cow')"),
      foodItem: z.string().optional().describe("Food item to use (default: 'wheat')")
    },
    async ({ entityType = 'cow', foodItem = 'wheat' }: { entityType?: string; foodItem?: string }) => {
      const bot = getBot();
      const target = entityType.trim().toLowerCase();

      const entity = bot.nearestEntity((e) => {
        const name = (e as EntityLike).name || (e as EntityLike).mobType || '';
        return name.toLowerCase().includes(target);
      });

      if (!entity) {
        return factory.createErrorResponse(`No ${entityType} found nearby.`);
      }

      const items = bot.inventory.items();
      const resolved = resolveItem(items, foodItem);
      if (resolved.kind === 'ambiguous') {
        return factory.createErrorResponse(formatAmbiguousMatch(foodItem, resolved.matches));
      }
      if (resolved.kind === 'none') {
        return factory.createErrorResponse(`Couldn't find ${foodItem} in inventory.`);
      }

      try {
        await bot.equip(resolved.item, 'hand' as mineflayer.EquipmentDestination);
        bot.useOn(entity);
      } catch (err) {
        return factory.createErrorResponse(`Failed to feed ${entityDisplayName(entity)}: ${err instanceof Error ? err.message : String(err)}`);
      }

      const pos = entity.position;
      return factory.createResponse(
        `Fed ${entityDisplayName(entity)} with ${foodItem} at (${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)}).`
      );
    }
  );

  factory.registerTool(
    "cook-food",
    "Cook a food item in a furnace (e.g. raw_beef -> cooked_beef, potato -> baked_potato, kelp -> dried_kelp)",
    {
      itemName: z.string().describe("Name of the raw food item to cook"),
      count: z.coerce.number().int().positive().optional().describe("How many to cook (default: 1)"),
      furnaceType: z.string().optional().describe("Furnace block type (default: 'furnace')"),
      x: z.coerce.number().optional().describe("Furnace X coordinate"),
      y: z.coerce.number().optional().describe("Furnace Y coordinate"),
      z: z.coerce.number().optional().describe("Furnace Z coordinate")
    },
    async ({ itemName, count = 1, furnaceType = 'furnace', x, y, z }: {
      itemName: string;
      count?: number;
      furnaceType?: string;
      x?: number;
      y?: number;
      z?: number;
    }) => {
      const normalizedItem = itemName.trim().toLowerCase();
      const cookedName = COOKING_MAP[normalizedItem];
      if (!cookedName) {
        return factory.createErrorResponse(`Cannot cook ${itemName}.`);
      }

      const bot = getBot();
      const items = bot.inventory.items();

      const rawResolved = resolveItem(items, normalizedItem);
      if (rawResolved.kind === 'ambiguous') {
        return factory.createErrorResponse(formatAmbiguousMatch(normalizedItem, rawResolved.matches));
      }
      if (rawResolved.kind === 'none') {
        return factory.createErrorResponse(`Couldn't find any item matching '${itemName}' in inventory`);
      }
      const raw = rawResolved.item;

      let fuel: { name: string; count: number; type: number; metadata: number } | null = null;
      for (const fuelName of FUEL_NAMES) {
        const fuelResolved = resolveItem(items, fuelName);
        if (fuelResolved.kind === 'exact') {
          fuel = fuelResolved.item;
          break;
        }
      }
      if (!fuel) {
        return factory.createErrorResponse('No fuel found in inventory.');
      }

      let furnaceBlock: Block | null = null;
      if (x !== undefined && y !== undefined && z !== undefined) {
        const c = coerceCoordinates(x, y, z);
        const block = bot.blockAt(new Vec3(Math.floor(c.x), Math.floor(c.y), Math.floor(c.z)));
        if (!block || !FURNACE_BLOCKS.has(block.name)) {
          return factory.createErrorResponse(`No ${furnaceType} block found at (${Math.floor(c.x)}, ${Math.floor(c.y)}, ${Math.floor(c.z)})`);
        }
        furnaceBlock = block;
      } else {
        const mcData = minecraftData(bot.version);
        const entry = mcData.blocksByName[furnaceType];
        const matching = entry && typeof entry.id === 'number' ? entry.id : 61;
        furnaceBlock = bot.findBlock({ matching, maxDistance: 16 });
        if (!furnaceBlock) {
          return factory.createErrorResponse(`No ${furnaceType} found within 16 blocks.`);
        }
      }

      const resolvedCount = Math.min(count, raw.count);
      const furnace = await bot.openFurnace(furnaceBlock);
      const cleanup = () => {
        try {
          furnace.close();
        } catch {
          // ignore
        }
      };

      try {
        const existingInput = furnace.inputItem();
        if (existingInput && existingInput.name !== raw.name) {
          return factory.createResponse(`Furnace input slot is occupied by ${existingInput.name}`);
        }

        const existingFuel = furnace.fuelItem();
        if (existingFuel && existingFuel.name !== fuel.name) {
          return factory.createResponse(`Furnace fuel slot is occupied by ${existingFuel.name}`);
        }

        await furnace.putFuel(fuel.type, fuel.metadata ?? null, 1);
        await furnace.putInput(raw.type, raw.metadata ?? null, resolvedCount);

        const output = await waitForOutput(furnace, COOK_TIMEOUT_MS);
        if (!output) {
          return factory.createResponse('No output after waiting for the food to cook.');
        }

        const taken = await furnace.takeOutput();
        return factory.createResponse(`Cooked ${taken.count} ${itemName} -> ${taken.name}.`);
      } finally {
        cleanup();
      }
    }
  );

  factory.registerTool(
    "sleep",
    "Sleep in a nearby bed to skip the night (or wake up with forceWake)",
    {
      x: z.coerce.number().optional().describe("Bed X coordinate"),
      y: z.coerce.number().optional().describe("Bed Y coordinate"),
      z: z.coerce.number().optional().describe("Bed Z coordinate"),
      forceWake: z.boolean().optional().describe("Wake up if currently sleeping (default: false)")
    },
    async ({ x, y, z, forceWake }: { x?: number; y?: number; z?: number; forceWake?: boolean }) => {
      const bot = getBot();

      if (bot.isSleeping) {
        if (forceWake) {
          try {
            await bot.wake();
          } catch (err) {
            return factory.createErrorResponse(`Failed to wake up: ${err instanceof Error ? err.message : String(err)}`);
          }
          return factory.createResponse('Slept and woke.');
        }
        return factory.createResponse('Already sleeping.');
      }

      const isBed = (block: Block) => {
        try {
          return bot.isABed(block);
        } catch {
          return false;
        }
      };

      let bed: Block | null = null;
      if (x !== undefined && y !== undefined && z !== undefined) {
        const c = coerceCoordinates(x, y, z);
        const target = new Vec3(Math.floor(c.x), Math.floor(c.y), Math.floor(c.z));
        const found = bot.findBlock({ matching: isBed, maxDistance: 16 });
        if (found && found.position.distanceTo(target) <= 3) {
          bed = found;
        }
      } else {
        bed = bot.findBlock({ matching: isBed, maxDistance: 32 });
      }

      if (!bed) {
        return factory.createErrorResponse('No bed found nearby.');
      }

      try {
        await bot.sleep(bed);
      } catch (err) {
        return factory.createErrorResponse(`Failed to sleep: ${err instanceof Error ? err.message : String(err)}`);
      }

      return factory.createResponse(`Sleeping in bed at (${bed.position.x}, ${bed.position.y}, ${bed.position.z})`);
    }
  );
}

async function waitForOutput(furnace: mineflayer.Furnace, timeoutMs: number): Promise<Item | null> {
  const existing = furnace.outputItem();
  if (existing) {
    return existing;
  }

  return new Promise((resolve) => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const onUpdate = () => {
      const output = furnace.outputItem();
      if (output) {
        cleanup();
        resolve(output);
      }
    };

    const cleanup = () => {
      furnace.removeListener('update', onUpdate);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };

    furnace.on('update', onUpdate);

    timeoutId = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
  });
}

import { z } from "zod";
import mineflayer from 'mineflayer';
import { Block } from 'prismarine-block';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import minecraftData from 'minecraft-data';
import { ToolFactory } from '../tool-factory.js';
import { log } from '../logger.js';

const SEARCH_DISTANCE = 24;

const LOG_SOURCES = [
  'oak_log',
  'spruce_log',
  'birch_log',
  'jungle_log',
  'acacia_log',
  'dark_oak_log',
  'mangrove_log',
  'cherry_log'
];

const SOURCE_BLOCKS: Record<string, string[]> = {
  wood: LOG_SOURCES,
  logs: LOG_SOURCES,
  stone: ['stone'],
  cobblestone: ['stone'],
  coal: ['coal_ore', 'deepslate_coal_ore'],
  iron: ['iron_ore', 'deepslate_iron_ore'],
  gold: ['gold_ore', 'deepslate_gold_ore'],
  copper: ['copper_ore', 'deepslate_copper_ore'],
  diamond: ['diamond_ore', 'deepslate_diamond_ore'],
  redstone: ['redstone_ore', 'deepslate_redstone_ore'],
  lapis_lazuli: ['lapis_ore', 'deepslate_lapis_ore'],
  emerald: ['emerald_ore', 'deepslate_emerald_ore'],
  dirt: ['dirt', 'grass_block'],
  sand: ['sand'],
  gravel: ['gravel'],
  clay: ['clay'],
  andesite: ['andesite'],
  granite: ['granite'],
  diorite: ['diorite'],
  deepslate: ['deepslate'],
  tuff: ['tuff'],
  sandstone: ['sandstone'],
  netherrack: ['netherrack'],
  soul_sand: ['soul_sand'],
  obsidian: ['obsidian'],
  basalt: ['basalt']
};

const ledger = new Map<string, number>();

function addToLedger(itemName: string, amount: number): void {
  if (amount <= 0) return;
  ledger.set(itemName, (ledger.get(itemName) ?? 0) + amount);
}

function countItemInInventory(bot: mineflayer.Bot, itemName: string): number {
  const items = bot.inventory.items();
  let total = 0;
  for (const item of items) {
    const name = item.name.toLowerCase();
    if (name === itemName) {
      total += item.count;
    } else if (name === `raw_${itemName}`) {
      total += item.count;
    } else if ((itemName === 'wood' || itemName === 'logs') && name.endsWith('_log')) {
      total += item.count;
    }
  }
  return total;
}

async function gatherItem(
  bot: mineflayer.Bot,
  itemName: string,
  target: number,
  maxAttempts: number
): Promise<{ have: number; dug: number; beforeCount: number }> {
  const mcData = minecraftData(bot.version);
  const sourceIds: number[] = [];
  for (const name of SOURCE_BLOCKS[itemName]) {
    const entry = mcData.blocksByName[name];
    if (entry && typeof entry.id === 'number') {
      sourceIds.push(entry.id);
    }
  }

  const beforeCount = countItemInInventory(bot, itemName);
  let have = beforeCount;
  let dug = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (have >= target) break;

    let foundBlock: Block | null = null;
    for (const id of sourceIds) {
      try {
        const block = bot.findBlock({ matching: id, maxDistance: SEARCH_DISTANCE });
        if (block) {
          foundBlock = block;
          break;
        }
      } catch (err) {
        log('warn', `findBlock failed for ${itemName} (matching ${id}): ${err}`);
      }
    }

    if (!foundBlock) continue;

    const pos = foundBlock.position;
    const goal = new goals.GoalNear(pos.x, pos.y, pos.z, 2);
    try {
      await bot.pathfinder.goto(goal);
    } catch (err) {
      log('warn', `Failed to reach ${itemName} source at (${pos.x}, ${pos.y}, ${pos.z}): ${err}`);
    }

    try {
      await bot.dig(foundBlock);
      dug += 1;
    } catch (err) {
      log('warn', `Failed to dig ${foundBlock.name} for ${itemName}: ${err}`);
    }

    have = countItemInInventory(bot, itemName);
  }

  return { have, dug, beforeCount };
}

export function registerGatherTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "collect-item",
    "Gather a raw material from the world by finding and digging its source blocks",
    {
      itemName: z.string().describe("Name of the item to collect (e.g. wood, cobblestone, coal, iron)"),
      count: z.coerce.number().int().positive().optional().describe("How many to collect (default: 1)"),
      maxAttempts: z.coerce.number().int().positive().optional().describe("Max find/dig attempts (default: 10)")
    },
    async ({ itemName, count = 1, maxAttempts = 10 }: { itemName: string; count?: number; maxAttempts?: number }) => {
      const item = itemName.trim().toLowerCase();
      if (!SOURCE_BLOCKS[item]) {
        return factory.createErrorResponse(`No known source block for ${item}.`);
      }

      const bot = getBot();
      const { have, dug, beforeCount } = await gatherItem(bot, item, count, maxAttempts);
      addToLedger(item, Math.max(0, have - beforeCount));

      if (have >= count) {
        return factory.createResponse(`Collected ${have}/${count} ${item} after ${dug} digs`);
      }
      return factory.createResponse(`Stopped: reached ${have}/${count} after ${maxAttempts} attempts (no more ${item} nearby).`);
    }
  );

  factory.registerTool(
    "gather-loop",
    "Gather a raw material from the world until the target count is reached or attempts run out",
    {
      itemName: z.string().describe("Name of the item to gather (e.g. wood, cobblestone, coal, iron)"),
      count: z.coerce.number().int().positive().optional().describe("How many to gather (default: 16)"),
      maxAttempts: z.coerce.number().int().positive().optional().describe("Max find/dig attempts (default: 20)")
    },
    async ({ itemName, count = 16, maxAttempts = 20 }: { itemName: string; count?: number; maxAttempts?: number }) => {
      const item = itemName.trim().toLowerCase();
      if (!SOURCE_BLOCKS[item]) {
        return factory.createErrorResponse(`No known source block for ${item}.`);
      }

      const bot = getBot();
      const { have, beforeCount } = await gatherItem(bot, item, count, maxAttempts);
      addToLedger(item, Math.max(0, have - beforeCount));

      return factory.createResponse(`Gathered ${have}/${count} ${item}.`);
    }
  );

  factory.registerTool(
    "resource-ledger",
    "Track raw materials collected this session to know your material supply before building",
    {
      itemName: z.string().optional().describe("Query the ledger for a specific item"),
      reset: z.boolean().optional().describe("Clear the ledger")
    },
    async ({ itemName, reset }: { itemName?: string; reset?: boolean }) => {
      if (reset) {
        ledger.clear();
        return factory.createResponse('Ledger cleared.');
      }

      if (itemName) {
        const item = itemName.trim().toLowerCase();
        const value = ledger.get(item) ?? 0;
        return factory.createResponse(`Ledger ${item}: ${value}`);
      }

      if (ledger.size === 0) {
        return factory.createResponse('Ledger empty');
      }

      const lines = Array.from(ledger.entries())
        .map(([name, count]) => `${name}: ${count}`)
        .join('\n');
      return factory.createResponse(lines);
    }
  );
}

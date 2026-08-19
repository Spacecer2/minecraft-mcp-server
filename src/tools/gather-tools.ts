import { z } from "zod";
import mineflayer from 'mineflayer';
import { Block } from 'prismarine-block';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';
import { log } from '../logger.js';
import { slotValue, HIGH_VALUE_THRESHOLD, DEFAULT_ITEM_VALUE, packForTrip } from '../foraging.js';
import { planBranchMine, shouldQuitBranch, knownGoodLevels, segmentBlocks, branchYield } from '../mining-strategy.js';
import type { BranchMineOptions, BranchMinePlan, BlockPos } from '../mining-strategy.js';

const SEARCH_DISTANCE = 24;
const PICKUP_RANGE = 4;
const PICKUP_PASSES = 3;
const PICKUP_DELAY_MS = 300;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type DropEntity = { id: number; type?: string; position?: Vec3 };

function toVec3(value: unknown): Vec3 | undefined {
  if (value instanceof Vec3) return value;
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeof v.x === 'number' && typeof v.y === 'number' && typeof v.z === 'number') {
      return new Vec3(v.x, v.y, v.z);
    }
  }
  return undefined;
}

function scanItemEntities(bot: mineflayer.Bot): DropEntity[] {
  const results: DropEntity[] = [];
  const raw = (bot as unknown as Record<string, unknown>).entities as unknown;
  if (!raw) return results;

  if (raw instanceof Map) {
    for (const entity of (raw as Map<number, unknown>).values()) {
      if (entity && typeof entity === 'object') {
        const e = entity as Record<string, unknown>;
        results.push({
          id: typeof e.id === 'number' ? e.id : -1,
          type: typeof e.type === 'string' ? e.type : undefined,
          position: toVec3(e.position)
        });
      }
    }
  } else if (typeof raw === 'object') {
    for (const key of Object.keys(raw as Record<string, unknown>)) {
      const entity = (raw as Record<string, unknown>)[key];
      if (entity && typeof entity === 'object') {
        const e = entity as Record<string, unknown>;
        results.push({
          id: typeof e.id === 'number' ? e.id : Number(key),
          type: typeof e.type === 'string' ? e.type : undefined,
          position: toVec3(e.position)
        });
      }
    }
  }

  return results;
}

export type BranchGatherStrategy = {
  isOre: boolean;
  plan: BranchMinePlan | null;
  shouldQuit: (oresFound: number, blocksMined: number) => boolean;
};

export function dropLowValueIfFull(bot: mineflayer.Bot, heldItem: string): number {
  const inv = (bot as unknown as Record<string, unknown>).inventory as
    | { items?: unknown; emptySlotCount?: unknown }
    | undefined;
  if (!inv) return 0;

  const items = typeof inv.items === 'function' ? (inv.items as () => unknown)() : [];
  if (!Array.isArray(items)) return 0;

  const freeSlots =
    typeof inv.emptySlotCount === 'function'
      ? (inv.emptySlotCount as () => number)()
      : Infinity;
  if (freeSlots > 2) return 0;
  if (slotValue(heldItem) < HIGH_VALUE_THRESHOLD) return 0;

  const packed = packForTrip(
    items.filter(
      (it) =>
        it &&
        typeof it === 'object' &&
        typeof (it as { name?: unknown }).name === 'string' &&
        typeof (it as { count?: unknown }).count === 'number'
    ) as Array<{ name: string; count: number }>,
    Infinity
  );
  const junk = packed.dropFirst.filter((it) => slotValue(it.name) < DEFAULT_ITEM_VALUE);
  junk.sort((a, b) => slotValue(a.name) - slotValue(b.name));

  const toss = (bot as unknown as Record<string, unknown>).tossStack as
    | ((item: unknown) => unknown)
    | undefined;
  const drop = (bot as unknown as Record<string, unknown>).dropStack as
    | ((item: unknown) => unknown)
    | undefined;

  let dropped = 0;
  for (const item of junk) {
    if (typeof toss === 'function') {
      try {
        toss.call(bot, item);
      } catch {
        /* ignore drop failures */
      }
    } else if (typeof drop === 'function') {
      try {
        drop.call(bot, item);
      } catch {
        /* ignore drop failures */
      }
    }
    dropped += typeof item.count === 'number' ? item.count : 1;
  }
  return dropped;
}

export function branchMineStrategy(
  itemName: string,
  origin: BlockPos,
  opts?: BranchMineOptions
): BranchGatherStrategy {
  const base = itemName.toLowerCase().replace(/^(deepslate_|nether_)?(.*)_ore$/, '$2');
  const levels = knownGoodLevels(base);
  const isOre = levels.length > 0;
  if (!isOre) {
    return { isOre: false, plan: null, shouldQuit: () => false };
  }
  const level =
    opts?.level ?? (levels.includes(Math.floor(origin.y)) ? Math.floor(origin.y) : levels[0]);
  const plan = planBranchMine(origin, { ...opts, level });
  return {
    isOre: true,
    plan,
    shouldQuit: (oresFound: number, blocksMined: number) =>
      shouldQuitBranch(oresFound, blocksMined, plan.quitWhenYieldBelow)
  };
}

export async function collectDrops(bot: mineflayer.Bot, pos: Vec3, heldItem?: string): Promise<number> {
  let gathered = 0;
  const seen = new Set<number>();

  try {
    await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2));
  } catch (err) {
    log('warn', `collectDrops: could not reach drop area near (${pos.x}, ${pos.y}, ${pos.z}): ${err}`);
  }

  for (let pass = 0; pass < PICKUP_PASSES; pass++) {
    await sleep(PICKUP_DELAY_MS);

    const targets: DropEntity[] = [];
    try {
      for (const entity of scanItemEntities(bot)) {
        if (entity.type !== 'item' || !entity.position) continue;
        const dist = entity.position.distanceTo(pos);
        if (dist <= PICKUP_RANGE) {
          targets.push({ id: entity.id, position: entity.position });
        }
      }
    } catch (err) {
      log('warn', `collectDrops: failed to scan dropped item entities: ${err}`);
      break;
    }

    for (const target of targets) {
      try {
        await bot.pathfinder.goto(new goals.GoalNear(target.position!.x, target.position!.y, target.position!.z, 1));
        await sleep(PICKUP_DELAY_MS);
      } catch (err) {
        log('warn', `collectDrops: could not walk onto dropped item entity ${target.id}: ${err}`);
      }
      if (!seen.has(target.id)) {
        seen.add(target.id);
        gathered += 1;
      }
    }
  }

  if (heldItem) {
    try {
      dropLowValueIfFull(bot, heldItem);
    } catch (err) {
      log('warn', `collectDrops: failed to drop low-value items to free slots: ${err}`);
    }
  }

  return gathered;
}

export type GatherOptions = {
  branchMining?: boolean;
  origin?: BlockPos;
};

export type GatherResult = {
  have: number;
  dug: number;
  beforeCount: number;
  quitBranch: boolean;
  oresFound: number;
  blocksMined: number;
};

async function digPlannedSegments(
  bot: mineflayer.Bot,
  itemName: string,
  target: number,
  strategy: BranchGatherStrategy
): Promise<{ dug: number; have: number; oresFound: number; blocksMined: number; quitBranch: boolean }> {
  const plan = strategy.plan;
  if (plan === null) {
    return { dug: 0, have: countItemInInventory(bot, itemName), oresFound: 0, blocksMined: 0, quitBranch: false };
  }

  let oresFound = 0;
  let blocksMined = 0;
  let quitBranch = false;
  let dug = 0;
  let have = countItemInInventory(bot, itemName);

  for (const seg of plan.order) {
    if (quitBranch || have >= target) break;
    const segStart = Date.now();
    const segOresStart = oresFound;
    const segBlocksStart = blocksMined;

    for (const pos of segmentBlocks(seg)) {
      if (quitBranch || have >= target) break;
      const blockPos = new Vec3(pos.x, pos.y, pos.z);

      try {
        await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2));
      } catch (err) {
        log('warn', `[MVT] could not reach (${pos.x}, ${pos.y}, ${pos.z}): ${err}`);
        continue;
      }

      let block: Block | null = null;
      try {
        block = bot.blockAt(blockPos);
      } catch (err) {
        log('warn', `[MVT] blockAt failed at (${pos.x}, ${pos.y}, ${pos.z}): ${err}`);
        continue;
      }
      if (!block) continue;

      try {
        await bot.dig(block);
        dug += 1;
        blocksMined += 1;
      } catch (err) {
        log('warn', `[MVT] failed to dig ${block.name} at (${pos.x}, ${pos.y}, ${pos.z}): ${err}`);
        continue;
      }

      const beforePickup = countItemInInventory(bot, itemName);
      try {
        await collectDrops(bot, blockPos, itemName);
      } catch (err) {
        log('warn', `[MVT] failed to collect drops at (${pos.x}, ${pos.y}, ${pos.z}) for ${itemName}: ${err}`);
      }
      have = countItemInInventory(bot, itemName);
      if (have <= beforePickup) {
        try {
          await collectDrops(bot, blockPos, itemName);
        } catch (err) {
          log('warn', `[MVT] retry collecting drops at (${pos.x}, ${pos.y}, ${pos.z}) for ${itemName}: ${err}`);
        }
        have = countItemInInventory(bot, itemName);
      }
      if (have > beforePickup) oresFound += 1;

      if (strategy.shouldQuit(oresFound, blocksMined)) {
        log('warn', `[MVT] ore yield dropped below environment average — quit this branch`);
        quitBranch = true;
        break;
      }
    }

    const segTime = (Date.now() - segStart) / 1000;
    const segOres = oresFound - segOresStart;
    const segBlocks = blocksMined - segBlocksStart;
    const yieldPerMin = branchYield(segOres, segBlocks, segTime);
    const rendered = Number.isFinite(yieldPerMin) ? yieldPerMin.toFixed(1) : '∞';
    log('warn', `[MVT] segment ${seg.kind} yielded ${segOres} ore in ${segBlocks} blocks (${rendered} ore/min)`);
  }

  return { dug, have, oresFound, blocksMined, quitBranch };
}

export async function gatherItem(
  bot: mineflayer.Bot,
  itemName: string,
  target: number,
  maxAttempts: number,
  opts: GatherOptions = {}
): Promise<GatherResult> {
  const mcData = minecraftData(bot.version);
  const sourceIds: number[] = [];
  for (const name of SOURCE_BLOCKS[itemName]) {
    const entry = mcData.blocksByName[name];
    if (entry && typeof entry.id === 'number') {
      sourceIds.push(entry.id);
    }
  }

  const strategy = branchMineStrategy(itemName, opts.origin ?? bot.entity.position);
  const beforeCount = countItemInInventory(bot, itemName);

  if (opts.branchMining === true && strategy.isOre && strategy.plan !== null) {
    const plan = strategy.plan;
    let moved = false;
    try {
      await bot.pathfinder.goto(new goals.GoalNear(plan.origin.x, plan.level, plan.origin.z, 2));
      moved = true;
    } catch (err) {
      log('warn', `[MVT] could not reach mining level ${plan.level}: ${err}`);
    }
    if (moved) {
      const result = await digPlannedSegments(bot, itemName, target, strategy);
      return { ...result, beforeCount };
    }
  }

  const branchMining = opts.branchMining === true && strategy.isOre;
  let oresFound = 0;
  let blocksMined = 0;
  let quitBranch = false;
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

    const beforePickup = countItemInInventory(bot, itemName);
    try {
      await collectDrops(bot, pos, itemName);
    } catch (err) {
      log('warn', `Failed to collect drops near (${pos.x}, ${pos.y}, ${pos.z}) for ${itemName}: ${err}`);
    }
    have = countItemInInventory(bot, itemName);

    if (have <= beforePickup) {
      try {
        await collectDrops(bot, pos, itemName);
      } catch (err) {
        log('warn', `Retry collecting drops near (${pos.x}, ${pos.y}, ${pos.z}) for ${itemName}: ${err}`);
      }
      have = countItemInInventory(bot, itemName);
    }

    if (branchMining) {
      blocksMined += 1;
      if (have > beforePickup) oresFound += 1;
      if (strategy.shouldQuit(oresFound, blocksMined)) {
        log('warn', `[MVT] ore yield dropped below environment average — quit this branch`);
        quitBranch = true;
        break;
      }
    }
  }

  return { have, dug, beforeCount, quitBranch, oresFound, blocksMined };
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
      maxAttempts: z.coerce.number().int().positive().optional().describe("Max find/dig attempts (default: 20)"),
      branchMining: z.boolean().optional().describe("For ore, stop a branch when yield drops below the environment average")
    },
    async ({ itemName, count = 16, maxAttempts = 20, branchMining = false }: { itemName: string; count?: number; maxAttempts?: number; branchMining?: boolean }) => {
      const item = itemName.trim().toLowerCase();
      if (!SOURCE_BLOCKS[item]) {
        return factory.createErrorResponse(`No known source block for ${item}.`);
      }

      const bot = getBot();
      const { have, beforeCount, quitBranch } = await gatherItem(bot, item, count, maxAttempts, { branchMining });
      addToLedger(item, Math.max(0, have - beforeCount));

      if (quitBranch) {
        return factory.createResponse(`Gathered ${have}/${count} ${item} — stopped this branch early (ore yield below average).`);
      }

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

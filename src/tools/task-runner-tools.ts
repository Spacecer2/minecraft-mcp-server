import { z } from "zod";
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { Vec3 } from 'vec3';
import { Block } from 'prismarine-block';
import minecraftData from 'minecraft-data';
import { ToolFactory, type PrimalDispatch, makePrimalDispatcher } from '../tool-factory.js';
import { checkInterrupt, isInterruptError, getInterruptReason } from '../interrupt.js';
import { GoalContext, GoalStep, GoalStepResult, GoalSpec, WeightedFallback, pickBestFallback } from '../goal-core.js';
import {
  type DriveInput,
  type DriveDecision,
  healthDrive,
  hungerDrive,
  oxygenDrive,
  nightDrive,
  threatDrive,
  inventoryDrive,
  toolDrive,
  arbitrate,
  duskPreemptActive
} from '../drives.js';
import {
  type DayPhase,
  phaseFor,
  suggestedActivities,
  returnByDuskDeadline
} from '../day-rhythm.js';
import { startGoalRun, statusOf, resolveRun, abortRun, resetGoalRuns, type GoalTask } from '../goal-runner.js';
import { estimateDistance, estimateRiskNearby, safeInput } from '../utility.js';
import { planBranchMine, knownGoodLevels, DEFAULT_BRANCH_SPACING } from '../mining-strategy.js';
import type { BranchMinePlan, BlockPos } from '../mining-strategy.js';
import { ucbBonus } from '../risk-evaluator.js';
import * as gatherTools from './gather-tools.js';
import {
  generateTemplate,
  getTemplateNames,
  resolvePalette,
  blockNameForCode,
  TemplateLayout,
  TemplatePalette
} from './template-registry.js';

type FaceDirection = 'up' | 'down' | 'north' | 'south' | 'east' | 'west';
type TaskStage = 'foundation' | 'walls' | 'roof' | 'details';
type TaskStatus = 'pending' | 'running' | 'done' | 'failed';

const FACE_OPTIONS: { direction: FaceDirection; vector: Vec3 }[] = [
  { direction: 'down', vector: new Vec3(0, -1, 0) },
  { direction: 'north', vector: new Vec3(0, 0, -1) },
  { direction: 'south', vector: new Vec3(0, 0, 1) },
  { direction: 'east', vector: new Vec3(1, 0, 0) },
  { direction: 'west', vector: new Vec3(-1, 0, 0) },
  { direction: 'up', vector: new Vec3(0, 1, 0) }
];

const SEARCH_DISTANCE = 24;
const GATHER_ATTEMPTS = 20;

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
  coal_ore: ['coal_ore', 'deepslate_coal_ore'],
  iron_ore: ['iron_ore', 'deepslate_iron_ore'],
  gold_ore: ['gold_ore', 'deepslate_gold_ore'],
  copper_ore: ['copper_ore', 'deepslate_copper_ore'],
  diamond_ore: ['diamond_ore', 'deepslate_diamond_ore'],
  redstone_ore: ['redstone_ore', 'deepslate_redstone_ore'],
  lapis_ore: ['lapis_ore', 'deepslate_lapis_ore'],
  emerald_ore: ['emerald_ore', 'deepslate_emerald_ore'],
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

interface TaskStep {
  id: number;
  blockName: string;
  x: number;
  y: number;
  z: number;
  face?: FaceDirection;
  stage: TaskStage;
  status: 'pending' | 'placed' | 'failed';
  reason?: string;
}

interface TaskRun {
  id: number;
  kind: 'build' | 'gather';
  description: string;
  status: TaskStatus;
  planId?: number;
  progress?: string;
  error?: string;
  template?: string;
  anchor?: { x: number; y: number; z: number };
  steps?: TaskStep[];
  itemName?: string;
  target?: number;
  have?: number;
}

const taskRuns = new Map<number, TaskRun>();
let lastTaskId = 0;

// Module-level UCB exploration bookkeeping for goal planning: tracks how many
// times each gather/harvest goal has been planned so the exploration bonus can
// decay as a goal becomes familiar.
const goalVisitCounts = new Map<string, number>();

export function resetTaskRuns(): void {
  taskRuns.clear();
  lastTaskId = 0;
  resetGoalRuns();
}

function resolveTask(id?: number): TaskRun | undefined {
  if (id !== undefined) return taskRuns.get(id);
  if (lastTaskId > 0) return taskRuns.get(lastTaskId);
  return undefined;
}

/** Resolve a task id to either a build TaskRun (via goal-runner carve-out) or a background goal. */
function resolveAnyTask(id?: number): TaskRun | GoalTask | undefined {
  const goal = statusOf(id);
  if (goal && goal.spec.steps.length === 1 && goal.spec.steps[0].name === 'build') {
    const buildTask = resolveTask(id);
    if (buildTask) return buildTask;
  }
  if (goal) return goal;
  return resolveTask(id);
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
): Promise<number> {
  const mcData = minecraftData(bot.version);
  const sourceIds: number[] = [];
  for (const name of SOURCE_BLOCKS[itemName]) {
    const entry = mcData.blocksByName[name];
    if (entry && typeof entry.id === 'number') {
      sourceIds.push(entry.id);
    }
  }

  let have = countItemInInventory(bot, itemName);
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
      } catch {
        // keep looking for another source block
      }
    }
    if (!foundBlock) continue;

    const pos = foundBlock.position;
    try {
      await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2));
    } catch {
      // still try to dig even if we could not path to it
    }

    try {
      await bot.dig(foundBlock);
    } catch {
      // block may have changed; recount below
    }

    have = countItemInInventory(bot, itemName);
  }

  return have;
}

function stageForLayer(idx: number, layer: string[], totalLayers: number): TaskStage {
  if (idx === 0) return 'foundation';
  const text = layer.join('');
  const hasR = text.includes('R');
  const hasWallCode = /[WCGP]/.test(text);
  if (hasR && !hasWallCode) return 'roof';
  if (idx === totalLayers - 1 && text.includes('.')) return 'details';
  return 'walls';
}

function buildSteps(
  layout: TemplateLayout,
  anchor: { x: number; y: number; z: number },
  palette: TemplatePalette
): { steps: TaskStep[]; stages: TaskStage[] } {
  const steps: TaskStep[] = [];
  const stageOrder: TaskStage[] = [];
  const seen = new Set<TaskStage>();
  let id = 0;

  layout.layers.forEach((layer, layerIdx) => {
    const stage = stageForLayer(layerIdx, layer, layout.layers.length);
    if (!seen.has(stage)) {
      seen.add(stage);
      stageOrder.push(stage);
    }
    layer.forEach((row, z) => {
      for (let x = 0; x < row.length; x++) {
        const blockName = blockNameForCode(row[x], palette);
        if (blockName === 'air') continue;
        steps.push({
          id: id++,
          blockName,
          x: anchor.x + x,
          y: anchor.y + layerIdx,
          z: anchor.z + z,
          stage,
          status: 'pending'
        });
      }
    });
  });

  return { steps, stages: stageOrder };
}

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

function buildProgress(task: TaskRun): string {
  if (task.kind === 'build' && task.steps) {
    const placed = task.steps.filter(s => s.status === 'placed').length;
    const total = task.steps.length;
    const pendingStage = task.steps.find(s => s.status === 'pending')?.stage;
    return `${placed}/${total} blocks placed (stage: ${pendingStage ?? 'complete'})`;
  }
  return task.progress ?? '';
}

// ---------------------------------------------------------------------------
// Reusable goal steps (the deterministic "back brain" primitives)
// ---------------------------------------------------------------------------

/** Reusable drop-items-on-a-player step. Returns blocked<3 if the item is missing so the plan can escalate. */
export function deliverItemStep(itemName: string, count: number): GoalStep {
  return {
    name: 'deliverItem',
    run: async (ctx: GoalContext): Promise<GoalStepResult> => {
      const bot = ctx.bot;
      const player = bot.nearestEntity((e) => e.type === 'player');
      if (!player) {
        return {
          status: 'blocked',
          intensity: 2,
          reason: `no player nearby to deliver ${itemName} to`,
          context: { item: itemName, count }
        };
      }
      const have = countItemInInventory(bot, itemName);
      if (have < count) {
        return {
          status: 'blocked',
          intensity: 2,
          reason: `no ${itemName} in inventory`,
          context: { item: itemName, count, have }
        };
      }
      const item = bot.inventory.items().find((i) => i.name === itemName);
      if (!item) {
        return {
          status: 'blocked',
          intensity: 2,
          reason: `no ${itemName} in inventory`,
          context: { item: itemName, count, have }
        };
      }

      const pos = player.position;
      try {
        await bot.pathfinder.goto(new goals.GoalNear(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z), 2));
      } catch {
        // try to drop anyway
      }

      const toDrop = Math.min(count, item.count);
      try {
        if (toDrop >= item.count) {
          await bot.tossStack(item);
        } else {
          await bot.toss(item.type, item.metadata ?? null, toDrop);
        }
      } catch (err) {
        return {
          status: 'blocked',
          intensity: 3,
          reason: `failed to drop ${itemName}: ${err instanceof Error ? err.message : String(err)}`,
          context: { item: itemName, count, toDrop }
        };
      }

      const after = countItemInInventory(bot, itemName);
      const dropped = Math.max(0, have - after);
      if (dropped <= 0) {
        return {
          status: 'blocked',
          intensity: 3,
          reason: `dropped ${itemName} but inventory did not decrease`,
          context: { item: itemName, count, before: have, after }
        };
      }

      const username = (player as { username?: string; name?: string }).username
        ?? (player as { name?: string }).name
        ?? 'player';
      return {
        status: 'done',
        report: `delivered ${itemName} x${dropped} to ${username} at (${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)})`
      };
    }
  };
}

const FOOD_RECIPES: Record<string, { ingredient: string; ingredientCount: number; yield: number }> = {
  bread: { ingredient: 'wheat', ingredientCount: 3, yield: 1 }
};

const CROP_BLOCKS = ['wheat', 'carrots', 'potatoes', 'beetroots'];
const CROP_ITEM: Record<string, string> = {
  wheat: 'wheat',
  carrots: 'carrots',
  potatoes: 'potatoes',
  beetroots: 'beetroot'
};
const CROP_MAX_AGE: Record<string, number> = {
  wheat: 7,
  carrots: 7,
  potatoes: 7,
  beetroots: 7
};

type CollectDropsFn = (bot: mineflayer.Bot, pos: Vec3) => Promise<number>;

async function localCollectDrops(bot: mineflayer.Bot, pos: Vec3): Promise<number> {
  try {
    await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2));
  } catch {
    // pickup relies on walking over the drop
  }
  return 0;
}

/**
 * collectDrops comes from gather-tools (added by the parallel edit). Guarded so
 * this module still works before that export lands: falls back to pathing onto
 * the dig site, which is a minimal pickup attempt.
 */
const collectDrops: CollectDropsFn =
  ((gatherTools as unknown) as { collectDrops?: CollectDropsFn }).collectDrops ?? localCollectDrops;

function isMatureCrop(block: Block): boolean {
  const maxAge = CROP_MAX_AGE[block.name];
  if (maxAge === undefined) return false;
  if (typeof block.metadata === 'number') return block.metadata >= maxAge;
  try {
    const age = (block.getProperties?.() as { age?: number } | undefined)?.age;
    if (typeof age === 'number') return age >= maxAge;
  } catch {
    // fall through
  }
  return true;
}

async function findMatureCrops(bot: mineflayer.Bot): Promise<Block[]> {
  const mcData = minecraftData(bot.version);
  const found: Block[] = [];
  for (const crop of CROP_BLOCKS) {
    const entry = mcData.blocksByName[crop];
    if (!entry || typeof entry.id !== 'number') continue;
    let positions: Vec3[] = [];
    try {
      positions = bot.findBlocks({ matching: entry.id, maxDistance: SEARCH_DISTANCE, count: 32 }) ?? [];
    } catch {
      try {
        const one = bot.findBlock({ matching: entry.id, maxDistance: SEARCH_DISTANCE });
        if (one) positions = [one.position];
      } catch {
        // no such crop nearby
      }
    }
    for (const pos of positions) {
      try {
        const block = bot.blockAt(pos);
        if (block && isMatureCrop(block)) found.push(block);
      } catch {
        // skip unreadable blocks
      }
    }
  }
  return found;
}

async function digAndCollect(bot: mineflayer.Bot, block: Block): Promise<void> {
  const pos = block.position;
  try {
    await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2));
  } catch {
    // still try to dig
  }
  try {
    await bot.dig(block);
  } catch {
    // block may have changed
    return;
  }
  try {
    await collectDrops(bot, pos);
  } catch {
    // drops may still land in inventory on walk-over
  }
}

/** Find mature crops nearby, dig them, collect drops, and verify inventory gain. */
export function harvestCropsStep(): GoalStep {
  return {
    name: 'harvestCrops',
    run: async (ctx: GoalContext): Promise<GoalStepResult> => {
      const bot = ctx.bot;
      const blocks = await findMatureCrops(bot);
      if (blocks.length === 0) {
        return {
          status: 'blocked',
          intensity: 3,
          reason: 'no mature crops found nearby',
          context: { crops: CROP_BLOCKS, distance: SEARCH_DISTANCE }
        };
      }

      const beforeCounts = new Map<string, number>();
      for (const crop of CROP_BLOCKS) {
        beforeCounts.set(CROP_ITEM[crop], countItemInInventory(bot, CROP_ITEM[crop]));
      }
      const gained = new Map<string, number>();

      for (const block of blocks) {
        await digAndCollect(bot, block);
        const item = CROP_ITEM[block.name] ?? block.name;
        const before = beforeCounts.get(item) ?? 0;
        const now = countItemInInventory(bot, item);
        if (now > before) {
          gained.set(item, (gained.get(item) ?? 0) + (now - before));
          beforeCounts.set(item, now);
        }
      }

      if (gained.size === 0) {
        return {
          status: 'blocked',
          intensity: 3,
          reason: 'harvested crops but no items were collected',
          context: { found: blocks.length }
        };
      }

      const [primaryItem, primaryCount] = Array.from(gained.entries()).sort((a, b) => b[1] - a[1])[0];
      return { status: 'done', report: `harvested ${primaryCount} ${primaryItem}` };
    }
  };
}

/** Gather a food ingredient's crop (wheat) by finding and digging mature plants. */
async function gatherIngredient(bot: mineflayer.Bot, ingredient: string, want: number): Promise<number> {
  const mcData = minecraftData(bot.version);
  const entry = mcData.blocksByName[ingredient];
  if (!entry || typeof entry.id !== 'number') {
    return countItemInInventory(bot, ingredient);
  }

  let positions: Vec3[] = [];
  try {
    positions = bot.findBlocks({ matching: entry.id, maxDistance: SEARCH_DISTANCE, count: Math.min(32, Math.max(1, want * 2)) }) ?? [];
  } catch {
    try {
      const one = bot.findBlock({ matching: entry.id, maxDistance: SEARCH_DISTANCE });
      if (one) positions = [one.position];
    } catch {
      // none
    }
  }

  for (const pos of positions) {
    let block: Block | null = null;
    try {
      block = bot.blockAt(pos);
    } catch {
      continue;
    }
    if (!block || !isMatureCrop(block)) continue;
    await digAndCollect(bot, block);
    if (countItemInInventory(bot, ingredient) >= want) break;
  }
  return countItemInInventory(bot, ingredient);
}

/** Try to obtain `want` of an ingredient by trading with a nearby villager. */
async function tryTradeIngredient(bot: mineflayer.Bot, ingredient: string, want: number): Promise<boolean> {
  let v: { name?: string } | null = null;
  try {
    v = bot.nearestEntity?.((e: { name?: string }) => e.name === 'villager') ?? null;
  } catch {
    return false;
  }
  if (!v) return false;
  let window: { close?: () => void } | null = null;
  try {
    const opened = await bot.openVillager?.(v as never);
    window = opened as unknown as { close?: () => void };
    const trades = (opened as unknown as { trades?: Array<{ output?: { name?: string }; firstInput?: { name?: string } }> }).trades ?? [];
    const idx = trades.findIndex((t) => t.output?.name === ingredient);
    if (idx < 0) return false;
    const before = countItemInInventory(bot, ingredient);
    await (opened as unknown as { trade: (i: number, times: number) => Promise<void> }).trade(idx, Math.ceil(want));
    return countItemInInventory(bot, ingredient) > before;
  } catch {
    return false;
  } finally {
    try {
      window?.close?.();
    } catch {
      // ignore
    }
  }
}

/** Try to withdraw `want` of an ingredient from a nearby chest. */
async function tryWithdrawFromChest(bot: mineflayer.Bot, ingredient: string, want: number): Promise<boolean> {
  const mcData = minecraftData(bot.version);
  const chestId = mcData.blocksByName.chest?.id;
  if (typeof chestId !== 'number') return false;
  let chest: { position?: { x: number; y: number; z: number } } | null = null;
  try {
    chest = bot.findBlock?.({ matching: chestId, maxDistance: 24 }) ?? null;
  } catch {
    return false;
  }
  if (!chest) return false;
  let window: { close?: () => void } | null = null;
  try {
    const opened = await bot.openContainer?.(chest as never);
    window = opened as unknown as { close?: () => void };
    const items = (opened as unknown as { containerItems: () => Array<{ name?: string; type?: number; count?: number }> }).containerItems();
    const match = items.find((i) => i.name === ingredient);
    if (!match || (match.count ?? 0) <= 0) return false;
    const before = countItemInInventory(bot, ingredient);
    await (opened as unknown as { withdraw: (t: number, m: unknown, n: number) => Promise<void> }).withdraw(match.type ?? 0, null, Math.min(want, match.count ?? want));
    return countItemInInventory(bot, ingredient) > before;
  } catch {
    return false;
  } finally {
    try {
      window?.close?.();
    } catch {
      // ignore
    }
  }
}

/** Check the recipe, gather missing ingredients, craft, then verify the crafted item. */
export function makeFoodStep(itemName: string, count: number): GoalStep {
  return {
    name: 'makeFood',
    run: async (ctx: GoalContext): Promise<GoalStepResult> => {
      const bot = ctx.bot;
      const recipe = FOOD_RECIPES[itemName];
      if (!recipe) {
        return {
          status: 'blocked',
          intensity: 3,
          reason: `cannot make ${itemName}`,
          context: { item: itemName }
        };
      }

      // Already have the item? Nothing to make — empty report so the engine
      // skips this step (deliver-bread plans check inventory before crafting).
      if (countItemInInventory(bot, itemName) >= count) {
        return { status: 'done', report: '' };
      }

      const batches = Math.ceil(count / recipe.yield);
      const neededIngredient = batches * recipe.ingredientCount;
      let haveIngredient = countItemInInventory(bot, recipe.ingredient);

      if (haveIngredient < neededIngredient) {
        // Utility-weighted fallback: pick the cheapest source (dopamine system).
        const origin = bot.entity?.position;
        let wheatPos: { x: number; y: number; z: number } | null = null;
        try {
          const mc = minecraftData(bot.version);
          const id = mc.blocksByName[recipe.ingredient]?.id;
          if (typeof id === 'number') {
            const f = bot.findBlock?.({ matching: id, maxDistance: SEARCH_DISTANCE });
            if (f?.position) wheatPos = f.position as { x: number; y: number; z: number };
          }
        } catch {
          wheatPos = null;
        }
        type FoodSourceId = 'harvest' | 'villager' | 'chest';
        type FoodSourceOption = WeightedFallback & { id: FoodSourceId; run: () => Promise<boolean> };
        const options: FoodSourceOption[] = [
          {
            id: 'harvest',
            run: async () => {
              await gatherIngredient(bot, recipe.ingredient, neededIngredient - countItemInInventory(bot, recipe.ingredient));
              return countItemInInventory(bot, recipe.ingredient) >= neededIngredient;
            },
            input: safeInput(bot, {
              value: 0.8,
              importance: 0.9,
              distanceBlocks: wheatPos ? estimateDistance({ entity: { position: origin } }, wheatPos) : 60,
              timeSeconds: 12,
              risk: estimateRiskNearby(bot)
            })
          },
          {
            id: 'villager',
            run: async () => {
              const v = bot.nearestEntity?.((e: { name?: string }) => e.name === 'villager');
              return Boolean(v) && (await tryTradeIngredient(bot, recipe.ingredient, neededIngredient));
            },
            input: safeInput(bot, {
              value: 0.9,
              importance: 0.8,
              distanceBlocks: 40,
              timeSeconds: 20,
              risk: estimateRiskNearby(bot)
            })
          },
          {
            id: 'chest',
            run: async () => {
              const mc = minecraftData(bot.version);
              const cid = mc.blocksByName.chest?.id;
              const chest = typeof cid === 'number' ? bot.findBlock?.({ matching: cid, maxDistance: 24 }) : null;
              return Boolean(chest) && (await tryWithdrawFromChest(bot, recipe.ingredient, neededIngredient));
            },
            input: safeInput(bot, {
              value: 0.6,
              importance: 0.7,
              distanceBlocks: 24,
              timeSeconds: 8,
              risk: 0
            })
          }
        ];

        let gathered = false;
        // Constraint-aware utility arbitration: try up to 2 best fallbacks, then escalate.
        const remaining = new Map<FoodSourceId, FoodSourceOption>(options.map((o) => [o.id, o]));
        for (let attempt = 0; attempt < 2 && remaining.size > 0; attempt++) {
          const bestId = pickBestFallback(Array.from(remaining.values()));
          if (bestId === null) break;
          const opt = remaining.get(bestId as FoodSourceId);
          remaining.delete(bestId as FoodSourceId);
          if (!opt) continue;
          try {
            if (await opt.run()) {
              gathered = true;
              break;
            }
          } catch {
            // try next fallback
          }
        }

        haveIngredient = countItemInInventory(bot, recipe.ingredient);
        if (!gathered || haveIngredient < neededIngredient) {
          return {
            status: 'blocked',
            intensity: 3,
            reason: `no ${recipe.ingredient} available`,
            context: { item: itemName, missing: recipe.ingredient, have: haveIngredient, need: neededIngredient }
          };
        }
      }

      try {
        const mcData = minecraftData(bot.version);
        const entry = mcData.itemsByName[itemName];
        if (!entry || typeof entry.id !== 'number') {
          return {
            status: 'blocked',
            intensity: 3,
            reason: `no recipe for ${itemName}`,
            context: { item: itemName }
          };
        }
        const recipes = bot.recipesFor(entry.id, null, batches, null) ?? [];
        const craftRecipe = recipes[0];
        if (!craftRecipe) {
          return {
            status: 'blocked',
            intensity: 3,
            reason: `no recipe for ${itemName}`,
            context: { item: itemName }
          };
        }
        await bot.craft(craftRecipe, batches, undefined);
      } catch (err) {
        return {
          status: 'blocked',
          intensity: 3,
          reason: `failed to craft ${itemName}: ${err instanceof Error ? err.message : String(err)}`,
          context: { item: itemName }
        };
      }

      const made = countItemInInventory(bot, itemName);
      if (made <= 0) {
        return {
          status: 'blocked',
          intensity: 3,
          reason: `crafted ${itemName} but none found in inventory`,
          context: { item: itemName }
        };
      }
      return { status: 'done', report: `made ${itemName} x${made}` };
    }
  };
}

/**
 * Defensive skill: barricade the bot by placing blocks to shield against nearby
 * enemies. Places a small wall of a barrier block around the bot, between it and
 * the nearest threat, so it can retreat/regroup. Uses blocks already in the
 * inventory (dirt/cobblestone/stone preferred), falls back to whatever is handy.
 */
export function barricadeStep(): GoalStep {
  return {
    name: 'barricade',
    run: async (ctx: GoalContext): Promise<GoalStepResult> => {
      const bot = ctx.bot;
      const origin = bot.entity?.position;
      if (!origin) {
        return { status: 'blocked', intensity: 2, reason: 'no position to barricade around', context: {} };
      }

      // Pick a barrier block from inventory (prefer cobblestone/stone/dirt).
      const items = bot.inventory?.items?.() ?? [];
      const barrierName =
        items.find((i) => i.name === 'cobblestone')?.name ||
        items.find((i) => i.name === 'stone')?.name ||
        items.find((i) => i.name === 'dirt')?.name ||
        items.find((i) => i.name === 'oak_planks')?.name ||
        items.find((i) => i.name === 'sand')?.name;
      if (!barrierName) {
        return {
          status: 'blocked',
          intensity: 2,
          reason: 'no block in inventory to barricade with',
          context: { inventory: items.map((i) => i.name) }
        };
      }

      // Find the nearest threat to know which way to shield.
      let threatDir: { x: number; z: number } | null = null;
      try {
        const hostile = bot.nearestEntity?.((e: { type?: string; name?: string }) =>
          Boolean(e.type === 'mob' || (e.name && /zombie|skeleton|spider|creeper|slime/.test(e.name)))
        );
        if (hostile?.position) {
          const d = hostile.position.minus(origin);
          const len = Math.sqrt(d.x * d.x + d.z * d.z) || 1;
          threatDir = { x: d.x / len, z: d.z / len };
        }
      } catch {
        threatDir = null;
      }
      // Default shield direction (south) if no threat detected.
      const dir = threatDir ?? { x: 0, z: 1 };

      // Place a 3-wide, 2-tall wall ~2 blocks from the bot toward the threat.
      const wallDistance = 2;
      const baseX = Math.floor(origin.x + dir.x * wallDistance);
      const baseZ = Math.floor(origin.z + dir.z * wallDistance);
      const baseY = Math.floor(origin.y);
      const perpX = -dir.z;
      const perpZ = dir.x;

      let placed = 0;
      const failures: string[] = [];
      for (const off of [-1, 0, 1]) {
        for (const h of [0, 1]) {
          const px = baseX + perpX * off;
          const pz = baseZ + perpZ * off;
          const py = baseY + h;
          try {
            await placeAt(bot, new Vec3(px, py, pz));
            placed++;
          } catch {
            failures.push(`(${px},${py},${pz})`);
          }
        }
      }

      if (placed === 0) {
        return {
          status: 'blocked',
          intensity: 2,
          reason: `could not barricade with ${barrierName}`,
          context: { failures }
        };
      }
      ctx.record(`barricaded with ${barrierName} (${placed} blocks)`);
      return { status: 'done', report: `barricaded with ${barrierName} (${placed} blocks) toward ${threatDir ? 'the threat' : 'default'}` };
    }
  };
}

/**
 * Fallback: obtain an item by trading with a nearby villager. Used when the
 * primary source (harvest/gather) is far or absent, weighted by utility.
 */
export function tradeWithVillagerStep(itemName: string, count: number): GoalStep {
  return {
    name: 'tradeWithVillager',
    run: async (ctx: GoalContext): Promise<GoalStepResult> => {
      const bot = ctx.bot;
      let villager: { position?: { x: number; y: number; z: number } } | null = null;
      try {
        villager = bot.nearestEntity?.((e: { name?: string; type?: string }) => e.name === 'villager' || e.name === 'villager_v2') ?? null;
      } catch {
        villager = null;
      }
      if (!villager) {
        return { status: 'blocked', intensity: 2, reason: 'no villager nearby to trade with', context: { item: itemName } };
      }

      let window: { trades?: Array<{ output?: { name?: string }; firstInput?: { name?: string } }>; close?: () => void } | null = null;
      try {
        const v = await bot.openVillager?.(villager as never);
        window = v as unknown as { close?: () => void };
        const trades = (v as unknown as { trades?: Array<{ output?: { name?: string }; firstInput?: { name?: string } }> }).trades ?? [];
        const idx = trades.findIndex((t) => t.output?.name === itemName);
        if (idx < 0) {
          return { status: 'blocked', intensity: 2, reason: `villager has no ${itemName} trade`, context: { item: itemName } };
        }
        const before = countItemInInventory(bot, itemName);
        await (v as unknown as { trade: (i: number, times: number) => Promise<void> }).trade(idx, count);
        const after = countItemInInventory(bot, itemName);
        if (after <= before) {
          return { status: 'blocked', intensity: 2, reason: `trade for ${itemName} did not add to inventory`, context: { item: itemName } };
        }
        return { status: 'done', report: `traded with villager for ${itemName} x${after - before}` };
      } catch (err) {
        return {
          status: 'blocked',
          intensity: 2,
          reason: `failed to trade with villager: ${err instanceof Error ? err.message : String(err)}`,
          context: { item: itemName }
        };
      } finally {
        try {
          window?.close?.();
        } catch {
          // ignore
        }
      }
    }
  };
}

/**
 * Fallback: obtain an item from a nearby chest. Used when other sources fail,
 * weighted by utility.
 */
export function openChestStep(itemName: string, count: number): GoalStep {
  return {
    name: 'openChest',
    run: async (ctx: GoalContext): Promise<GoalStepResult> => {
      const bot = ctx.bot;
      const mcData = minecraftData(bot.version);
      const chestId = mcData.blocksByName.chest?.id;
      if (typeof chestId !== 'number') {
        return { status: 'blocked', intensity: 2, reason: 'cannot look up chest block', context: { item: itemName } };
      }
      let chest: { position?: { x: number; y: number; z: number } } | null = null;
      try {
        chest = bot.findBlock?.({ matching: chestId, maxDistance: 24 }) ?? null;
      } catch {
        chest = null;
      }
      if (!chest) {
        return { status: 'blocked', intensity: 2, reason: 'no chest nearby', context: { item: itemName } };
      }

      let window: { containerItems?: () => Array<{ name?: string; type?: number; count?: number }>; withdraw?: (...a: unknown[]) => Promise<void>; close?: () => void } | null = null;
      try {
        const c = await bot.openContainer?.(chest as never);
        window = c as unknown as { close?: () => void };
        const items = (c as unknown as { containerItems: () => Array<{ name?: string; type?: number; count?: number }> }).containerItems();
        const match = items.find((i) => i.name === itemName);
        if (!match || (match.count ?? 0) <= 0) {
          return { status: 'blocked', intensity: 2, reason: `no ${itemName} in chest`, context: { item: itemName } };
        }
        const before = countItemInInventory(bot, itemName);
        await (c as unknown as { withdraw: (t: number, m: unknown, n: number) => Promise<void> }).withdraw(match.type ?? 0, null, Math.min(count, match.count ?? count));
        const after = countItemInInventory(bot, itemName);
        if (after <= before) {
          return { status: 'blocked', intensity: 2, reason: `withdraw of ${itemName} did not add to inventory`, context: { item: itemName } };
        }
        return { status: 'done', report: `withdrew ${itemName} x${after - before} from chest` };
      } catch (err) {
        return {
          status: 'blocked',
          intensity: 2,
          reason: `failed to open/withdraw chest: ${err instanceof Error ? err.message : String(err)}`,
          context: { item: itemName }
        };
      } finally {
        try {
          window?.close?.();
        } catch {
          // ignore
        }
      }
    }
  };
}

/** Reuse the existing gatherItem primitive as a goal step with a tracked task-run. */
export function gatherItemStep(itemName: string, count: number, opts?: { dispatch?: PrimalDispatch }): GoalStep {
  return {
    name: 'gatherItem',
    run: async (ctx: GoalContext): Promise<GoalStepResult> => {
      const bot = ctx.bot;
      const id = ++lastTaskId;
      taskRuns.set(id, {
        id,
        kind: 'gather',
        description: `collect ${count} ${itemName}`,
        status: 'running',
        itemName,
        target: count,
        progress: `have 0/${count} ${itemName}`
      });

      let have = 0;
      try {
        // When a primal dispatcher is available, route the low-level gather
        // action through the hidden 'collect-item' tool (which invokes the
        // registered executor via callPrimal) rather than driving the bot
        // directly. If the hidden tool is not registered on the factory (e.g.
        // in a minimal test harness), the dispatch reports ok:false and we
        // fall back to the direct-bot path so behavior stays backward
        // compatible.
        if (opts?.dispatch) {
          const result = await opts.dispatch('collect-item', { itemName, count, maxAttempts: GATHER_ATTEMPTS });
          if (result.ok) {
            have = countItemInInventory(bot, itemName);
          } else {
            have = await gatherItem(bot, itemName, count, GATHER_ATTEMPTS);
          }
        } else {
          have = await gatherItem(bot, itemName, count, GATHER_ATTEMPTS);
        }
      } catch (err) {
        const run = taskRuns.get(id);
        if (run) {
          run.status = 'failed';
          run.error = err instanceof Error ? err.message : String(err);
          run.progress = `have ${have}/${count} ${itemName}`;
        }
        return {
          status: 'blocked',
          intensity: 3,
          reason: `gather failed: ${run?.error ?? 'unknown error'}`,
          context: { item: itemName, target: count, have }
        };
      }

      const run = taskRuns.get(id);
      if (run) {
        run.have = have;
        run.status = have >= count ? 'done' : 'running';
        run.progress = `have ${have}/${count} ${itemName}`;
      }

      if (have >= count) {
        return { status: 'done', report: `Gather goal complete: have ${have}/${count} ${itemName}.` };
      }
      // deterministic options exhausted: deepest blocked state -> NEED_DECISION
      return {
        status: 'blocked',
        intensity: 3,
        reason: `reached ${have}/${count} ${itemName}`,
        context: { item: itemName, target: count, have }
      };
    }
  };
}

/** Synchronously compute the ordered block plan for a template (shared by run-goal and buildStep). */
export function computeBuildPlan(opts: {
  templateName: string;
  anchor: { x: number; y: number; z: number };
  w?: number;
  d?: number;
}): { ok: true; steps: TaskStep[]; stages: TaskStage[] } | { ok: false; error: string } {
  try {
    const layout = generateTemplate(opts.templateName, { w: opts.w, d: opts.d });
    const built = buildSteps(layout, opts.anchor, resolvePalette());
    return { ok: true, steps: built.steps, stages: built.stages };
  } catch (err) {
    return {
      ok: false,
      error: `failed to build plan for ${opts.templateName}: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}

/** Create a build plan using the existing template + buildSteps machinery. */
export function buildStep(opts: {
  templateName: string;
  anchor: { x: number; y: number; z: number };
  w?: number;
  d?: number;
  taskId?: number;
}): GoalStep {
  return {
    name: 'build',
    run: async (_ctx: GoalContext): Promise<GoalStepResult> => {
      // If run-goal pre-created a TaskRun for this id, the background loop just
      // reports the start; the user advances the build with run-task-step.
      if (opts.taskId !== undefined && taskRuns.has(opts.taskId)) {
        return {
          status: 'done',
          report: `Started build goal ${opts.taskId}: building ${opts.templateName} at (${opts.anchor.x},${opts.anchor.y},${opts.anchor.z}). Execute with task-run-status / run-task-step.`
        };
      }

      const built = computeBuildPlan(opts);
      if (!built.ok) {
        return {
          status: 'blocked',
          intensity: 3,
          reason: built.error,
          context: { template: opts.templateName }
        };
      }

      const id = ++lastTaskId;
      taskRuns.set(id, {
        id,
        kind: 'build',
        description: `build ${opts.templateName} at (${opts.anchor.x},${opts.anchor.y},${opts.anchor.z})`,
        status: 'running',
        planId: id,
        template: opts.templateName,
        anchor: opts.anchor,
        steps: built.steps,
        progress: `0/${built.steps.length} blocks placed (stage: ${built.stages[0] ?? 'none'})`
      });
      return {
        status: 'done',
        report: `Started build goal ${id}: building ${opts.templateName} at (${opts.anchor.x},${opts.anchor.y},${opts.anchor.z}). Execute with task-run-status / run-task-step.`
      };
    }
  };
}

// ---------------------------------------------------------------------------
// L1 Homeostasis: day-phase & drive-aware goal planning (back brain)
// ---------------------------------------------------------------------------

/** Read the bot's time-of-day (0..24000 ticks), or undefined when unavailable. */
function readTimeOfDay(bot: mineflayer.Bot): number | undefined {
  try {
    const tod = (bot as { time?: { timeOfDay?: number } }).time?.timeOfDay;
    return typeof tod === 'number' ? tod : undefined;
  } catch {
    return undefined;
  }
}

/** The current day phase for the bot. Defaults to safe MIDDAY when time is unavailable. */
export function dayPhaseForBot(bot: mineflayer.Bot): DayPhase {
  return phaseFor(readTimeOfDay(bot) ?? 6000);
}

/** Distance to the nearest hostile mob, or Infinity when none is visible. */
function nearestHostileDist(bot: mineflayer.Bot): number {
  try {
    const hostile = (bot as { nearestEntity?: (f: (e: { type?: string; name?: string }) => boolean) => { position?: { x: number; y: number; z: number } } | null })
      .nearestEntity?.((e) => Boolean(e.type === 'mob' || (e.name && /zombie|skeleton|spider|creeper|slime/.test(e.name))));
    const p = bot.entity?.position;
    if (!hostile?.position || !p) return Infinity;
    const dx = p.x - hostile.position.x;
    const dy = p.y - hostile.position.y;
    const dz = p.z - hostile.position.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  } catch {
    return Infinity;
  }
}

function freeInventorySlots(bot: mineflayer.Bot): number {
  try {
    const items = bot.inventory?.items?.() ?? [];
    return Math.max(0, 36 - items.length);
  } catch {
    return 36;
  }
}

function heldToolDurability(bot: mineflayer.Bot): number {
  try {
    const held = (bot as { heldItem?: { durabilityUsed?: number; maxDurability?: number } }).heldItem;
    const max = held?.maxDurability;
    if (typeof max === 'number' && max > 0) {
      const used = typeof held?.durabilityUsed === 'number' ? held.durabilityUsed : 0;
      return Math.max(0, Math.min(1, 1 - used / max));
    }
  } catch {
    // fall through to full durability
  }
  return 1;
}

/**
 * Build the L1 drive input from live bot state and arbitrate across the drives.
 * Returns the drive decision (winner + ranked) so callers can act on the
 * dominant need. Defensive: missing bot state reads as "safe" (full bars).
 */
export function dominantDrive(bot: mineflayer.Bot): DriveDecision {
  const input: DriveInput = {
    health: (bot as { health?: number }).health,
    food: (bot as { food?: number }).food,
    oxygenLevel: (bot as { oxygenLevel?: number }).oxygenLevel,
    timeOfDay: readTimeOfDay(bot),
    nearestHostileDist: nearestHostileDist(bot),
    freeSlots: freeInventorySlots(bot),
    toolDurability: heldToolDurability(bot)
  };
  const drives = [
    healthDrive(input),
    hungerDrive(input),
    oxygenDrive(input),
    nightDrive(input),
    threatDrive(input),
    inventoryDrive(input),
    toolDrive(input)
  ];
  return arbitrate(drives);
}

/**
 * Return a food pre-step (make bread) when a dominant hunger/health need clearly
 * exceeds the urgency threshold and the planned goal is an unrelated long outdoor
 * task. Conservative: null unless clearly needed, so safe/window goals are untouched.
 */
function drivePreStep(bot: mineflayer.Bot): GoalStep | null {
  const winner = dominantDrive(bot).winner;
  if (!winner || winner.urgency <= 0.6) return null;
  if (winner.id === 'hunger' || winner.id === 'health') {
    return makeFoodStep('bread', 1);
  }
  // Oxygen has no deterministic pre-step available here — stay conservative.
  return null;
}

/** Dusk refusal message for an outdoor goal, or null when it is still safe to start. */
function duskRefusal(bot: mineflayer.Bot, goal: string): string | null {
  const timeOfDay = readTimeOfDay(bot);
  if (typeof timeOfDay !== 'number') return null; // unknown time — do not refuse
  // Only the pre-dusk / late-day window is at risk; the safe day window is untouched.
  if (!duskPreemptActive(timeOfDay)) return null;
  if (returnByDuskDeadline(timeOfDay, 10)) return null; // enough daylight left — safe window
  return `Too late in the day to start ${goal}; the dusk clock requires returning to base before nightfall (phase: ${phaseFor(timeOfDay)}).`;
}

/** Annotate a successful plan with the current day phase and rhythm recommendations. */
function annotateDayPhase(plan: Extract<GoalPlan, { ok: true }>, bot: mineflayer.Bot): GoalPlan {
  const phase = dayPhaseForBot(bot);
  return { ...plan, dayPhase: phase, suggestedActivities: suggestedActivities(phase) };
}

// ---------------------------------------------------------------------------
// Goal planning: turn free-text goal into an ordered GoalSpec
// ---------------------------------------------------------------------------

export interface GoalPlanOpts {
  template?: string;
  x?: number;
  y?: number;
  z?: number;
  w?: number;
  d?: number;
  target?: number;
  bot: mineflayer.Bot;
  /**
   * Optional handle for dispatching low-level actions through the hidden
   * 'primal' tools (via `callPrimal`). When provided, the built goal steps
   * route their micro-actions through it instead of driving the bot directly.
   * Backward compatible: omitted for direct-bot steps.
   */
  dispatch?: PrimalDispatch;
}

export type GoalPlan =
  | {
      ok: true;
      steps: GoalStep[];
      goalName: string;
      build?: { templateName: string; anchor: { x: number; y: number; z: number }; w?: number; d?: number };
      dayPhase?: string;
      suggestedActivities?: string[];
      mining?: { strategy: 'branch'; yLevels: number[]; plan: BranchMinePlan; spacing: number };
      exploration?: { recommended: string; ucbScore: number };
    }
  | { ok: false; error: string };

/** Build the UCB exploration annotation for a repeated gather/harvest goal. */
function explorationFor(goalName: string, recommended: string): { recommended: string; ucbScore: number } {
  const visits = goalVisitCounts.get(goalName) ?? 0;
  const ucbScore = 1.0 + ucbBonus(visits, 50, 2);
  goalVisitCounts.set(goalName, visits + 1);
  return { recommended, ucbScore };
}

/** Strip ore prefixes/suffixes (deepslate_*, *_ore) to get the base ore name. */
function oreBaseName(itemName: string): string {
  return itemName.toLowerCase().replace(/^(deepslate_|nether_)?(.*)_ore$/, '$2');
}

/** Build the branch-mining annotation for an ore collect goal. */
function branchMiningFor(
  bot: mineflayer.Bot,
  itemName: string
): { strategy: 'branch'; yLevels: number[]; plan: BranchMinePlan; spacing: number } {
  const pos = bot.entity?.position;
  const origin: BlockPos = pos
    ? { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }
    : { x: 0, y: 64, z: 0 };
  const yLevels = knownGoodLevels(oreBaseName(itemName));
  const plan = planBranchMine(origin);
  return { strategy: 'branch', yLevels, plan, spacing: DEFAULT_BRANCH_SPACING };
}

/**
 * Parse a goal sentence into an ordered list of goal steps. Steps are ordered so
 * dependencies resolve (e.g. crops -> bread -> deliver).
 */
export function planGoal(text: string, opts: GoalPlanOpts): GoalPlan {
  const lower = text.toLowerCase();

  if (lower.includes('build')) {
    let templateName = (opts.template ?? '').trim().toLowerCase();
    if (!templateName) {
      templateName = getTemplateNames().find(n => lower.includes(n)) ?? 'house';
    }
    if (!getTemplateNames().includes(templateName)) {
      return { ok: false, error: `Unknown template ${templateName}. Use list-templates.` };
    }

    let anchorX = 0;
    let anchorY = 64;
    let anchorZ = 0;
    try {
      const pos = opts.bot.entity?.position;
      if (pos) {
        anchorX = Math.floor(pos.x);
        anchorY = Math.floor(pos.y);
        anchorZ = Math.floor(pos.z);
      }
    } catch {
      // bot unavailable; fall back to a safe default anchor
    }
    const anchor = {
      x: opts.x !== undefined ? Math.floor(opts.x) : anchorX,
      y: opts.y !== undefined ? Math.floor(opts.y) : anchorY,
      z: opts.z !== undefined ? Math.floor(opts.z) : anchorZ
    };

    return annotateDayPhase({
      ok: true,
      goalName: `build ${templateName}`,
      steps: [buildStep({ templateName, anchor, w: opts.w, d: opts.d })],
      build: { templateName, anchor, w: opts.w, d: opts.d }
    }, opts.bot);
  }

  const wantsBread = lower.includes('bread');
  const wantsCrops = /crop|harvest|wheat/.test(lower);

  if (/(collect|gather)/.test(lower) && !wantsBread && !wantsCrops) {
    const parsed = lower.match(/(?:collect|gather)\s+(\d+)\s+([a-z_]+)/);
    const itemName = parsed ? parsed[2] : lower.replace(/^.*(?:collect|gather)\s+/, '').trim();
    const targetCount = opts.target ?? (parsed ? parseInt(parsed[1], 10) : 16);
    const sourceKey = SOURCE_BLOCKS[itemName] ? itemName : oreBaseName(itemName);
    if (!SOURCE_BLOCKS[sourceKey]) {
      return { ok: false, error: `No known source block for ${itemName}.` };
    }
    const goalName = `collect ${targetCount} ${itemName}`;
    const dusk = duskRefusal(opts.bot, goalName);
    if (dusk) return { ok: false, error: dusk };
    const steps: GoalStep[] = [];
    const pre = drivePreStep(opts.bot);
    if (pre) steps.push(pre);
    steps.push(gatherItemStep(itemName, targetCount, { dispatch: opts.dispatch }));
    const ok: Extract<GoalPlan, { ok: true }> = { ok: true, goalName, steps };
    if (knownGoodLevels(oreBaseName(itemName)).length > 0) {
      ok.mining = branchMiningFor(opts.bot, itemName);
    } else {
      ok.exploration = explorationFor(goalName, `continue to gather ${itemName}`);
    }
    return annotateDayPhase(ok, opts.bot);
  }

  if (wantsBread) {
    if (wantsCrops) {
      const dusk = duskRefusal(opts.bot, 'harvest crops and make bread');
      if (dusk) return { ok: false, error: dusk };
      const steps: GoalStep[] = [];
      const pre = drivePreStep(opts.bot);
      if (pre) steps.push(pre);
      steps.push(harvestCropsStep(), makeFoodStep('bread', 1), deliverItemStep('bread', 1));
      const ok: Extract<GoalPlan, { ok: true }> = { ok: true, goalName: 'harvest crops and make bread', steps };
      ok.exploration = explorationFor('harvest crops and make bread', 'continue harvesting crops for bread');
      return annotateDayPhase(ok, opts.bot);
    }
    // make bread (a no-op when bread already exists), then deliver it
    return annotateDayPhase({
      ok: true,
      goalName: 'make and deliver bread',
      steps: [makeFoodStep('bread', 1), deliverItemStep('bread', 1)]
    }, opts.bot);
  }

  if (wantsCrops) {
    const dusk = duskRefusal(opts.bot, 'harvest crops');
    if (dusk) return { ok: false, error: dusk };
    const steps: GoalStep[] = [];
    const pre = drivePreStep(opts.bot);
    if (pre) steps.push(pre);
    steps.push(harvestCropsStep());
    const ok: Extract<GoalPlan, { ok: true }> = { ok: true, goalName: 'harvest crops', steps };
    ok.exploration = explorationFor('harvest crops', 'continue harvesting crops');
    return annotateDayPhase(ok, opts.bot);
  }

  // Defensive: barricade against nearby enemies.
  if (lower.includes('barricade') || lower.includes('shield') || lower.includes('defend') || lower.includes('protect')) {
    return annotateDayPhase({ ok: true, goalName: 'barricade', steps: [barricadeStep()] }, opts.bot);
  }

  // Trade with a villager for an item.
  if (lower.includes('trade') || lower.includes('villager')) {
    const item = lower
      .replace(/^.*(?:trade|villager)\s+/, '')
      .trim()
      .replace(/\b(for|with|a|an|the|some|me|my)\b/g, '')
      .trim()
      .replace(/[^a-z_]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return annotateDayPhase({ ok: true, goalName: `trade for ${item || 'item'}`, steps: [tradeWithVillagerStep(item || 'bread', 1)] }, opts.bot);
  }

  // Get an item from a chest.
  if (lower.includes('chest')) {
    const item = lower
      .replace(/^.*(?:chest|from)\s+/, '')
      .trim()
      .replace(/\b(from|the|a|an|some|me)\b/g, '')
      .trim()
      .replace(/[^a-z_]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return annotateDayPhase({ ok: true, goalName: `get ${item || 'item'} from chest`, steps: [openChestStep(item || 'wheat', 1)] }, opts.bot);
  }

  // General deliver: "give/drop/gimme/hand <item>" (optional count). Delivers
  // the item already in inventory; if missing, escalates to the plan (blocked<3)
  // so the front brain can decide. Works for ANY item, not just food/bread.
  if (/give|drop|gimme|hand|deliver|pass/.test(lower)) {
    // Count prefix: "give 3 wood" / "drop 5 rotten flesh"
    const counted = lower.match(/(?:give|drop|gimme|hand|deliver|pass)\s+(\d+)\s+([a-z_ ]+)/);
    // Item word extraction: strip the verb + filler words
    const afterVerb = lower.replace(/^(?:please\s+)?(?:give|drop|gimme|hand|deliver|pass)(\s+(?:me|us|them))?\s+/, '');
    const itemNameRaw = counted ? counted[2] : afterVerb;
    const itemName = itemNameRaw
      .replace(/\b(some|a|an|any|the|my|your|of|that|those|these)\b/g, '')
      .trim()
      .replace(/[^a-z_]+/g, '_')
      .replace(/^_+|_+$/g, '');
    const count = counted ? parseInt(counted[1], 10) : 1;
    if (itemName && itemName.length > 0 && itemName !== 'me') {
      return annotateDayPhase({
        ok: true,
        goalName: `deliver ${count} ${itemName}`,
        steps: [deliverItemStep(itemName, count)]
      }, opts.bot);
    }
  }

  return {
    ok: false,
    error: `Unknown goal '${text}'. Supported: build <template>, collect <n> <item>, harvest <crop>, give/drop <item>, drop me some bread.`
  };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerTaskRunnerTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "run-goal",
    "Start a multi-step goal in the background with one command. Builds a deterministic plan and returns immediately with 'Started goal #<id>'. The goal auto-advances step-by-step; poll run-task-status for progress and advance builds with run-task-step. Supports 'build <template>', 'collect <n> <item>', 'harvest <crop>', 'drop me some bread' (deliver / make bread), and compound goals like 'get some crops and drop me some bread'. The goal pauses for your input when it blocks with no deterministic fallback (resolve with resolve-task).",
    {
      goal: z.string().describe("Goal to run, e.g. 'build a cottage', 'collect 32 wood', 'drop me some bread'"),
      template: z.string().optional().describe("Template name for build goals (default: house, or the template named in the goal)"),
      x: z.coerce.number().optional().describe("Anchor X for build goals (default: current bot position)"),
      y: z.coerce.number().optional().describe("Anchor Y for build goals (default: current bot position)"),
      z: z.coerce.number().optional().describe("Anchor Z for build goals (default: current bot position)"),
      w: z.coerce.number().optional().describe("Template width override"),
      d: z.coerce.number().optional().describe("Template depth override"),
      target: z.coerce.number().int().optional().describe("Gather target count (overrides the count parsed from the goal)"),
      autoAdvanceMs: z.coerce.number().int().optional().describe("Milliseconds between background goal steps (default: 1200)")
    },
    async ({ goal, template, x, y, z, w, d, target, autoAdvanceMs = 1200 }: {
      goal: string, template?: string, x?: number, y?: number, z?: number,
      w?: number, d?: number, target?: number, autoAdvanceMs?: number
    }) => {
      const text = goal.trim().toLowerCase();
      const bot = getBot();
      const plan = planGoal(text, {
        template, x, y, z, w, d, target, bot,
        dispatch: makePrimalDispatcher(factory)
      });

      if (!plan.ok) {
        return factory.createErrorResponse(plan.error);
      }

      let built: ReturnType<typeof computeBuildPlan> | undefined;
      let spec: GoalSpec;
      if (plan.build) {
        built = computeBuildPlan(plan.build);
        if (!built.ok) {
          return factory.createErrorResponse(built.error);
        }
        // Build goals start with an empty spec; the goal task's spec is populated
        // synchronously after startGoalRun (the runner sleeps before its first step).
        spec = { name: plan.goalName, steps: [] };
      } else {
        spec = { name: plan.goalName, steps: plan.steps };
      }

      const goalId = startGoalRun(bot, spec, plan.goalName, autoAdvanceMs);
      if (goalId < 0) {
        return factory.createErrorResponse('Bot is not available to start the goal.');
      }

      if (plan.build && built && built.ok) {
        const task: TaskRun = {
          id: goalId,
          kind: 'build',
          description: `build ${plan.build.templateName} at (${plan.build.anchor.x},${plan.build.anchor.y},${plan.build.anchor.z})`,
          status: 'running',
          planId: goalId,
          template: plan.build.templateName,
          anchor: plan.build.anchor,
          steps: built.steps,
          progress: `0/${built.steps.length} blocks placed (stage: ${built.stages[0] ?? 'none'})`
        };
        taskRuns.set(goalId, task);
        lastTaskId = goalId;
        const goalTask = statusOf(goalId);
        if (goalTask) {
          goalTask.spec = {
            name: plan.goalName,
            steps: [buildStep({ ...plan.build, taskId: goalId })]
          };
        }
      }

      return factory.createResponse(
        `Started goal #${goalId}: ${plan.goalName}. Running in the background (auto-advances step-by-step). Poll run-task-status for progress; it will pause for your input on BLOCKED/NEED_DECISION (resolve with resolve-task). Watchdog can pause it — resume with watchdog-resume.`
      );
    }
  );

  factory.registerTool(
    "run-task-status",
    "Show the summary of a task-run (or the last one): description, status, progress, and any error.",
    {
      id: z.coerce.number().int().optional().describe("Task-run id (defaults to the last created task)")
    },
    async ({ id }: { id?: number }) => {
      const task = resolveAnyTask(id);
      if (!task) {
        return factory.createErrorResponse('No task-run found. Start one with run-goal.');
      }

      const lines = [
        `Task ${task.id}: ${task.description}`,
        `Status: ${task.status}`,
        `Progress: ${'kind' in task ? buildProgress(task) : (task.lastReport ?? '')}`
      ];
      if (task.error) {
        lines.push(`Error: ${task.error}`);
      }
      return factory.createResponse(lines.join('\n'));
    }
  );

  factory.registerTool(
    "run-task-step",
    "Advance a running build goal by placing the next plan blocks. Executes up to `steps` blocks (default 5) and reports placement progress.",
    {
      id: z.coerce.number().int().optional().describe("Task-run id (defaults to the last created task)"),
      steps: z.coerce.number().int().optional().describe("Max blocks to place this call (default: 5)")
    },
    async ({ id, steps = 5 }: { id?: number, steps?: number }) => {
      const task = resolveAnyTask(id);
      if (!task) {
        return factory.createErrorResponse('No task-run found. Start one with run-goal.');
      }
      if (!('kind' in task) || task.kind !== 'build' || !task.steps) {
        return factory.createResponse(`Task ${task.id} is not a build goal.`);
      }

      const total = task.steps.length;
      if (task.steps.filter(s => s.status === 'placed').length >= total) {
        task.status = 'done';
        task.progress = `${total}/${total} blocks placed (stage: complete)`;
        return factory.createResponse(`Goal ${task.id} already complete.`);
      }

      const bot = getBot();
      const toExecute = task.steps.filter(s => s.status === 'pending').slice(0, Math.max(0, steps));

      let placed = 0;
      let failed = 0;
      try {
        for (const step of toExecute) {
          checkInterrupt();
          try {
            const result = await placeAt(bot, new Vec3(step.x, step.y, step.z), step.face);
            if (result.ok) {
              step.status = 'placed';
              placed++;
            } else {
              step.status = 'failed';
              step.reason = result.reason;
              failed++;
              break;
            }
          } catch (err) {
            step.status = 'failed';
            step.reason = err instanceof Error ? err.message : String(err);
            failed++;
            break;
          }
        }
      } catch (error) {
        if (isInterruptError(error)) {
          task.progress = buildProgress(task);
          return factory.createErrorResponse(`INTERRUPTED: ${getInterruptReason() ?? 'Action cancelled by watchdog'}`);
        }
        throw error;
      }

      const placedTotal = task.steps.filter(s => s.status === 'placed').length;
      task.progress = buildProgress(task);
      if (placedTotal >= total) {
        task.status = 'done';
      }
      return factory.createResponse(
        `Executed ${placed + failed} step(s): ${placed} placed, ${failed} failed. Progress: ${placedTotal}/${total} blocks.`
      );
    }
  );

  factory.registerTool(
    "abort-task",
    "Abort a task-run: mark it failed and clear any associated build plan.",
    {
      id: z.coerce.number().int().optional().describe("Task-run id (defaults to the last created task)")
    },
    async ({ id }: { id?: number }) => {
      abortRun(id);
      const task = resolveAnyTask(id);
      if (!task) {
        return factory.createErrorResponse(
          id !== undefined ? `Task ${id} not found.` : 'No task-run found. Start one with run-goal.'
        );
      }
      if ('kind' in task) {
        task.status = 'failed';
        task.error = 'aborted by user';
        task.planId = undefined;
        task.steps = undefined;
        task.progress = 'aborted';
      }
      return factory.createResponse(`Task ${task.id} aborted.`);
    }
  );

  factory.registerTool(
    "resolve-task",
    "Resolve a blocked background goal that is waiting for your input. Pass the instruction/direction and the goal resumes on its next step.",
    {
      id: z.coerce.number().int().optional().describe("Goal task id (defaults to the last created goal)"),
      instruction: z.string().describe("Your instruction/direction for the blocked goal")
    },
    async ({ id, instruction }: { id?: number, instruction: string }) => {
      const goal = statusOf(id);
      if (!goal) {
        return factory.createErrorResponse(
          id !== undefined ? `Goal #${id} not found.` : 'No goal task found.'
        );
      }
      if (goal.status !== 'awaiting-decision') {
        return factory.createErrorResponse(`Goal #${goal.id} is not awaiting a decision (status: ${goal.status}).`);
      }
      return factory.createResponse(resolveRun(goal.id, instruction));
    }
  );
}

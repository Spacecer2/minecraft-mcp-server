import { z } from "zod";
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { Vec3 } from 'vec3';
import { Block } from 'prismarine-block';
import minecraftData from 'minecraft-data';
import { ToolFactory } from '../tool-factory.js';
import { checkInterrupt, isInterruptError, getInterruptReason } from '../interrupt.js';
import { createGoalContext, executeGoal, GoalContext, GoalStep, GoalStepResult, GoalSpec } from '../goal-core.js';
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

export function resetTaskRuns(): void {
  taskRuns.clear();
  lastTaskId = 0;
}

function resolveTask(id?: number): TaskRun | undefined {
  if (id !== undefined) return taskRuns.get(id);
  if (lastTaskId > 0) return taskRuns.get(lastTaskId);
  return undefined;
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
        await gatherIngredient(bot, recipe.ingredient, neededIngredient - haveIngredient);
        haveIngredient = countItemInInventory(bot, recipe.ingredient);
        if (haveIngredient < neededIngredient) {
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

/** Reuse the existing gatherItem primitive as a goal step with a tracked task-run. */
export function gatherItemStep(itemName: string, count: number): GoalStep {
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
        have = await gatherItem(bot, itemName, count, GATHER_ATTEMPTS);
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

/** Create a build plan using the existing template + buildSteps machinery. */
export function buildStep(opts: {
  templateName: string;
  anchor: { x: number; y: number; z: number };
  w?: number;
  d?: number;
}): GoalStep {
  return {
    name: 'build',
    run: async (_ctx: GoalContext): Promise<GoalStepResult> => {
      let steps: TaskStep[] = [];
      let stages: TaskStage[] = [];
      try {
        const layout = generateTemplate(opts.templateName, { w: opts.w, d: opts.d });
        const built = buildSteps(layout, opts.anchor, resolvePalette());
        steps = built.steps;
        stages = built.stages;
      } catch (err) {
        return {
          status: 'blocked',
          intensity: 3,
          reason: `failed to build plan for ${opts.templateName}: ${err instanceof Error ? err.message : String(err)}`,
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
        steps,
        progress: `0/${steps.length} blocks placed (stage: ${stages[0] ?? 'none'})`
      });
      return {
        status: 'done',
        report: `Started build goal ${id}: building ${opts.templateName} at (${opts.anchor.x},${opts.anchor.y},${opts.anchor.z}). Execute with task-run-status / run-task-step.`
      };
    }
  };
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
}

export type GoalPlan =
  | { ok: true; steps: GoalStep[]; goalName: string }
  | { ok: false; error: string };

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

    return {
      ok: true,
      goalName: `build ${templateName}`,
      steps: [buildStep({ templateName, anchor, w: opts.w, d: opts.d })]
    };
  }

  const wantsBread = lower.includes('bread');
  const wantsCrops = /crop|harvest|wheat/.test(lower);

  if (/(collect|gather)/.test(lower) && !wantsBread && !wantsCrops) {
    const parsed = lower.match(/(?:collect|gather)\s+(\d+)\s+([a-z_]+)/);
    const itemName = parsed ? parsed[2] : lower.replace(/^.*(?:collect|gather)\s+/, '').trim();
    const targetCount = opts.target ?? (parsed ? parseInt(parsed[1], 10) : 16);
    if (!SOURCE_BLOCKS[itemName]) {
      return { ok: false, error: `No known source block for ${itemName}.` };
    }
    return {
      ok: true,
      goalName: `collect ${targetCount} ${itemName}`,
      steps: [gatherItemStep(itemName, targetCount)]
    };
  }

  if (wantsBread) {
    if (wantsCrops) {
      return {
        ok: true,
        goalName: 'harvest crops and make bread',
        steps: [harvestCropsStep(), makeFoodStep('bread', 1), deliverItemStep('bread', 1)]
      };
    }
    // make bread (a no-op when bread already exists), then deliver it
    return {
      ok: true,
      goalName: 'make and deliver bread',
      steps: [makeFoodStep('bread', 1), deliverItemStep('bread', 1)]
    };
  }

  if (wantsCrops) {
    return { ok: true, goalName: 'harvest crops', steps: [harvestCropsStep()] };
  }

  return {
    ok: false,
    error: `Unknown goal '${text}'. Supported: build <template>, collect <n> <item>, harvest <crop>, give/drop <food>.`
  };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerTaskRunnerTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "run-goal",
    "Start a multi-step goal with one command. Builds a deterministic plan and executes it step-by-step. Supports 'build <template>', 'collect <n> <item>', 'harvest <crop>', 'drop me some bread' (deliver / make bread), and compound goals like 'get some crops and drop me some bread'. If the plan blocks with no deterministic fallback it returns a BLOCKED/NEED_DECISION response with context. Track build progress with run-task-status and advance builds with run-task-step.",
    {
      goal: z.string().describe("Goal to run, e.g. 'build a cottage', 'collect 32 wood', 'drop me some bread'"),
      template: z.string().optional().describe("Template name for build goals (default: house, or the template named in the goal)"),
      x: z.coerce.number().optional().describe("Anchor X for build goals (default: current bot position)"),
      y: z.coerce.number().optional().describe("Anchor Y for build goals (default: current bot position)"),
      z: z.coerce.number().optional().describe("Anchor Z for build goals (default: current bot position)"),
      w: z.coerce.number().optional().describe("Template width override"),
      d: z.coerce.number().optional().describe("Template depth override"),
      target: z.coerce.number().int().optional().describe("Gather target count (overrides the count parsed from the goal)")
    },
    async ({ goal, template, x, y, z, w, d, target }: {
      goal: string, template?: string, x?: number, y?: number, z?: number,
      w?: number, d?: number, target?: number
    }) => {
      const text = goal.trim().toLowerCase();
      const bot = getBot();
      const plan = planGoal(text, { template, x, y, z, w, d, target, bot });

      if (!plan.ok) {
        return factory.createErrorResponse(plan.error);
      }

      const spec: GoalSpec = { name: plan.goalName, steps: plan.steps };
      const outcome = await executeGoal(createGoalContext(bot), spec);

      if (outcome.status === 'interrupted') {
        return factory.createErrorResponse(outcome.report);
      }

      if (outcome.status === 'blocked' && outcome.needDecision) {
        return factory.createResponse(
          `BLOCKED: ${outcome.needDecision.reason}. Context: ${JSON.stringify(outcome.needDecision.context)}. Direct me or call run-task-resume.`
        );
      }

      return factory.createResponse(outcome.report);
    }
  );

  factory.registerTool(
    "run-task-status",
    "Show the summary of a task-run (or the last one): description, status, progress, and any error.",
    {
      id: z.coerce.number().int().optional().describe("Task-run id (defaults to the last created task)")
    },
    async ({ id }: { id?: number }) => {
      const task = resolveTask(id);
      if (!task) {
        return factory.createErrorResponse('No task-run found. Start one with run-goal.');
      }

      const lines = [
        `Task ${task.id}: ${task.description}`,
        `Status: ${task.status}`,
        `Progress: ${buildProgress(task)}`
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
      const task = resolveTask(id);
      if (!task) {
        return factory.createErrorResponse('No task-run found. Start one with run-goal.');
      }
      if (task.kind !== 'build' || !task.steps) {
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
      const task = resolveTask(id);
      if (!task) {
        return factory.createErrorResponse(
          id !== undefined ? `Task ${id} not found.` : 'No task-run found. Start one with run-goal.'
        );
      }
      task.status = 'failed';
      task.error = 'aborted by user';
      task.planId = undefined;
      task.steps = undefined;
      task.progress = 'aborted';
      return factory.createResponse(`Task ${task.id} aborted.`);
    }
  );
}

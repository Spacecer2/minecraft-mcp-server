import { z } from "zod";
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { Vec3 } from 'vec3';
import { Block } from 'prismarine-block';
import minecraftData from 'minecraft-data';
import { ToolFactory } from '../tool-factory.js';
import { checkInterrupt, isInterruptError, getInterruptReason } from '../interrupt.js';
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

export function registerTaskRunnerTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "run-goal",
    "Start a multi-step goal with one command. Interprets the goal and orchestrates the underlying tools: build goals create a plan and gather goals collect resources. Track progress with run-task-status and advance builds with run-task-step.",
    {
      goal: z.string().describe("Goal to run, e.g. 'build a cottage', 'collect 32 wood'"),
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

      if (text.includes('build')) {
        let templateName = (template ?? '').trim().toLowerCase();
        if (!templateName) {
          templateName = getTemplateNames().find(n => text.includes(n)) ?? 'house';
        }
        if (!getTemplateNames().includes(templateName)) {
          return factory.createErrorResponse(`Unknown template ${templateName}. Use list-templates.`);
        }

        let anchorX = 0;
        let anchorY = 64;
        let anchorZ = 0;
        try {
          const pos = getBot().entity?.position;
          if (pos) {
            anchorX = Math.floor(pos.x);
            anchorY = Math.floor(pos.y);
            anchorZ = Math.floor(pos.z);
          }
        } catch {
          // bot unavailable; fall back to a safe default anchor
        }
        const anchor = {
          x: x !== undefined ? Math.floor(x) : anchorX,
          y: y !== undefined ? Math.floor(y) : anchorY,
          z: z !== undefined ? Math.floor(z) : anchorZ
        };

        let steps: TaskStep[] = [];
        let stages: TaskStage[] = [];
        try {
          const layout = generateTemplate(templateName, { w, d });
          const built = buildSteps(layout, anchor, resolvePalette());
          steps = built.steps;
          stages = built.stages;
        } catch (err) {
          return factory.createErrorResponse(
            `Failed to build plan for ${templateName}: ${err instanceof Error ? err.message : String(err)}`
          );
        }

        const id = ++lastTaskId;
        taskRuns.set(id, {
          id,
          kind: 'build',
          description: `build ${templateName} at (${anchor.x},${anchor.y},${anchor.z})`,
          status: 'running',
          planId: id,
          template: templateName,
          anchor,
          steps,
          progress: `0/${steps.length} blocks placed (stage: ${stages[0] ?? 'none'})`
        });
        return factory.createResponse(
          `Started build goal ${id}: building ${templateName} at (${anchor.x},${anchor.y},${anchor.z}). Execute with task-run-status / run-task-step.`
        );
      }

      if (text.includes('collect') || text.includes('gather')) {
        const parsed = text.match(/(\d+)\s+([a-z_]+)/);
        const itemName = (parsed ? parsed[2] : text.replace(/^.*(collect|gather)\s+/, '')).trim();
        const targetCount = target ?? (parsed ? parseInt(parsed[1], 10) : 16);

        if (!SOURCE_BLOCKS[itemName]) {
          return factory.createErrorResponse(`No known source block for ${itemName}.`);
        }

        const id = ++lastTaskId;
        taskRuns.set(id, {
          id,
          kind: 'gather',
          description: `collect ${targetCount} ${itemName}`,
          status: 'running',
          itemName,
          target: targetCount,
          progress: `have 0/${targetCount} ${itemName}`
        });

        let have = 0;
        try {
          have = await gatherItem(getBot(), itemName, targetCount, GATHER_ATTEMPTS);
        } catch (err) {
          const run = taskRuns.get(id);
          if (run) {
            run.status = 'failed';
            run.error = err instanceof Error ? err.message : String(err);
            run.progress = `have ${have}/${targetCount} ${itemName}`;
          }
          return factory.createResponse(`Gather goal failed: ${run?.error ?? 'unknown error'}.`);
        }

        const run = taskRuns.get(id);
        if (run) {
          run.have = have;
          run.status = 'done';
          run.progress = `have ${have}/${targetCount} ${itemName}`;
        }
        return factory.createResponse(`Gather goal complete: have ${have}/${targetCount} ${itemName}.`);
      }

      return factory.createErrorResponse(`Unknown goal '${goal}'. Supported: build <template>, collect <n> <item>.`);
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

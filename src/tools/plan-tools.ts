import { z } from "zod";
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';
import {
  generateTemplate,
  getTemplateNames,
  resolvePalette,
  blockNameForCode,
  TemplateLayout,
  TemplatePalette
} from './template-registry.js';

type FaceDirection = 'up' | 'down' | 'north' | 'south' | 'east' | 'west';

const FACE_OPTIONS: { direction: FaceDirection; vector: Vec3 }[] = [
  { direction: 'down', vector: new Vec3(0, -1, 0) },
  { direction: 'north', vector: new Vec3(0, 0, -1) },
  { direction: 'south', vector: new Vec3(0, 0, 1) },
  { direction: 'east', vector: new Vec3(1, 0, 0) },
  { direction: 'west', vector: new Vec3(-1, 0, 0) },
  { direction: 'up', vector: new Vec3(0, 1, 0) }
];

type PlanStage = 'foundation' | 'walls' | 'roof' | 'details';

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

interface PlanStep {
  id: number;
  blockName: string;
  x: number;
  y: number;
  z: number;
  face?: FaceDirection;
  stage: PlanStage;
  status: 'pending' | 'placed' | 'failed';
  reason?: string;
}

interface Plan {
  id: number;
  name: string;
  template: string;
  anchor: { x: number; y: number; z: number };
  stages: PlanStage[];
  steps: PlanStep[];
}

const plans = new Map<number, Plan>();
let lastPlanId = 0;

export function resetPlans(): void {
  plans.clear();
  lastPlanId = 0;
}

function stageForLayer(idx: number, layer: string[], totalLayers: number): PlanStage {
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
): { steps: PlanStep[]; stages: PlanStage[] } {
  const steps: PlanStep[] = [];
  const stageOrder: PlanStage[] = [];
  const seen = new Set<PlanStage>();
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

function resolvePlan(id?: number): Plan | undefined {
  if (id !== undefined) return plans.get(id);
  if (lastPlanId > 0) return plans.get(lastPlanId);
  return undefined;
}

export function registerPlanTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "plan-build",
    "Create a build plan from a template. Expands the template into an ordered list of absolute block steps anchored at (x,y,z), grouped into stages (foundation, walls, roof, details).",
    {
      name: z.string().describe("Plan name"),
      x: z.coerce.number().describe("Anchor X (front-bottom-left corner)"),
      y: z.coerce.number().describe("Anchor Y"),
      z: z.coerce.number().describe("Anchor Z (front-bottom-left corner)"),
      template: z.string().describe("Template name (see list-templates)"),
      w: z.coerce.number().optional().describe("Override width"),
      d: z.coerce.number().optional().describe("Override depth"),
      height: z.coerce.number().optional().describe("Override number of wall layers"),
      palette: z.record(z.string(), z.string()).optional().describe("Block palette overrides: wall, corner, roof, door, glass, porch")
    },
    async ({ name, x, y, z, template, w, d, height, palette }: {
      name: string, x: number, y: number, z: number, template: string,
      w?: number, d?: number, height?: number, palette?: Record<string, string>
    }) => {
      if (!getTemplateNames().includes(template)) {
        return factory.createErrorResponse(`Unknown template ${template}. Use list-templates.`);
      }
      const layout = generateTemplate(template, { w, d, height, palette });
      const pal = resolvePalette(palette);
      const anchor = { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
      const { steps, stages } = buildSteps(layout, anchor, pal);
      const planId = ++lastPlanId;
      plans.set(planId, { id: planId, name, template, anchor, stages, steps });
      return factory.createResponse(`Plan ${planId} created: ${steps.length} blocks across ${stages.length} stages.`);
    }
  );

  factory.registerTool(
    "plan-status",
    "Show the summary of a build plan (or the last plan): total blocks, how many placed, current stage, and the next steps to execute.",
    {
      id: z.coerce.number().int().optional().describe("Plan id (defaults to the last created plan)")
    },
    async ({ id }: { id?: number }) => {
      const plan = resolvePlan(id);
      if (!plan) {
        return factory.createErrorResponse('No plan found. Create one with plan-build.');
      }

      const placed = plan.steps.filter(s => s.status === 'placed').length;
      const pending = plan.steps.filter(s => s.status === 'pending').length;
      const failed = plan.steps.filter(s => s.status === 'failed').length;
      const currentStage = plan.stages.find(stage => plan.steps.some(s => s.stage === stage && s.status === 'pending'))
        ?? 'complete';

      const lines = [
        `Plan ${plan.id}: ${plan.name} (${plan.template}) at (${plan.anchor.x},${plan.anchor.y},${plan.anchor.z})`,
        `Total: ${plan.steps.length} blocks (${placed} placed, ${pending} pending${failed ? `, ${failed} failed` : ''})`,
        `Stages: ${plan.stages.map(stage => `${stage} (${plan.steps.filter(s => s.stage === stage).length})`).join(', ')}`,
        `Current stage: ${currentStage}`,
        'Next steps:'
      ];

      const next = plan.steps.filter(s => s.status === 'pending').slice(0, 10);
      if (next.length === 0) {
        lines.push('  none');
      } else {
        for (const step of next) {
          lines.push(`  #${step.id} ${step.blockName} at (${step.x},${step.y},${step.z}) [${step.stage}]`);
        }
      }
      return factory.createResponse(lines.join('\n'));
    }
  );

  factory.registerTool(
    "execute-plan",
    "Systematically place the next unplaced blocks of a build plan. Executes up to `steps` blocks (default 8), optionally restricted to one stage, and stops that batch on the first failure.",
    {
      id: z.coerce.number().int().optional().describe("Plan id (defaults to the last created plan)"),
      steps: z.coerce.number().int().optional().describe("Max blocks to place this call (default: 8)"),
      stage: z.enum(['foundation', 'walls', 'roof', 'details']).optional().describe("Only execute blocks from this stage")
    },
    async ({ id, steps = 8, stage }: { id?: number, steps?: number, stage?: PlanStage }) => {
      const plan = resolvePlan(id);
      if (!plan) {
        return factory.createErrorResponse('No plan found. Create one with plan-build.');
      }

      const bot = getBot();
      let candidates = plan.steps.filter(s => s.status === 'pending');
      if (stage !== undefined) {
        candidates = candidates.filter(s => s.stage === stage);
      }
      const toExecute = candidates.slice(0, Math.max(0, steps));

      let placed = 0;
      let failed = 0;
      for (const step of toExecute) {
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
      }

      const remaining = plan.steps.filter(s => s.status === 'pending').length;
      return factory.createResponse(`Executed ${placed + failed} step(s): ${placed} placed, ${failed} failed. Next: ${remaining} remaining.`);
    }
  );

  factory.registerTool(
    "abort-plan",
    "Clear a build plan (or all plans if no id given).",
    {
      id: z.coerce.number().int().optional().describe("Plan id to clear (omit to clear all plans)")
    },
    async ({ id }: { id?: number }) => {
      if (id !== undefined) {
        if (!plans.delete(id)) {
          return factory.createErrorResponse(`Plan ${id} not found.`);
        }
        if (lastPlanId === id) {
          lastPlanId = 0;
        }
        return factory.createResponse(`Plan ${id} aborted and cleared.`);
      }
      plans.clear();
      lastPlanId = 0;
      return factory.createResponse('All plans aborted and cleared.');
    }
  );
}

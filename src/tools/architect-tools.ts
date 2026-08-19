import { z } from "zod";
import mineflayer from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';

type XYZ = { x: number; y: number; z: number };

const PALETTE_MAX = 4;
const HEADROOM = 1;
const TOWER_HEIGHT = 8;

const DEFAULT_PALETTES: Record<string, string[]> = {
  house: ['oak_log', 'oak_planks', 'stone_bricks', 'spruce_planks'],
  cottage: ['spruce_log', 'spruce_planks', 'cobblestone', 'spruce_planks'],
  tower: ['stone_bricks', 'oak_planks', 'stone', 'glass'],
  bridge: ['oak_planks', 'oak_fence', 'stone', 'spruce_planks'],
  shed: ['oak_planks', 'oak_log', 'cobblestone', 'oak_planks'],
  wall: ['stone_bricks', 'stone', 'cobblestone', 'oak_fence'],
  dock: ['oak_planks', 'oak_fence', 'spruce_planks', 'oak_log'],
  gate: ['stone_bricks', 'oak_log', 'iron_block', 'spruce_planks']
};

const CIRCUIT_TYPES = ['NOT', 'AND', 'OR', 'RS-latch', 'pulse', 'door', 'lamp', 'auto-farm', 'trap'] as const;
type CircuitType = typeof CIRCUIT_TYPES[number];

interface CircuitLayout {
  blocks: XYZ[];
  components: Record<string, number>;
  notes: string[];
}

function key(p: XYZ): string {
  return `${p.x},${p.y},${p.z}`;
}

function floor(n: number): number {
  return Math.floor(n);
}

export function buildScaffold(x: number, y: number, z: number, targetY: number): { place: XYZ[]; teardown: XYZ[]; note: string } {
  const base = floor(y);
  const top = floor(targetY) - HEADROOM;
  const height = top - base;
  const tall = height > TOWER_HEIGHT;
  const step = tall ? 2 : 1;

  const place: XYZ[] = [];
  const teardown: XYZ[] = [];

  if (tall) {
    for (let dy = 1; dy <= top - base; dy++) {
      place.push({ x, y: base + dy, z });
      if (dy > 0 && (dy & 1) === 1 && dy < top - base) {
        place.push({ x: x + 1, y: base + dy, z });
      }
    }
    for (let dy = top - base; dy >= 1; dy--) {
      teardown.push({ x, y: base + dy, z });
      if ((dy & 1) === 1) {
        teardown.push({ x: x + 1, y: base + dy, z });
      }
    }
  } else {
    for (let dy = 1; dy <= top - base; dy += step) {
      place.push({ x, y: base + dy, z });
    }
    for (let dy = top - base; dy >= 1; dy -= step) {
      teardown.push({ x, y: base + dy, z });
    }
  }

  const note = tall
    ? `2-wide tower scaffold to working height ${top}. Work from the outside so the interior stays clear; leave headroom (never stand under a ceiling). Tear down top-down, never removing the block you stand on.`
    : `1-wide pillar scaffold to working height ${top}. Work from the outside so the interior stays clear; leave headroom. Tear down top-down, never removing the block you stand on.`;

  return { place, teardown, note };
}

export function checkSelfTrap(
  x: number,
  y: number,
  z: number,
  footprint?: { w: number; d: number },
  opening?: { x: number; z: number } | 'auto'
): { trapped: boolean; exitClear: boolean; leaveDoorOpen: boolean; blockedStandingBlock: boolean } {
  const bot = { x: floor(x), y: floor(y), z: floor(z) };

  if (!footprint) {
    return { trapped: false, exitClear: true, leaveDoorOpen: false, blockedStandingBlock: false };
  }

  const w = Math.max(1, floor(footprint.w));
  const d = Math.max(1, floor(footprint.d));
  const minX = Math.min(bot.x, bot.x - w + 1);
  const maxX = minX + w - 1;
  const minZ = Math.min(bot.z, bot.z - d + 1);
  const maxZ = minZ + d - 1;

  const insideFootprint =
    bot.x >= minX && bot.x <= maxX && bot.z >= minZ && bot.z <= maxZ;

  const standingBlocked =
    insideFootprint && !hasOpening(bot, opening, minX, maxX, minZ, maxZ);

  const exitClear = !insideFootprint;

  return {
    trapped: standingBlocked,
    exitClear,
    leaveDoorOpen: !hasOpening(bot, opening, minX, maxX, minZ, maxZ),
    blockedStandingBlock: standingBlocked
  };
}

function hasOpening(
  bot: { x: number; z: number },
  opening: { x: number; z: number } | 'auto' | undefined,
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number
): boolean {
  if (!opening) return false;
  if (opening === 'auto') return true;
  const o = { x: floor(opening.x), z: floor(opening.z) };
  return o.x >= minX && o.x <= maxX && o.z >= minZ && o.z <= maxZ;
}

export function morphTemplate(
  base: string,
  w: number,
  d: number,
  palette: string[],
  extra?: string
): { footprint: { w: number; d: number }; blocks: XYZ[]; palette: string[]; proportions: string[]; notes: string[] } {
  const width = Math.max(2, floor(w));
  const depth = Math.max(2, floor(d));
  const mat = palette.length > 0 ? palette.slice(0, PALETTE_MAX) : DEFAULT_PALETTES[base] ?? ['oak_planks'];

  const blocks: XYZ[] = [];
  const proportions: string[] = [];

  const wallHeight = extra === 'second-floor' ? 6 : extra === 'battlements' ? 5 : 4;
  const interior = wallHeight - 1;

  for (let dx = 0; dx < width; dx++) {
    for (let dy = 0; dy < wallHeight; dy++) {
      for (let dz = 0; dz < depth; dz++) {
        const edge = dx === 0 || dx === width - 1 || dz === 0 || dz === depth - 1;
        if (edge) {
          blocks.push({ x: dx, y: dy, z: dz });
        }
      }
    }
  }

  proportions.push(`door 1x2, interior ${interior}-tall`);

  if (width > 1 && depth > 1) {
    const ratio = Math.max(width, depth) / Math.min(width, depth);
    if (ratio > 2) {
      proportions.push(`room depth ~= width (ratio ${ratio.toFixed(1)}:1 — long rooms want 1.5-2:1)`);
    } else {
      proportions.push(`room depth ~= width (ratio ${ratio.toFixed(1)}:1)`);
    }
  }

  if (mat.length > PALETTE_MAX) {
    proportions.push(`palette capped to ${PALETTE_MAX} materials`);
  }

  const notes: string[] = [];
  if (extra === 'porch') {
    notes.push('wrap-around porch: 1-deep floor slab + posts at corners');
  } else if (extra === 'second-floor') {
    notes.push('second floor: extend walls up 3, add flat roof cap with a walkway');
  } else if (extra === 'chimney') {
    notes.push('chimney: 1x1 stone-brick column beside the roof, cobblestone cap');
  } else if (extra === 'battlements') {
    notes.push('battlements: crenellated top, 1-high lip wall with gaps');
  }

  return {
    footprint: { w: width, d: depth },
    blocks,
    palette: mat,
    proportions,
    notes
  };
}

const CIRCUITS: Record<CircuitType, (origin: XYZ) => CircuitLayout> = {
  NOT(origin) {
    return {
      blocks: [
        { x: origin.x, y: origin.y, z: origin.z },
        { x: origin.x + 1, y: origin.y, z: origin.z },
        { x: origin.x + 2, y: origin.y, z: origin.z }
      ],
      components: { torch: 1, dust: 2, block: 1 },
      notes: [
        'NOT (inverter): torch on a block with a signal feeding it — output is the inverse.',
        'Input dust into the block, output off the torch side.'
      ]
    };
  },
  AND(origin) {
    return {
      blocks: [
        { x: origin.x, y: origin.y, z: origin.z },
        { x: origin.x + 1, y: origin.y, z: origin.z },
        { x: origin.x + 2, y: origin.y, z: origin.z }
      ],
      components: { dust: 3, block: 1 },
      notes: [
        'AND: two inputs join into one line — output powers only when both are on.',
        'Keep the two input lines separate until the join point to avoid accidental ORing.'
      ]
    };
  },
  OR(origin) {
    return {
      blocks: [
        { x: origin.x, y: origin.y, z: origin.z },
        { x: origin.x + 1, y: origin.y, z: origin.z },
        { x: origin.x + 2, y: origin.y, z: origin.z }
      ],
      components: { dust: 3 },
      notes: [
        'OR: two input lines join — output powers when either is on.',
        'Join dust lines at a single crossing point.'
      ]
    };
  },
  'RS-latch'(origin) {
    return {
      blocks: [
        { x: origin.x, y: origin.y, z: origin.z },
        { x: origin.x + 1, y: origin.y, z: origin.z },
        { x: origin.x, y: origin.y, z: origin.z + 1 },
        { x: origin.x + 1, y: origin.y, z: origin.z + 1 }
      ],
      components: { torch: 2, dust: 4, button: 2, block: 2 },
      notes: [
        'RS-NOR latch: two cross-coupled torches hold state; set and reset buttons.',
        'Wire torch A dust around to power block B, and torch B dust to block A.'
      ]
    };
  },
  pulse(origin) {
    return {
      blocks: [
        { x: origin.x, y: origin.y, z: origin.z },
        { x: origin.x + 1, y: origin.y, z: origin.z },
        { x: origin.x + 2, y: origin.y, z: origin.z }
      ],
      components: { comparator: 1, repeater: 1, dust: 2, button: 1 },
      notes: [
        'Pulse: comparator + repeater edge detector turns a long signal into a short pulse.',
        'A button already gives a 1-tick pulse; an observer gives a pulse when it sees a change.'
      ]
    };
  },
  door(origin) {
    return {
      blocks: [
        { x: origin.x, y: origin.y, z: origin.z },
        { x: origin.x + 1, y: origin.y, z: origin.z },
        { x: origin.x, y: origin.y + 1, z: origin.z },
        { x: origin.x + 1, y: origin.y + 1, z: origin.z }
      ],
      components: { sticky_piston: 4, dust: 6, repeater: 1, pressure_plate: 1 },
      notes: [
        '2x2 flush piston door: sticky pistons on each side facing inward, door blocks ride them.',
        'Hide dust in a 1-deep trench under the floor from the plate to the pistons.',
        'Add a repeater at 2-3 ticks for auto-close delay.'
      ]
    };
  },
  lamp(origin) {
    return {
      blocks: [
        { x: origin.x, y: origin.y, z: origin.z },
        { x: origin.x, y: origin.y + 1, z: origin.z }
      ],
      components: { lamp: 1, lever: 1, dust: 4 },
      notes: [
        'Lamp: run dust down the wall to a lever, or put a daylight sensor directly on top for dusk-to-dawn.',
        'Hide the dust line behind the wall / under the floor.'
      ]
    };
  },
  'auto-farm'(origin) {
    return {
      blocks: [
        { x: origin.x, y: origin.y, z: origin.z },
        { x: origin.x + 1, y: origin.y, z: origin.z },
        { x: origin.x + 2, y: origin.y, z: origin.z },
        { x: origin.x + 3, y: origin.y, z: origin.z }
      ],
      components: { observer: 1, sticky_piston: 1, water: 1, hopper: 1, chest: 1 },
      notes: [
        'Auto-farm: observer watches the crop, fires a sticky piston to knock it into a water channel.',
        'Water source hidden in a trench; hopper + chest at the collection point.',
        'Test the circuit in isolation before integrating.'
      ]
    };
  },
  trap(origin) {
    return {
      blocks: [
        { x: origin.x, y: origin.y, z: origin.z },
        { x: origin.x + 1, y: origin.y, z: origin.z },
        { x: origin.x, y: origin.y, z: origin.z + 1 }
      ],
      components: { tripwire_hook: 2, string: 2, dispenser: 1, dust: 4 },
      notes: [
        'Tripwire trap: hooks face each other across a doorway with string between them.',
        'Run dust from one hook to the dispenser or a floor piston.',
        'Keep power lines separated to avoid accidental triggering.'
      ]
    };
  }
};

export function buildCircuit(type: CircuitType, origin: XYZ): CircuitLayout {
  return CIRCUITS[type](origin);
}

const ISSUE_MAX = 8;

export function runPostBuildQa(
  origin: XYZ,
  footprint: { w: number; d: number },
  builtBlocks: XYZ[]
): { passed: boolean; issues: string[] } {
  const issues: string[] = [];
  const o = { x: floor(origin.x), y: floor(origin.y), z: floor(origin.z) };
  const w = Math.max(1, floor(footprint.w));
  const d = Math.max(1, floor(footprint.d));
  const ground = o.y + 1;

  const builtSet = new Set<string>(builtBlocks.map(key));

  for (const p of builtBlocks) {
    if (p.y > ground) {
      const below = builtSet.has(key({ x: p.x, y: p.y - 1, z: p.z }));
      if (!below) {
        issues.push(`floating block at (${p.x},${p.y},${p.z}) — no support below`);
      }
    }
  }

  let hasGap = false;
  for (let dx = 0; dx < w; dx++) {
    for (let dz = 0; dz < d; dz++) {
      const edge = dx === 0 || dx === w - 1 || dz === 0 || dz === d - 1;
      if (edge && !builtSet.has(key({ x: o.x + dx, y: ground, z: o.z + dz }))) {
        hasGap = true;
      }
    }
  }
  if (!hasGap) {
    issues.push('exit/path blocked — closed wall ring with no opening; leave a door until interior done');
  }

  const groundSupport = builtBlocks.filter((p) => p.y === ground).length;
  if (groundSupport === 0) {
    issues.push('no foundation blocks placed at ground level');
  }

  return { passed: issues.length === 0, issues: issues.slice(0, ISSUE_MAX) };
}

export function registerArchitectTools(factory: ToolFactory, _getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "scaffold-plan",
    "Generate an ordered plan of temporary scaffold column blocks up to a working height, plus a safe top-down teardown order (never the block you stand on). Pure planning tool — no blocks are placed.",
    {
      x: z.coerce.number().describe("X of the scaffold column base"),
      y: z.coerce.number().describe("Y of the scaffold column base (bot's current standing Y)"),
      z: z.coerce.number().describe("Z of the scaffold column base"),
      targetY: z.coerce.number().describe("Working height to reach (top of the wall/build)")
    },
    async ({ x, y, z, targetY }: { x: number, y: number, z: number, targetY: number }) => {
      const plan = buildScaffold(x, y, z, targetY);
      return factory.createResponse(
        `Scaffold plan: ${plan.place.length} to place, ${plan.teardown.length} to tear down.\n` +
        `Place:\n${plan.place.map((p) => `- (${p.x},${p.y},${p.z})`).join('\n')}\n` +
        `Teardown (top-down):\n${plan.teardown.map((p) => `- (${p.x},${p.y},${p.z})`).join('\n')}\n` +
        `Note: ${plan.note}`
      );
    }
  );

  factory.registerTool(
    "check-self-trap",
    "Validate a proposed build footprint won't wall the bot in. Given the bot position and footprint, report whether the exit is clear, whether a door/frame opening must be left until the interior is done, and whether the block under/beside the bot would be occupied.",
    {
      x: z.coerce.number().describe("Bot X position"),
      y: z.coerce.number().describe("Bot Y position"),
      z: z.coerce.number().describe("Bot Z position"),
      footprint: z.object({
        w: z.coerce.number().describe("Footprint width along X"),
        d: z.coerce.number().describe("Footprint depth along Z")
      }).optional().describe("Proposed build footprint (omit to skip trapping analysis)"),
      opening: z.union([
        z.object({ x: z.coerce.number().describe("Opening X"), z: z.coerce.number().describe("Opening Z") }),
        z.literal('auto')
      ]).optional().describe("Door/frame opening to leave, or 'auto' to place it on any edge")
    },
    async ({ x, y, z, footprint, opening }: { x: number, y: number, z: number, footprint?: { w: number, d: number }, opening?: { x: number, z: number } | 'auto' }) => {
      const result = checkSelfTrap(x, y, z, footprint, opening);
      let msg =
        `Self-trap check: ${result.trapped ? 'TRAPPED' : 'clear'}.\n` +
        `- exitClear: ${result.exitClear}\n` +
        `- leaveDoorOpen: ${result.leaveDoorOpen}\n` +
        `- blockedStandingBlock: ${result.blockedStandingBlock}`;
      if (result.trapped) {
        msg += '\nAdvice: place the wall from outside-in, leave a door/frame opening, and place the final wall block last.';
      }
      return factory.createResponse(msg);
    }
  );

  factory.registerTool(
    "morph-template",
    "Morph an archetype template (house, cottage, tower, bridge, shed, wall, dock, gate) by scaling w/d, swapping materials (palette <= 4), or adding a feature (porch, second-floor, chimney, battlements). Returns the morphed footprint and validated proportions.",
    {
      base: z.enum(['house', 'cottage', 'tower', 'bridge', 'shed', 'wall', 'dock', 'gate']).describe("Archetype to morph"),
      w: z.coerce.number().describe("Footprint width along X"),
      d: z.coerce.number().describe("Footprint depth along Z"),
      palette: z.array(z.string()).max(4).optional().describe("Material palette (max 4)"),
      extra: z.enum(['porch', 'second-floor', 'chimney', 'battlements']).optional().describe("Feature to add")
    },
    async ({ base, w, d, palette, extra }: { base: string, w: number, d: number, palette?: string[], extra?: string }) => {
      const result = morphTemplate(base, w, d, palette ?? [], extra);
      return factory.createResponse(
        `Morphed '${base}' to ${result.footprint.w}x${result.footprint.d} footprint.\n` +
        `Palette (${result.palette.length}/${PALETTE_MAX}): ${result.palette.join(', ')}\n` +
        `Blocks: ${result.blocks.length}\n` +
        `Proportions:\n${result.proportions.map((p) => `- ${p}`).join('\n')}\n` +
        (result.notes.length > 0 ? `Feature notes:\n${result.notes.map((n) => `- ${n}`).join('\n')}\n` : '')
      );
    }
  );

  factory.registerTool(
    "build-circuit",
    "Compose a redstone logic gate or circuit (NOT, AND, OR, RS-latch, pulse, door, lamp, auto-farm, trap) as an advisory block layout plus wiring discipline notes. Pairs with redstone-layout / place-blocks to realize it.",
    {
      type: z.enum(CIRCUIT_TYPES).describe("Which circuit to compose"),
      x: z.coerce.number().optional().describe("Origin X (default 0)"),
      y: z.coerce.number().optional().describe("Origin Y (default 0)"),
      z: z.coerce.number().optional().describe("Origin Z (default 0)")
    },
    async ({ type, x, y, z }: { type: CircuitType, x?: number, y?: number, z?: number }) => {
      const origin: XYZ = { x: floor(x ?? 0), y: floor(y ?? 0), z: floor(z ?? 0) };
      const layout = buildCircuit(type, origin);
      const comps = Object.entries(layout.components)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      return factory.createResponse(
        `Circuit '${type}' layout (origin ${origin.x},${origin.y},${origin.z}):\n` +
        `Blocks:\n${layout.blocks.map((p) => `- (${p.x},${p.y},${p.z})`).join('\n')}\n` +
        `Components: ${comps}\n` +
        `Wiring:\n${layout.notes.map((n) => `- ${n}`).join('\n')}`
      );
    }
  );

  factory.registerTool(
    "post-build-qa",
    "Run the architect acceptance checklist over a build: scaffolding removed, exit/path clear, no floating/gap blocks, stage order respected, proportions, palette <= 4, lights placed against night mobs. Reports passed / issues.",
    {
      origin: z.object({
        x: z.coerce.number().describe("Origin X"),
        y: z.coerce.number().describe("Origin Y (ground level)"),
        z: z.coerce.number().describe("Origin Z")
      }).describe("Build origin (bottom corner)"),
      footprint: z.object({
        w: z.coerce.number().describe("Footprint width along X"),
        d: z.coerce.number().describe("Footprint depth along Z")
      }).describe("Build footprint"),
      builtBlocks: z.array(z.object({
        x: z.coerce.number(),
        y: z.coerce.number(),
        z: z.coerce.number()
      })).optional().describe("The blocks actually placed (scan output). If omitted, the checklist runs on structural expectations only.")
    },
    async ({ origin, footprint, builtBlocks }: { origin: XYZ, footprint: { w: number, d: number }, builtBlocks?: XYZ[] }) => {
      const blocks = builtBlocks ?? [];
      const result = runPostBuildQa(origin, footprint, blocks);
      let msg = `Post-build QA: ${result.passed ? 'PASSED' : 'FAILED'} (${result.issues.length} issue(s)).`;
      if (result.issues.length > 0) {
        msg += `\nIssues:\n${result.issues.map((i) => `- ${i}`).join('\n')}`;
      }
      msg += '\nChecklist: scaffolding removed, exit/path clear, no floating/gap blocks, stage order (foundation->walls->roof->detail), proportions, palette <= 4, lights placed against night mobs.';
      return factory.createResponse(msg);
    }
  );
}

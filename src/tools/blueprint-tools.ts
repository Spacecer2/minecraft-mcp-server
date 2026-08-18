import { z } from "zod";
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';

type FaceDirection = 'up' | 'down' | 'north' | 'south' | 'east' | 'west';

const FACE_OPTIONS: { direction: FaceDirection; vector: Vec3 }[] = [
  { direction: 'down', vector: new Vec3(0, -1, 0) },
  { direction: 'north', vector: new Vec3(0, 0, -1) },
  { direction: 'south', vector: new Vec3(0, 0, 1) },
  { direction: 'east', vector: new Vec3(1, 0, 0) },
  { direction: 'west', vector: new Vec3(-1, 0, 0) },
  { direction: 'up', vector: new Vec3(0, 1, 0) }
];

const MAX_FAILURES_LISTED = 5;

type RedstoneType = 'door' | 'lamp' | 'trap' | 'piston' | 'rsswitch' | 'auto-farm';

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

const REDSTONE_LAYOUTS: Record<RedstoneType, string> = {
  door: [
    'Redstone Door (2x2 flush piston door)',
    'Required components:',
    '  - 4 sticky pistons (2 per side: lower + upper)',
    '  - 8 solid blocks (door frame / door, e.g. smooth_stone)',
    '  - ~6 redstone dust',
    '  - 1 repeater (optional, for auto-close delay)',
    '  - 1 pressure plate or button',
    '',
    'Side view (cross-section, 2-wide opening):',
    '        [P]            <- pressure plate on the floor beside the door',
    '  [frame][frame][frame] <- upper frame',
    '  [piston]  [piston]    <- sticky pistons face inward',
    '  [frame][frame]        <- door blocks ride the pistons',
    '  [redstone trench]     <- dust under the floor: plate -> pistons',
    '',
    'How to build:',
    '  1. Leave a 2-wide x 2-tall opening for the door.',
    '  2. Place a sticky piston at each vertical side, facing inward.',
    '  3. Attach the door blocks (bottom + top) to the pistons.',
    '  4. Dig a 1-deep trench under the floor from the trigger to the pistons and lay redstone dust.',
    '  5. Put the pressure plate (or button) on the floor beside the door.',
    '  6. For auto-close, add a repeater set to 2-3 ticks in the dust line.'
  ].join('\n'),

  lamp: [
    'Redstone Lamp',
    'Required components:',
    '  - 1 redstone lamp',
    '  - 1 lever (or a daylight sensor)',
    '  - ~4 redstone dust',
    '',
    'Side view:',
    '      [lamp]         <- lamp where you want light',
    '        |',
    '      [dust]         <- run dust down the wall',
    '        |',
    '     [lever]         <- at reach height',
    '',
    'How to build:',
    '  1. Place the redstone lamp on the wall or ceiling.',
    '  2. Run a vertical redstone dust line down to a lever.',
    '  3. Flip the lever to toggle the lamp.',
    '  4. Alternative: put a daylight sensor directly on the lamp\'s top face for dusk-to-dawn lighting (no wiring needed).'
  ].join('\n'),

  trap: [
    'Redstone Tripwire Trap',
    'Required components:',
    '  - 2 tripwire hooks',
    '  - 1-2 string (spans the doorway)',
    '  - 1 dispenser (arrows) or 1 sticky piston (floor trap)',
    '  - ~4 redstone dust',
    '',
    'Top view across a 2-wide doorway:',
    '  [hook]--string--string--[hook]',
    '     |                          |',
    '   [dispenser]              [piston floor]',
    '',
    'How to build:',
    '  1. Place a tripwire hook on each side of the doorway, facing each other, at the same height (shin level).',
    '  2. Lay string between the hooks to complete the tripwire circuit.',
    '  3. Run redstone dust from one hook down to the dispenser or the floor piston.',
    '  4. When a mob walks through, the tripwire fires and the device triggers.'
  ].join('\n'),

  piston: [
    'Redstone Sticky Piston',
    'Required components:',
    '  - 1 sticky piston',
    '  - 1 lever (or a button for a 1-tick pulse)',
    '  - ~3 redstone dust',
    '',
    'Side view:',
    '  [sticky piston] --> [block to push/pull]',
    '         |',
    '        [dust]',
    '         |',
    '       [lever]',
    '',
    'How to build:',
    '  1. Aim the sticky piston at the block you want to move.',
    '  2. Run redstone dust from the piston\'s rear face down to a lever.',
    '  3. Flip the lever to extend; flip it off and the sticky piston pulls the block back.',
    '  4. For a push-only 1-tick pulse, use a button or a redstone tick-loop instead of the lever.'
  ].join('\n'),

  rsswitch: [
    'Redstone RS-NOR Latch (set/reset switch)',
    'Required components:',
    '  - 2 redstone torches',
    '  - 2 buttons (set + reset)',
    '  - 2 solid blocks',
    '  - ~4 redstone dust',
    '',
    'Plan view (the two torches are cross-coupled):',
    '       block A           block B',
    '    [torch A]          [torch B]',
    '        |                  |',
    '  [dust + S button]  [dust + R button]',
    '',
    'ASCII (front):',
    '    [torch B]   [dust -> R button]',
    '    [dust -> S button]   [torch A]',
    '',
    'How to build:',
    '  1. Put two solid blocks side by side and place a torch on the outer face of each.',
    '  2. Wire torch A\'s dust around to power block B, and torch B\'s dust around to power block A (the cross-feed).',
    '  3. Put the S (set) button on A\'s dust line and the R (reset) button on B\'s dust line.',
    '  4. The two torches can never both be on — the latch holds its state. Tap the output off either dust run.'
  ].join('\n'),

  'auto-farm': [
    'Redstone Auto-Farm (crop harvester)',
    'Required components:',
    '  - 1 observer',
    '  - 1 sticky piston',
    '  - 1 water source block + a flowing water channel',
    '  - 1 hopper + chest (collection)',
    '  - crops to plant in the row',
    '',
    'Layout (side view):',
    '   [observer] <- watches the crop',
    '       |',
    '   [piston] -> [crop] [water channel] [hopper -> chest]',
    '',
    'Plan:',
    '  [water source] --- flowing channel ---> [collection point]',
    '                                         [hopper] -> [chest]',
    '',
    'How to build:',
    '  1. Plant a row of crops; leave the last cell as the collection point.',
    '  2. Put an observer behind the crop, facing it, and wire it to a sticky piston beside the crop.',
    '  3. When a crop matures, the observer fires and the piston knocks the crop into the water channel.',
    '  4. The water carries the drops to the collection point where a hopper pulls them into a chest.'
  ].join('\n')
};

export function registerBlueprintTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "build-from-grid",
    "Build a 2D blueprint layer from a grid of character codes mapped through a palette. Each row string is one horizontal row (all rows must be the same length); the '.' char always means air (skipped). Each cell is placed at (originX + col, originY, originZ + row) using reference-block placement with verify-after-write.",
    {
      rows: z.array(z.string()).min(1).max(64).describe("Each string is one horizontal row; all rows must be the same length"),
      palette: z.record(z.string(), z.string()).describe("Maps each char code to a block name, e.g. {'W':'oak_planks','C':'oak_log','G':'glass'}. The '.' char always means air regardless of the palette."),
      originX: z.coerce.number().describe("X of the front-bottom-left anchor corner (row[0][0])"),
      originY: z.coerce.number().describe("Y of the layer"),
      originZ: z.coerce.number().describe("Z of the front-bottom-left anchor corner (row[0][0])"),
      layerHeight: z.coerce.number().optional().describe("Reserved vertical spacing between stacked layers; the blueprint is built as a single 2D layer")
    },
    async ({ rows, palette, originX, originY, originZ }: { rows: string[], palette: Record<string, string>, originX: number, originY: number, originZ: number }) => {
      const bot = getBot();

      const rowLength = rows[0].length;
      for (const row of rows) {
        if (row.length !== rowLength) {
          throw new Error('Blueprint rows must have equal length.');
        }
      }

      for (const row of rows) {
        for (const char of row) {
          if (char === '.') continue;
          if (palette[char] === undefined) {
            throw new Error(`Unknown block code '${char}' in palette.`);
          }
        }
      }

      let placed = 0;
      let failed = 0;
      let skipped = 0;
      const failures: string[] = [];

      for (let r = 0; r < rows.length; r++) {
        for (let c = 0; c < rows[r].length; c++) {
          const char = rows[r][c];
          if (char === '.' || palette[char] === 'air') {
            skipped++;
            continue;
          }
          const pos = new Vec3(originX + c, originY, originZ + r).floored();
          const result = await placeAt(bot, pos);
          if (result.ok) {
            placed++;
          } else {
            failed++;
            failures.push(`couldn't place (${pos.x},${pos.y},${pos.z}): ${result.reason}`);
          }
        }
      }

      let msg = `Blueprint built: ${placed} placed, ${failed} failed, ${skipped} air cells.`;
      if (failures.length > 0) {
        const shown = failures.slice(0, MAX_FAILURES_LISTED);
        const extra = failures.length > MAX_FAILURES_LISTED ? ` (and ${failures.length - MAX_FAILURES_LISTED} more)` : '';
        msg += `\nFailures: ${shown.join('; ')}${extra}`;
      }
      return factory.createResponse(msg);
    }
  );

  factory.registerTool(
    "redstone-layout",
    "Return a human-readable redstone build layout / recipe for a common redstone contraption. Advisory only — pairs with build-from-grid or place-blocks to realize it.",
    {
      type: z.enum(['door', 'lamp', 'trap', 'piston', 'rsswitch', 'auto-farm']).describe("Which redstone build to describe"),
      size: z.coerce.number().int().optional().describe("Scale for size-dependent layouts (default: 3)")
    },
    async ({ type, size }: { type: RedstoneType, size?: number }) => {
      const scale = size ?? 3;
      const layout = REDSTONE_LAYOUTS[type];
      return factory.createResponse(`${layout}\n\nScale note: size=${scale} — for size-dependent builds (door width, farm length) scale the component counts accordingly.`);
    }
  );
}

import { z } from "zod";
import type mineflayer from 'mineflayer';
import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';
import { resolveItem, formatAmbiguousMatch } from './inventory-tools.js';

const CONTAINER_NAMES = [
  'chest',
  'trapped_chest',
  'barrel',
  'shulker_box',
  'ender_chest',
  'hopper',
  'dispenser',
  'dropper'
];

const DEFAULT_MAX_DISTANCE = 16;

interface ContainerItem {
  name: string;
  count: number;
  slot: number;
  type: number;
  metadata?: number;
}

interface WindowLike {
  items(): ContainerItem[];
}

type BlockLike = NonNullable<ReturnType<mineflayer.Bot['findBlock']>>;

interface FoundContainer {
  block: BlockLike;
  name: string;
}

function findContainerBlock(
  bot: mineflayer.Bot,
  requestedType: string,
  maxDistance: number
): FoundContainer | null {
  const mcData = minecraftData(bot.version);
  const blocksByName = mcData.blocksByName ?? {};
  const candidate = requestedType.trim().toLowerCase();
  const name = CONTAINER_NAMES.includes(candidate) ? candidate : 'chest';
  const blockId = blocksByName[name]?.id;
  if (blockId === undefined) return null;

  const block = bot.findBlock({ matching: blockId, maxDistance });
  if (!block) return null;
  return { block, name };
}

function readContainerItems(window: WindowLike): ContainerItem[] {
  const w = window as WindowLike & { containerItems?: () => ContainerItem[] };
  if (typeof w.containerItems === 'function') {
    return w.containerItems();
  }
  return window.items();
}

function formatPosition(position: Vec3): string {
  return `(${position.x}, ${position.y}, ${position.z})`;
}

function windowErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerContainerTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "find-container",
    "Find the nearest container block (chest, trapped chest, barrel, shulker box, ender chest, hopper, dispenser, dropper)",
    {
      type: z.string().optional().describe("Type of container to find (default: 'chest')"),
      maxDistance: z.coerce.number().finite().optional().describe("Maximum search distance (default: 16)")
    },
    async ({ type = 'chest', maxDistance = DEFAULT_MAX_DISTANCE }) => {
      const bot = getBot();
      const found = findContainerBlock(bot, type, maxDistance);
      if (!found) {
        return factory.createResponse(`No ${type} within ${maxDistance} blocks`);
      }
      return factory.createResponse(`Found ${found.name} at ${formatPosition(found.block.position)}`);
    }
  );

  factory.registerTool(
    "deposit-item",
    "Deposit an item from the bot's inventory into a nearby container",
    {
      itemName: z.string().describe("Name of the item to deposit"),
      count: z.coerce.number().int().positive().optional().describe("Number of items to deposit (default: 1)"),
      containerType: z.string().optional().describe("Type of container to deposit into (default: 'chest')")
    },
    async ({ itemName, count = 1, containerType = 'chest' }) => {
      const bot = getBot();
      const items = bot.inventory.items();
      const resolved = resolveItem(items, itemName);

      if (resolved.kind === 'ambiguous') {
        return factory.createResponse(formatAmbiguousMatch(itemName, resolved.matches));
      }
      if (resolved.kind === 'none') {
        return factory.createErrorResponse(`Item '${itemName}' is not in the bot's inventory`);
      }

      const found = findContainerBlock(bot, containerType, DEFAULT_MAX_DISTANCE);
      if (!found) {
        return factory.createErrorResponse(`No ${containerType} container found nearby`);
      }

      const window = await bot.openContainer(found.block);
      try {
        const available = items
          .filter((item) => item.name === resolved.item.name)
          .reduce((sum, item) => sum + item.count, 0);
        const toDeposit = Math.min(count, available);
        await window.deposit(resolved.item.type, resolved.item.metadata ?? null, toDeposit);
        return factory.createResponse(
          `Deposited ${toDeposit} ${resolved.item.name} into ${found.name} at ${formatPosition(found.block.position)}`
        );
      } catch (err) {
        return factory.createErrorResponse(`Failed to deposit into ${found.name}: ${windowErrorMessage(err)}`);
      } finally {
        window.close();
      }
    }
  );

  factory.registerTool(
    "withdraw-item",
    "Withdraw an item from a nearby container into the bot's inventory",
    {
      itemName: z.string().describe("Name of the item to withdraw"),
      count: z.coerce.number().int().positive().optional().describe("Number of items to withdraw (default: 1)"),
      containerType: z.string().optional().describe("Type of container to withdraw from (default: 'chest')")
    },
    async ({ itemName, count = 1, containerType = 'chest' }) => {
      const bot = getBot();
      const found = findContainerBlock(bot, containerType, DEFAULT_MAX_DISTANCE);
      if (!found) {
        return factory.createErrorResponse(`No ${containerType} container found nearby`);
      }

      const window = await bot.openContainer(found.block);
      try {
        const contents = readContainerItems(window);
        const resolved = resolveItem(contents, itemName);

        if (resolved.kind === 'ambiguous') {
          return factory.createResponse(formatAmbiguousMatch(itemName, resolved.matches));
        }
        if (resolved.kind === 'none') {
          return factory.createErrorResponse(`Item '${itemName}' not found in ${found.name} container`);
        }

        const available = contents
          .filter((item) => item.name === resolved.item.name)
          .reduce((sum, item) => sum + item.count, 0);
        const toWithdraw = Math.min(count, available);
        await window.withdraw(resolved.item.type, resolved.item.metadata ?? null, toWithdraw);
        return factory.createResponse(
          `Withdrew ${toWithdraw} ${resolved.item.name} from ${found.name} at ${formatPosition(found.block.position)}`
        );
      } catch (err) {
        return factory.createErrorResponse(`Failed to withdraw from ${found.name}: ${windowErrorMessage(err)}`);
      } finally {
        window.close();
      }
    }
  );

  factory.registerTool(
    "open-container",
    "Open a container and list its contents",
    {
      x: z.coerce.number().optional().describe("X coordinate (optional; nearest container is used if omitted)"),
      y: z.coerce.number().optional().describe("Y coordinate (optional; nearest container is used if omitted)"),
      z: z.coerce.number().optional().describe("Z coordinate (optional; nearest container is used if omitted)"),
      containerType: z.string().optional().describe("Type of container to open (default: 'chest')")
    },
    async ({ x, y, z, containerType = 'chest' }) => {
      const bot = getBot();
      let block: BlockLike | null = null;

      if (x !== undefined && y !== undefined && z !== undefined) {
        const atPos = bot.blockAt(new Vec3(x, y, z).floored());
        if (atPos && atPos.name !== 'air') {
          block = atPos;
        }
      }

      if (!block) {
        const found = findContainerBlock(bot, containerType, DEFAULT_MAX_DISTANCE);
        if (!found) {
          return factory.createErrorResponse(`No ${containerType} container found nearby`);
        }
        block = found.block;
      }

      const window = await bot.openContainer(block);
      try {
        const contents = readContainerItems(window);
        const header = `Container ${containerType} at ${formatPosition(block.position)}`;

        if (contents.length === 0) {
          return factory.createResponse(`${header} is empty`);
        }

        const lines = contents.map((item) => `- ${item.name} x${item.count}`);
        return factory.createResponse(`${header}:\n${lines.join('\n')}`);
      } catch (err) {
        return factory.createErrorResponse(`Failed to open container: ${windowErrorMessage(err)}`);
      } finally {
        window.close();
      }
    }
  );

  factory.registerTool(
    "organize-inventory",
    "Report a consolidated view of the bot's inventory (grouped by item name)",
    {},
    async () => {
      const bot = getBot();
      const items = bot.inventory.items();

      if (items.length === 0) {
        return factory.createResponse("Inventory is empty");
      }

      const groups = new Map<string, number>();
      for (const item of items) {
        groups.set(item.name, (groups.get(item.name) ?? 0) + item.count);
      }

      const lines = [...groups.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, total]) => `- ${name}: ${total}`);

      return factory.createResponse(`Inventory (${items.length} stacks, ${groups.size} distinct):\n${lines.join('\n')}`);
    }
  );

  factory.registerTool(
    "activate-block",
    "Activate a block (buttons, levers, doors, chests, furnaces, note blocks) at a position",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate")
    },
    async ({ x, y, z }) => {
      const bot = getBot();
      const block = bot.blockAt(new Vec3(x, y, z).floored());

      if (!block || block.name === 'air') {
        return factory.createErrorResponse(`No block found at (${x}, ${y}, ${z})`);
      }

      try {
        await bot.activateBlock(block);
      } catch (err) {
        return factory.createErrorResponse(
          `Block ${block.name} at (${x}, ${y}, ${z}) is not activatable: ${windowErrorMessage(err)}`
        );
      }

      return factory.createResponse(`Activated ${block.name} at (${x}, ${y}, ${z})`);
    }
  );

  factory.registerTool(
    "use-item-on",
    "Use the held (or specified) item on a block, an entity, or report what is held",
    {
      itemName: z.string().optional().describe("Name of the item to use (best-effort equips it first)"),
      entityType: z.string().optional().describe("Type of entity to use the item on"),
      x: z.coerce.number().optional().describe("X coordinate of a block to use the item on"),
      y: z.coerce.number().optional().describe("Y coordinate of a block to use the item on"),
      z: z.coerce.number().optional().describe("Z coordinate of a block to use the item on")
    },
    async ({ itemName, entityType, x, y, z }) => {
      const bot = getBot();

      if (itemName) {
        try {
          const items = bot.inventory.items();
          const resolved = resolveItem(items, itemName);
          if (resolved.kind === 'exact') {
            await bot.equip(resolved.item, 'hand');
          }
        } catch {
          // best-effort: if equipping fails, fall through with whatever is held
        }
      }

      const heldName = bot.heldItem?.name ?? 'nothing';

      if (x !== undefined && y !== undefined && z !== undefined) {
        const block = bot.blockAt(new Vec3(x, y, z).floored());
        if (!block || block.name === 'air') {
          return factory.createErrorResponse(`No block found at (${x}, ${y}, ${z})`);
        }
        try {
          await bot.activateBlock(block);
        } catch (err) {
          return factory.createErrorResponse(
            `Failed to use ${heldName} on ${block.name}: ${windowErrorMessage(err)}`
          );
        }
        return factory.createResponse(`Used ${heldName} on ${block.name} at (${x}, ${y}, ${z})`);
      }

      if (entityType) {
        const entity = bot.nearestEntity((e) => {
          if (entityType === 'player') return e.type === 'player';
          if (entityType === 'mob') return e.type === 'mob';
          const name = e.name || e.mobType || e.type || '';
          return name.toLowerCase().includes(entityType.toLowerCase());
        });
        if (!entity) {
          return factory.createErrorResponse(`No ${entityType} entity found nearby`);
        }
        const entityName = entity.name || entity.mobType || entity.type || 'entity';
        try {
          bot.useOn(entity);
        } catch (err) {
          return factory.createErrorResponse(`Failed to use ${heldName} on ${entityName}: ${windowErrorMessage(err)}`);
        }
        return factory.createResponse(`Used ${heldName} on ${entityName}`);
      }

      return factory.createResponse(`Held item: ${heldName}`);
    }
  );
}

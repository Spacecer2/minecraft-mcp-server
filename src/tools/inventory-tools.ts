import { z } from "zod";
import mineflayer from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';

interface InventoryItem {
  name: string;
  count: number;
  slot: number;
}

export type ResolveItemResult<T extends { name: string }> =
  | { kind: 'exact'; item: T }
  | { kind: 'ambiguous'; matches: string[] }
  | { kind: 'none' };

export function resolveItem<T extends { name: string }>(items: T[], query: string): ResolveItemResult<T> {
  const q = query.trim().toLowerCase();
  const exact = items.find((item) => item.name.toLowerCase() === q);
  if (exact) return { kind: 'exact', item: exact };

  const partial = items.filter((item) => item.name.toLowerCase().includes(q));
  if (partial.length > 1) {
    return { kind: 'ambiguous', matches: partial.map((item) => item.name) };
  }
  if (partial.length === 1) {
    return { kind: 'exact', item: partial[0] };
  }
  return { kind: 'none' };
}

export function formatAmbiguousMatch(query: string, matches: string[]): string {
  return `Ambiguous match for '${query}'. Matches: ${matches.join(', ')}. Please specify the exact name.`;
}

export function registerInventoryTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "list-inventory",
    "List all items in the bot's inventory",
    {},
    async () => {
      const bot = getBot();
      const items = bot.inventory.items();
      const itemList: InventoryItem[] = items.map((item) => ({
        name: item.name,
        count: item.count,
        slot: item.slot
      }));

      if (items.length === 0) {
        return factory.createResponse("Inventory is empty");
      }

      let inventoryText = `Found ${items.length} items in inventory:\n\n`;
      itemList.forEach(item => {
        inventoryText += `- ${item.name} (x${item.count}) in slot ${item.slot}\n`;
      });

      return factory.createResponse(inventoryText);
    }
  );

  factory.registerTool(
    "find-item",
    "Find a specific item in the bot's inventory",
    {
      nameOrType: z.string().describe("Name or type of item to find")
    },
    async ({ nameOrType }) => {
      const bot = getBot();
      const items = bot.inventory.items();
      const resolved = resolveItem(items, nameOrType);

      if (resolved.kind === 'ambiguous') {
        return factory.createResponse(formatAmbiguousMatch(nameOrType, resolved.matches));
      }

      if (resolved.kind === 'none') {
        return factory.createResponse(`Couldn't find any item matching '${nameOrType}' in inventory`);
      }

      const item = resolved.item;
      return factory.createResponse(`Found ${item.count} ${item.name} in inventory (slot ${item.slot})`);
    }
  );

  factory.registerTool(
    "equip-item",
    "Equip a specific item",
    {
      itemName: z.string().describe("Name of the item to equip"),
      destination: z.string().optional().describe("Where to equip the item (default: 'hand')")
    },
    async ({ itemName, destination = 'hand' }) => {
      const bot = getBot();
      const items = bot.inventory.items();
      const resolved = resolveItem(items, itemName);

      if (resolved.kind === 'ambiguous') {
        return factory.createResponse(formatAmbiguousMatch(itemName, resolved.matches));
      }

      if (resolved.kind === 'none') {
        return factory.createResponse(`Couldn't find any item matching '${itemName}' in inventory`);
      }

      const item = resolved.item;
      await bot.equip(item, destination as mineflayer.EquipmentDestination);
      return factory.createResponse(`Equipped ${item.name} to ${destination}`);
    }
  );
}

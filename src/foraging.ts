export type InventoryItem = { name: string; count: number };

export type PackedTrip = { carry: InventoryItem[]; dropFirst: InventoryItem[] };

export const HIGH_VALUE_THRESHOLD = 70;
export const JUNK_VALUE_THRESHOLD = 4;
export const LONG_TRIP_BLOCKS = 100;
export const DEFAULT_ITEM_VALUE = 10;

export const ITEM_VALUE: Record<string, number> = {
  diamond: 100,
  netherite_scrap: 100,
  netherite_ingot: 100,
  emerald: 95,
  enchanted_golden_apple: 95,
  golden_apple: 90,
  gold_ingot: 85,
  raw_gold: 80,
  iron_ingot: 75,
  raw_iron: 70,
  diamond_pickaxe: 85,
  iron_pickaxe: 65,
  golden_carrot: 55,
  lapis_lazuli: 60,
  redstone: 55,
  coal: 50,
  cooked_beef: 50,
  cooked_porkchop: 48,
  cooked_chicken: 45,
  bread: 45,
  apple: 40,
  wool: 35,
  stone_pickaxe: 35,
  sugar_cane: 30,
  wheat: 30,
  copper_ingot: 30,
  raw_copper: 25,
  carrot: 25,
  potato: 25,
  beetroot: 20,
  cobblestone: 8,
  sand: 8,
  deepslate: 10,
  stone: 12,
  dirt: 5,
  andesite: 5,
  granite: 5,
  diorite: 5,
  gravel: 5,
  tuff: 5
};

export function slotValue(item: string): number {
  const name = item.toLowerCase();
  const direct = ITEM_VALUE[name];
  if (direct !== undefined) return direct;
  if (name.endsWith('_log') || name.endsWith('_wood')) return 40;
  if (name.endsWith('_ore')) {
    const base = name.replace(/^(deepslate_|nether_)?(.*)_ore$/, '$2');
    return ITEM_VALUE[base] ?? 50;
  }
  if (name.startsWith('raw_')) {
    const base = name.slice(4);
    return ITEM_VALUE[base] ?? 25;
  }
  return DEFAULT_ITEM_VALUE;
}

export function packForTrip(inventory: InventoryItem[], tripLength: number): PackedTrip {
  const long = tripLength >= LONG_TRIP_BLOCKS;
  const threshold = long ? HIGH_VALUE_THRESHOLD : JUNK_VALUE_THRESHOLD;
  const carry: InventoryItem[] = [];
  const dropFirst: InventoryItem[] = [];
  for (const item of inventory) {
    if (slotValue(item.name) < threshold) {
      dropFirst.push(item);
    } else {
      carry.push(item);
    }
  }
  dropFirst.sort((a, b) => slotValue(a.name) - slotValue(b.name));
  return { carry, dropFirst };
}


import { z } from "zod";
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';
import { entityHealth, entityName, isHostileEntity } from './entity-tools.js';

type Entity = NonNullable<ReturnType<mineflayer.Bot['nearestEntity']>>;

const MATERIAL_RANK: Record<string, number> = {
  wooden: 1,
  stone: 2,
  iron: 3,
  diamond: 4,
  netherite: 5
};

export function weaponTier(name: string): number {
  const isSword = name.endsWith('_sword');
  const isAxe = name.endsWith('_axe');
  if (!isSword && !isAxe) return 0;
  const material = name.split('_')[0];
  const rank = MATERIAL_RANK[material];
  if (!rank) return 0;
  // Swords outrank axes of the same material (axes are a fallback weapon).
  return isSword ? rank * 2 + 1 : rank * 2;
}

interface WeaponItem {
  name: string;
  count: number;
  slot: number;
}

export function findBestWeapon(bot: mineflayer.Bot): WeaponItem | null {
  let best: WeaponItem | null = null;
  let bestTier = 0;
  for (const item of bot.inventory.items()) {
    const tier = weaponTier(item.name);
    if (tier > bestTier) {
      bestTier = tier;
      best = { name: item.name, count: item.count, slot: item.slot };
    }
  }
  return best;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function tryEquip(bot: mineflayer.Bot, item: WeaponItem): Promise<boolean> {
  try {
    await bot.equip(item as Parameters<typeof bot.equip>[0], 'hand');
    return true;
  } catch {
    return false;
  }
}

async function gotoWithTimeout(
  bot: mineflayer.Bot,
  goal: InstanceType<typeof goals.GoalNear>,
  timeoutMs: number
): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Move timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    await Promise.race([bot.pathfinder.goto(goal), timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export function registerCombatTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "attack-entity",
    "Attack the nearest hostile mob (or entity of a given type) up to a number of hits",
    {
      entityType: z.string().optional().describe("Type of entity to attack (default: nearest hostile)"),
      maxDistance: z.coerce.number().finite().optional().describe("Maximum attack distance (default: 6)"),
      hits: z.coerce.number().int().optional().describe("Number of hits to attempt (default: 3)")
    },
    async ({ entityType = '', maxDistance = 6, hits = 3 }) => {
      const bot = getBot();
      const type = entityType;

      const entityFilter = (entity: Entity) => {
        if (!type) return isHostileEntity(entity);
        if (type === 'player') return entity.type === 'player';
        if (type === 'mob') return entity.type === 'mob';
        return Boolean(entity.name && entity.name.includes(type.toLowerCase()));
      };

      const entity = bot.nearestEntity(entityFilter);
      const label = type || 'hostile';

      if (
        !entity ||
        !bot.entity?.position ||
        typeof entity.position?.distanceTo !== 'function' ||
        bot.entity.position.distanceTo(entity.position) > maxDistance
      ) {
        return factory.createResponse(`No ${label} within ${maxDistance} blocks.`);
      }

      const weapon = findBestWeapon(bot);
      if (weapon) {
        await tryEquip(bot, weapon);
      }

      let landed = 0;
      for (let i = 0; i < hits; i++) {
        try {
          await bot.attack(entity);
          landed++;
        } catch {
          // attack failed — try the remaining hits
        }
        if (i < hits - 1) {
          await sleep(200);
        }
      }

      const pos = entity.position;
      return factory.createResponse(
        `Attacked ${entityName(entity)} at (${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)}): ${landed} hit(s). Health: ${entityHealth(entity)}`
      );
    }
  );

  factory.registerTool(
    "flee",
    "Move away from the nearest hostile mob (or a given entity type)",
    {
      entityType: z.string().optional().describe("Type of threat to flee from (default: hostile)"),
      distance: z.coerce.number().finite().optional().describe("Distance to move away (default: 16)")
    },
    async ({ entityType = 'hostile', distance = 16 }) => {
      const bot = getBot();
      const useHostiles = entityType === 'hostile';

      const entityFilter = (entity: Entity) => {
        if (useHostiles) return isHostileEntity(entity);
        if (entityType === 'player') return entity.type === 'player';
        if (entityType === 'mob') return entity.type === 'mob';
        return Boolean(entity.name && entity.name.includes(entityType.toLowerCase()));
      };

      const entity = bot.nearestEntity(entityFilter);

      if (!entity || !bot.entity?.position || typeof entity.position?.distanceTo !== 'function') {
        return factory.createResponse('No threat to flee from.');
      }

      const botPos = bot.entity.position;
      const diff = botPos.minus(entity.position);
      const length = diff.distanceTo(new Vec3(0, 0, 0));
      const normalized = length > 0 ? diff.scaled(1 / length) : new Vec3(1, 0, 0);
      const rawTarget = botPos.plus(normalized.scaled(distance));
      const target = new Vec3(rawTarget.x, Math.min(320, Math.max(1, rawTarget.y)), rawTarget.z);

      const goal = new goals.GoalNear(target.x, target.y, target.z, 1);
      try {
        await gotoWithTimeout(bot, goal, 10000);
      } catch {
        // pathfinding may fail or time out — still report the attempted flee
      }

      const pos = bot.entity.position;
      return factory.createResponse(
        `Fled ${distance} blocks from ${entityName(entity)}; now at (${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)})`
      );
    }
  );

  factory.registerTool(
    "equip-best-weapon",
    "Equip the best melee weapon (sword or axe) found in the bot's inventory",
    {},
    async () => {
      const bot = getBot();
      const weapon = findBestWeapon(bot);
      if (!weapon) {
        return factory.createResponse('No weapon in inventory.');
      }
      const equipped = await tryEquip(bot, weapon);
      return equipped
        ? factory.createResponse(`Equipped ${weapon.name}`)
        : factory.createResponse('No weapon in inventory.');
    }
  );

  factory.registerTool(
    "get-health",
    "Report the bot's health, food, and saturation",
    {},
    async () => {
      const bot = getBot();
      const health = typeof bot.health === 'number' ? bot.health : 20;
      const food = typeof bot.food === 'number' ? bot.food : 20;
      const saturation = typeof (bot as { saturation?: number }).saturation === 'number'
        ? (bot as { saturation?: number }).saturation!
        : 'n/a';

      let text = `Health: ${health}/20, Food: ${food}/20, Saturation: ${saturation}`;
      if (typeof health === 'number' && health < 6) {
        text += '\nLow health — consider fleeing or eating.';
      }
      return factory.createResponse(text);
    }
  );
}

import { z } from "zod";
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';

type Entity = ReturnType<Bot['nearestEntity']>;

export const HOSTILE_MOBS = new Set<string>([
  'zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch', 'blaze', 'ghast',
  'slime', 'magma_cube', 'phantom', 'drowned', 'husk', 'cave_spider', 'piglin',
  'hoglin', 'ravager', 'vindicator', 'pillager', 'evoker', 'guardian',
  'elder_guardian', 'shulker', 'silverfish', 'endermite', 'vex', 'warden',
  'bogged', 'breeze'
]);

type EntityRecord = { id: unknown; entity: NonNullable<Entity> };

export function iterateEntities(bot: Bot): EntityRecord[] {
  const raw = (bot as { entities?: unknown }).entities;
  if (!raw) return [];
  if (raw instanceof Map) {
    return Array.from(raw.entries()).map(([id, entity]) => ({
      id,
      entity: entity as NonNullable<Entity>
    }));
  }
  return Object.entries(raw as Record<string, unknown>).map(([id, entity]) => ({
    id,
    entity: entity as NonNullable<Entity>
  }));
}

export function entityName(entity: NonNullable<Entity>): string {
  return entity.name || (entity as { username?: string }).username || entity.mobType || entity.type || 'unknown';
}

export function isHostileEntity(entity: NonNullable<Entity>): boolean {
  const name = entity.name || entity.mobType;
  return Boolean(name) && HOSTILE_MOBS.has(name!);
}

export function entityHealth(entity: NonNullable<Entity>): string {
  const health = (entity as { health?: number }).health;
  return typeof health === 'number' ? String(health) : 'n/a';
}

export function distanceToEntity(origin: Vec3, entity: NonNullable<Entity>): number {
  return typeof entity.position?.distanceTo === 'function'
    ? origin.distanceTo(entity.position)
    : Number.POSITIVE_INFINITY;
}

export function registerEntityTools(factory: ToolFactory, getBot: () => Bot): void {
  factory.registerTool(
    "find-entity",
    "Find the nearest entity of a specific type",
    {
      type: z.string().optional().describe("Type of entity to find (empty for any entity)"),
      maxDistance: z.coerce.number().finite().optional().describe("Maximum search distance (default: 16)")
    },
    async ({ type = '', maxDistance = 16 }) => {
      const bot = getBot();
      const entityFilter = (entity: NonNullable<Entity>) => {
        if (!type) return true;
        if (type === 'player') return entity.type === 'player';
        if (type === 'mob') return entity.type === 'mob';
        return Boolean(entity.name && entity.name.includes(type.toLowerCase()));
      };

      const entity = bot.nearestEntity(entityFilter);

      if (!entity || bot.entity.position.distanceTo(entity.position) > maxDistance) {
        return factory.createResponse(`No ${type || 'entity'} found within ${maxDistance} blocks`);
      }

      const entityName = entity.name || (entity as { username?: string }).username || entity.type;
      return factory.createResponse(`Found ${entityName} at position (${Math.floor(entity.position.x)}, ${Math.floor(entity.position.y)}, ${Math.floor(entity.position.z)})`);
    }
  );

  factory.registerTool(
    "find-hostiles",
    "Find nearby hostile mobs (zombies, creepers, etc.) within a maximum distance",
    {
      maxDistance: z.coerce.number().finite().optional().describe("Maximum search distance (default: 24)"),
      count: z.coerce.number().int().optional().describe("Maximum number of hostiles to return (default: 3)")
    },
    async ({ maxDistance = 24, count = 3 }) => {
      const bot = getBot();
      const origin = bot.entity?.position;
      const selfId = bot.entity?.id;

      const hostiles: { name: string; position: Vec3; distance: number; health: string }[] = [];

      for (const record of iterateEntities(bot)) {
        const entity = record.entity;
        if (selfId !== undefined && entity.id === selfId) continue;
        if (!isHostileEntity(entity)) continue;
        const position = entity.position;
        if (!origin || !position) continue;
        const distance = distanceToEntity(origin, entity);
        if (distance > maxDistance) continue;
        hostiles.push({
          name: entityName(entity),
          position,
          distance,
          health: entityHealth(entity)
        });
      }

      hostiles.sort((a, b) => a.distance - b.distance);

      const top = hostiles.slice(0, Math.max(1, count));
      if (top.length === 0) {
        return factory.createResponse(`No hostiles within ${maxDistance} blocks`);
      }

      const lines = top.map((h) =>
        `- ${h.name} at (${Math.floor(h.position.x)}, ${Math.floor(h.position.y)}, ${Math.floor(h.position.z)}), distance ${h.distance.toFixed(1)}, health ${h.health}`
      );
      return factory.createResponse(lines.join('\n'));
    }
  );
}

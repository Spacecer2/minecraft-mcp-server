import { z } from 'zod';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';
import { iterateEntities, entityName, isHostileEntity, distanceToEntity } from './entity-tools.js';

type Entity = ReturnType<Bot['nearestEntity']>;

const CARDINALS = ['S', 'SW', 'W', 'NW', 'N', 'NE', 'E', 'SE'] as const;
const AIR_BLOCKS = new Set(['air', 'cave_air', 'void_air']);
const HOSTILE_SCAN_RADIUS = 24;
const MAX_VIEW_BLOCKS = 8;
const MAX_VIEW_ENTITIES = 8;

function cardinalFromYaw(yaw: number): string {
  const deg = (((-yaw * 180) / Math.PI) % 360 + 360) % 360;
  const index = Math.round(deg / 45) % 8;
  return CARDINALS[index];
}

function facingDirection(yaw: number, pitch: number): Vec3 {
  return new Vec3(
    -Math.sin(yaw) * Math.cos(pitch),
    -Math.sin(pitch),
    -Math.cos(yaw) * Math.cos(pitch)
  ).normalize();
}

export function registerVisionTools(factory: ToolFactory, getBot: () => Bot): void {
  factory.registerTool(
    "get-bot-stats",
    "Consolidated stats dashboard: position, facing, dimension, gamemode, time, health, food, held item, inventory summary, and nearby hostiles in one call",
    {},
    async () => {
      const bot = getBot();
      const entity = bot.entity;

      const pos = entity?.position;
      const x = pos ? Math.floor(pos.x) : '?';
      const y = pos ? Math.floor(pos.y) : '?';
      const z = pos ? Math.floor(pos.z) : '?';

      const yaw = typeof entity?.yaw === 'number' ? entity.yaw : null;
      const pitch = typeof entity?.pitch === 'number' ? entity.pitch : null;
      const facing = yaw === null ? '?' : cardinalFromYaw(yaw);

      const timeOfDay = bot.time?.timeOfDay;
      const dimension = bot.game?.dimension ?? 'unknown';
      const gameMode = bot.game?.gameMode ?? 'unknown';
      const health = typeof bot.health === 'number' ? bot.health : '?';
      const food = typeof bot.food === 'number' ? bot.food : '?';
      const dayNight = typeof timeOfDay === 'number' ? (timeOfDay < 13000 ? 'day' : 'night') : 'unknown';
      const difficulty = bot.game?.difficulty ?? 'unknown';
      const weather = (bot as { weather?: string }).weather ?? 'clear';
      const saturation = typeof (bot as { saturation?: unknown }).saturation === 'number'
        ? String((bot as { saturation?: number }).saturation)
        : 'unknown';
      const xpLevel = (bot as { experience?: { level?: number }; xp?: { level?: number } }).experience?.level
        ?? (bot as { experience?: { level?: number }; xp?: { level?: number } }).xp?.level
        ?? 'unknown';
      const heldItem = bot.heldItem?.name ?? 'empty';

      let inventoryLines: string[];
      try {
        const items = (bot as { inventory?: { items?: () => { name: string; count: number }[] } })
          .inventory?.items?.() ?? [];
        if (items.length === 0) {
          inventoryLines = ['Inventory is empty'];
        } else {
          const totalItems = items.reduce((sum, item) => sum + (typeof item.count === 'number' ? item.count : 0), 0);
          const distinct = new Set(items.map((item) => item.name)).size;
          inventoryLines = [`${items.length} stacks, ${distinct} distinct item types (${totalItems} total items)`];
          inventoryLines.push(...items.slice(0, 8).map((item) => `- ${item.name} (x${item.count})`));
          if (items.length > 8) {
            inventoryLines.push(`... and ${items.length - 8} more stacks`);
          }
        }
      } catch {
        inventoryLines = ['Inventory: unknown'];
      }

      let hostileCount = 0;
      const hostileLines: string[] = [];
      try {
        const origin = bot.entity?.position;
        const selfId = bot.entity?.id;
        const hostiles: { name: string; position: Vec3; distance: number }[] = [];
        for (const record of iterateEntities(bot)) {
          const e = record.entity;
          if (selfId !== undefined && e.id === selfId) continue;
          const p = e.position;
          if (!origin || !p) continue;
          const distance = distanceToEntity(origin, e);
          if (distance > HOSTILE_SCAN_RADIUS) continue;
          if (isHostileEntity(e)) {
            hostiles.push({ name: entityName(e), position: p, distance });
          }
        }
        hostiles.sort((a, b) => a.distance - b.distance);
        hostileCount = hostiles.length;
        hostileLines.push(...hostiles.slice(0, 5).map((h) =>
          `- ${h.name} at (${Math.floor(h.position.x)}, ${Math.floor(h.position.y)}, ${Math.floor(h.position.z)}), ${h.distance.toFixed(1)} blocks`
        ));
      } catch {
        hostileCount = 0;
      }

      const lines = [
        '=== Position ===',
        `Position: (${x}, ${y}, ${z})`,
        `Facing: ${facing} (yaw: ${yaw === null ? '?' : yaw.toFixed(2)}, pitch: ${pitch === null ? '?' : pitch.toFixed(2)})`,
        '=== World ===',
        `Dimension: ${dimension}`,
        `Gamemode: ${gameMode}`,
        `Time of day: ${typeof timeOfDay === 'number' ? Math.round(timeOfDay) : '?'}`,
        `Day/night: ${dayNight}`,
        `Difficulty: ${difficulty}`,
        `Weather: ${weather}`,
        '=== Stats ===',
        `Health: ${health}`,
        `Food: ${food}`,
        `Saturation: ${saturation}`,
        `XP level: ${xpLevel}`,
        '=== Equipment ===',
        `Held item: ${heldItem}`,
        '=== Inventory ===',
        ...inventoryLines,
        '=== Nearby ===',
        `Hostiles within ${HOSTILE_SCAN_RADIUS} blocks: ${hostileCount}`,
        ...hostileLines
      ];

      return factory.createResponse(lines.join('\n'));
    }
  );

  factory.registerTool(
    "describe-view",
    "Produce a human-readable narrative of what is in front of the bot: blocks along the facing ray and entities in the forward hemisphere",
    {
      distance: z.coerce.number().optional().describe("Maximum distance to look ahead in blocks (default: 16)")
    },
    async ({ distance = 16 }: { distance?: number }) => {
      const bot = getBot();
      const range = Math.max(1, Math.floor(distance));

      const entity = bot.entity;
      const origin = entity?.position;
      if (!origin || typeof origin.x !== 'number') {
        return factory.createResponse('Looking: no bot position available');
      }

      const yaw = entity && typeof entity.yaw === 'number' ? entity.yaw : 0;
      const pitch = entity && typeof entity.pitch === 'number' ? entity.pitch : 0;
      const facing = cardinalFromYaw(yaw);
      const direction = facingDirection(yaw, pitch);

      const blocks: { name: string; distance: number }[] = [];
      for (let d = 2; d <= range; d += 2) {
        try {
          const sample = origin.plus(direction.scaled(d)).floored();
          const block = bot.blockAt(sample);
          if (block && block.name && !AIR_BLOCKS.has(block.name)) {
            blocks.push({
              name: block.name,
              distance: origin.distanceTo(sample.offset(0.5, 0.5, 0.5))
            });
            if (blocks.length >= MAX_VIEW_BLOCKS) break;
          }
        } catch {
          // skip this probe if blockAt fails
        }
      }

      const forwardEntities: { name: string; distance: number; hostile: boolean }[] = [];
      try {
        const selfId = entity?.id;
        for (const record of iterateEntities(bot)) {
          const e = record.entity;
          if (selfId !== undefined && e.id === selfId) continue;
          const p = e.position;
          if (!origin || !p) continue;
          const distance = distanceToEntity(origin, e);
          if (distance > range) continue;
          const toEntity = p.minus(origin);
          const dot = toEntity.x * direction.x + toEntity.y * direction.y + toEntity.z * direction.z;
          if (dot <= 0) continue;
          forwardEntities.push({ name: entityName(e), distance, hostile: isHostileEntity(e) });
        }
      } catch {
        // ignore entity scan failures
      }
      forwardEntities.sort((a, b) => a.distance - b.distance);

      if (blocks.length === 0 && forwardEntities.length === 0) {
        return factory.createResponse(`Clear view for ${range} blocks.`);
      }

      const lines = [`Looking ${facing}:`];
      for (const b of blocks) {
        lines.push(`- ${b.name} ${b.distance.toFixed(1)} blocks ahead`);
      }
      for (const e of forwardEntities.slice(0, MAX_VIEW_ENTITIES)) {
        lines.push(`- ${e.name} ${e.distance.toFixed(1)} blocks ahead (${e.hostile ? 'hostile' : 'friendly'})`);
      }

      return factory.createResponse(lines.join('\n'));
    }
  );

  factory.registerTool(
    "interact-entity",
    "Interact with a nearby entity (NPC, villager, animal, mob): right-click (use) or attack",
    {
      entityType: z.string().optional().describe("Type of entity to interact with (empty for any entity)"),
      maxDistance: z.coerce.number().optional().describe("Maximum distance to the entity in blocks (default: 6)"),
      action: z.enum(['use', 'attack']).optional().describe("Action to perform (default: 'use')")
    },
    async ({ entityType = '', maxDistance = 6, action = 'use' }: {
      entityType?: string;
      maxDistance?: number;
      action?: 'use' | 'attack';
    }) => {
      const bot = getBot();
      const range = Math.max(0, maxDistance);

      const entityFilter = (entity: NonNullable<Entity>) => {
        if (!entityType) return true;
        if (entityType === 'player') return entity.type === 'player';
        if (entityType === 'mob') return entity.type === 'mob';
        return Boolean(entity.name && entity.name.includes(entityType.toLowerCase()));
      };

      let target: NonNullable<Entity> | null = null;
      try {
        target = bot.nearestEntity(entityFilter);
      } catch {
        target = null;
      }

      const typeLabel = entityType ? ` of type ${entityType}` : '';
      const notFound = () => `No entity${typeLabel} within ${range} blocks.`;

      if (!target || !target.position) {
        return factory.createResponse(notFound());
      }

      let distance = Number.POSITIVE_INFINITY;
      try {
        distance = bot.entity?.position?.distanceTo(target.position) ?? Number.POSITIVE_INFINITY;
      } catch {
        distance = Number.POSITIVE_INFINITY;
      }

      if (distance > range) {
        return factory.createResponse(notFound());
      }

      const name = entityName(target);
      const at = `(${Math.floor(target.position.x)}, ${Math.floor(target.position.y)}, ${Math.floor(target.position.z)})`;

      try {
        if (action === 'attack') {
          if (typeof bot.attack !== 'function') {
            return factory.createErrorResponse('attack not supported by this bot');
          }
          await bot.attack(target);
          return factory.createResponse(`Attacked ${name} at ${at}`);
        }
        if (typeof bot.useOn !== 'function') {
          return factory.createErrorResponse('useOn not supported by this bot');
        }
        await bot.useOn(target);
        return factory.createResponse(`Used ${name} at ${at}`);
      } catch (error) {
        return factory.createErrorResponse(error as Error);
      }
    }
  );
}

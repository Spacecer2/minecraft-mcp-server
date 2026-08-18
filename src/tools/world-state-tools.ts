import { z } from 'zod';
import mineflayer from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';
import { entityName, entityHealth, isHostileEntity, iterateEntities, distanceToEntity } from './entity-tools.js';

const CARDINALS = ['S', 'SW', 'W', 'NW', 'N', 'NE', 'E', 'SE'] as const;

function cardinalFromYaw(yaw: number): string {
  const deg = (((-yaw * 180) / Math.PI) % 360 + 360) % 360;
  const index = Math.round(deg / 45) % 8;
  return CARDINALS[index];
}

export function registerWorldStateTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "get-world-state",
    "Get the bot's current world state: position, facing (from yaw/pitch), dimension, gamemode, time of day, health, food, biome, and held item",
    {},
    async () => {
      const bot = getBot();

      const pos = bot.entity?.position;
      const x = pos ? Math.floor(pos.x) : '?';
      const y = pos ? Math.floor(pos.y) : '?';
      const z = pos ? Math.floor(pos.z) : '?';

      const yaw = typeof bot.entity?.yaw === 'number' ? bot.entity.yaw : null;
      const pitch = typeof bot.entity?.pitch === 'number' ? bot.entity.pitch : null;
      const facing = yaw === null ? '?' : cardinalFromYaw(yaw);

      const biome = (bot.entity as unknown as { biome?: { name?: string } })?.biome?.name ?? 'unknown';

      const timeOfDay = bot.time?.timeOfDay;
      const dimension = bot.game?.dimension ?? 'unknown';
      const gameMode = bot.game?.gameMode ?? 'unknown';
      const health = typeof bot.health === 'number' ? bot.health : '?';
      const food = typeof bot.food === 'number' ? bot.food : '?';
      const onGround = typeof bot.entity?.onGround === 'boolean' ? bot.entity.onGround : '?';
      const heldItem = bot.heldItem?.name ?? 'empty';

      const dayNight = typeof timeOfDay === 'number' ? (timeOfDay < 13000 ? 'day' : 'night') : 'unknown';
      const difficulty = bot.game?.difficulty ?? 'unknown';
      const weather = (bot as { weather?: string }).weather ?? 'clear';
      const saturation = typeof (bot as { saturation?: unknown }).saturation === 'number'
        ? String((bot as { saturation?: number }).saturation)
        : 'unknown';
      const xpLevel = (bot as { experience?: { level?: number }; xp?: { level?: number } }).experience?.level
        ?? (bot as { experience?: { level?: number }; xp?: { level?: number } }).xp?.level
        ?? 'unknown';

      let lightLevel: number | string = 'unknown';
      try {
        const feetBlock = bot.blockAt?.(bot.entity?.position?.floored?.());
        if (feetBlock && typeof feetBlock.light === 'number') {
          lightLevel = feetBlock.light;
        }
      } catch {
        lightLevel = 'unknown';
      }

      const lines = [
        `Position: (${x}, ${y}, ${z})`,
        `Facing: ${facing} (yaw: ${yaw === null ? '?' : yaw.toFixed(2)}, pitch: ${pitch === null ? '?' : pitch.toFixed(2)})`,
        `Dimension: ${dimension}`,
        `Gamemode: ${gameMode}`,
        `Time of day: ${typeof timeOfDay === 'number' ? Math.round(timeOfDay) : '?'}`,
        `Day/night: ${dayNight}`,
        `Difficulty: ${difficulty}`,
        `Weather: ${weather}`,
        `Health: ${health}`,
        `Food: ${food}`,
        `Saturation: ${saturation}`,
        `XP level: ${xpLevel}`,
        `On ground: ${onGround}`,
        `Biome: ${biome}`,
        `Light level: ${lightLevel}`,
        `Held item: ${heldItem}`
      ];

      return factory.createResponse(lines.join('\n'));
    }
  );

  factory.registerTool(
    "get-surroundings",
    "List nearby entities (hostile and friendly) within a radius, with a danger summary",
    {
      radius: z.coerce.number().finite().optional().describe("Radius in blocks to scan for entities (default: 16)")
    },
    async ({ radius = 16 }) => {
      const bot = getBot();
      const origin = bot.entity?.position;
      const selfId = bot.entity?.id;

      const nearby: { name: string; position: { x: number; y: number; z: number }; distance: number; health: string; hostile: boolean }[] = [];

      for (const record of iterateEntities(bot)) {
        const entity = record.entity;
        if (selfId !== undefined && entity.id === selfId) continue;
        const position = entity.position;
        if (!origin || !position) continue;
        const distance = distanceToEntity(origin, entity);
        if (distance > radius) continue;
        nearby.push({
          name: entityName(entity),
          position,
          distance,
          health: entityHealth(entity),
          hostile: isHostileEntity(entity)
        });
      }

      nearby.sort((a, b) => a.distance - b.distance);

      const hostileCount = nearby.filter((e) => e.hostile).length;
      const lines = nearby.map((e) => {
        const tag = e.hostile ? 'HOSTILE' : 'friendly';
        return `- ${e.name} (${tag}) at (${Math.floor(e.position.x)}, ${Math.floor(e.position.y)}, ${Math.floor(e.position.z)}), distance ${e.distance.toFixed(1)}, ${e.health} health`;
      });

      if (lines.length === 0) {
        lines.push('No entities nearby');
      }

      lines.push(hostileCount > 0
        ? `Danger: ${hostileCount} hostile ${hostileCount === 1 ? 'entity' : 'entities'} nearby`
        : 'Danger: none');

      return factory.createResponse(lines.join('\n'));
    }
  );
}

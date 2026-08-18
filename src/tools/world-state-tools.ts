import mineflayer from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';

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

      const lines = [
        `Position: (${x}, ${y}, ${z})`,
        `Facing: ${facing} (yaw: ${yaw === null ? '?' : yaw.toFixed(2)}, pitch: ${pitch === null ? '?' : pitch.toFixed(2)})`,
        `Dimension: ${dimension}`,
        `Gamemode: ${gameMode}`,
        `Time of day: ${typeof timeOfDay === 'number' ? Math.round(timeOfDay) : '?'}`,
        `Health: ${health}`,
        `Food: ${food}`,
        `On ground: ${onGround}`,
        `Biome: ${biome}`,
        `Held item: ${heldItem}`
      ];

      return factory.createResponse(lines.join('\n'));
    }
  );
}

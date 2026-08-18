import { z } from "zod";
import mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';

const MAX_SCAN_VOLUME = 125;

export function registerScanTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "scan-area",
    "Scan an axis-aligned volume and report the block at each cell. Max 125 blocks (5x5x5).",
    {
      x1: z.coerce.number().describe("X coordinate of first corner"),
      y1: z.coerce.number().describe("Y coordinate of first corner"),
      z1: z.coerce.number().describe("Z coordinate of first corner"),
      x2: z.coerce.number().describe("X coordinate of second corner"),
      y2: z.coerce.number().describe("Y coordinate of second corner"),
      z2: z.coerce.number().describe("Z coordinate of second corner")
    },
    async ({ x1, y1, z1, x2, y2, z2 }: { x1: number, y1: number, z1: number, x2: number, y2: number, z2: number }) => {
      const bot = getBot();

      const [minX, maxX] = [Math.floor(x1), Math.floor(x2)].sort((a, b) => a - b);
      const [minY, maxY] = [Math.floor(y1), Math.floor(y2)].sort((a, b) => a - b);
      const [minZ, maxZ] = [Math.floor(z1), Math.floor(z2)].sort((a, b) => a - b);

      const countX = maxX - minX + 1;
      const countY = maxY - minY + 1;
      const countZ = maxZ - minZ + 1;
      const volume = countX * countY * countZ;

      if (volume > MAX_SCAN_VOLUME) {
        return factory.createErrorResponse("scan-area too large (max 125 blocks). Narrow the volume.");
      }

      const blockNameAt = (v: Vec3): string => bot.blockAt(v)?.name ?? 'unknown';

      let output = `Area scan (${minX},${minY},${minZ}) to (${maxX},${maxY},${maxZ}) [${volume} blocks]:`;
      for (let y = minY; y <= maxY; y++) {
        output += `\n\nY=${y}:`;
        for (let z = minZ; z <= maxZ; z++) {
          const row: string[] = [];
          for (let x = minX; x <= maxX; x++) {
            row.push(blockNameAt(new Vec3(x, y, z)));
          }
          output += `\n  z=${z}: ${row.join(' | ')}`;
        }
      }

      return factory.createResponse(output);
    }
  );

  factory.registerTool(
    "verify-block",
    "Check what block is currently at a position",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate")
    },
    async ({ x, y, z }: { x: number, y: number, z: number }) => {
      const bot = getBot();
      const block = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)));
      return factory.createResponse(`Block at (${Math.floor(x)}, ${Math.floor(y)}, ${Math.floor(z)}): ${block?.name ?? 'unknown'}`);
    }
  );
}

import { z } from "zod";
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ToolFactory } from '../tool-factory.js';

interface Blueprint {
  rows: string[];
  palette: Record<string, string>;
}

const blueprints = new Map<string, Blueprint>();
let storeDirOverride: string | undefined;

export function resetBlueprintStore(): void {
  blueprints.clear();
}

export function setBlueprintStoreDir(dir: string | undefined): void {
  storeDirOverride = dir;
}

function getDataDir(): string {
  return storeDirOverride ?? process.env.BLUEPRINT_STORE_DIR ?? path.join(process.cwd(), 'data', 'blueprints');
}

function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function filePathFor(name: string): string {
  return path.join(getDataDir(), `${safeFileName(name)}.json`);
}

function loadFromDisk(name: string): Blueprint | undefined {
  try {
    const raw = fs.readFileSync(filePathFor(name), 'utf8');
    const parsed = JSON.parse(raw) as { rows?: unknown; palette?: unknown };
    if (!Array.isArray(parsed.rows) || typeof parsed.palette !== 'object' || parsed.palette === null) {
      return undefined;
    }
    const rows = parsed.rows as unknown[];
    if (!rows.every(r => typeof r === 'string')) {
      return undefined;
    }
    return { rows: rows as string[], palette: parsed.palette as Record<string, string> };
  } catch {
    return undefined;
  }
}

function saveToDisk(name: string, blueprint: Blueprint): boolean {
  try {
    fs.mkdirSync(getDataDir(), { recursive: true });
    fs.writeFileSync(filePathFor(name), JSON.stringify(blueprint, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

function listFromDisk(): string[] {
  try {
    if (!fs.existsSync(getDataDir())) {
      return [];
    }
    return fs.readdirSync(getDataDir())
      .filter(f => f.endsWith('.json'))
      .map(f => f.slice(0, -'.json'.length))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function getAllNames(): string[] {
  const names = new Set<string>(blueprints.keys());
  for (const name of listFromDisk()) {
    names.add(name);
  }
  return [...names].sort();
}

export function registerBlueprintStoreTools(factory: ToolFactory): void {
  factory.registerTool(
    "blueprint-save",
    "Save a 2D blueprint (rows + char palette) to a durable library on disk for later reuse. Rows must be equal length.",
    {
      name: z.string().describe("Name of the blueprint"),
      rows: z.array(z.string()).min(1).max(64).describe("Each string is one horizontal row; all rows must be the same length"),
      palette: z.record(z.string(), z.string()).describe("Maps each char code to a block name, e.g. {'W':'oak_planks'}")
    },
    async ({ name, rows, palette }: { name: string, rows: string[], palette: Record<string, string> }) => {
      const rowLength = rows[0].length;
      for (const row of rows) {
        if (row.length !== rowLength) {
          throw new Error('Blueprint rows must have equal length.');
        }
      }

      const blueprint: Blueprint = { rows, palette };
      blueprints.set(name, blueprint);

      let msg = `Saved blueprint ${name} (${rows.length} rows).`;
      if (!saveToDisk(name, blueprint)) {
        msg += ' (warning: disk persist failed)';
      }
      return factory.createResponse(msg);
    }
  );

  factory.registerTool(
    "blueprint-list",
    "List saved blueprint names (from the on-disk library and in-memory).",
    {},
    async () => {
      const names = getAllNames();
      if (names.length === 0) {
        return factory.createResponse('No saved blueprints.');
      }
      return factory.createResponse(`Saved blueprints:\n${names.map(n => `- ${n}`).join('\n')}`);
    }
  );

  factory.registerTool(
    "blueprint-load",
    "Load a saved blueprint (from memory or disk) and return its rows and palette.",
    {
      name: z.string().describe("Name of the blueprint to load")
    },
    async ({ name }: { name: string }) => {
      const blueprint = blueprints.get(name) ?? loadFromDisk(name);
      if (!blueprint) {
        return factory.createErrorResponse(`No blueprint named ${name}.`);
      }

      const palette = Object.entries(blueprint.palette)
        .map(([key, value]) => `${key}=${value}`)
        .join(', ');
      return factory.createResponse(`Blueprint ${name}:\n${blueprint.rows.join('\n')}\nPalette: ${palette}`);
    }
  );
}
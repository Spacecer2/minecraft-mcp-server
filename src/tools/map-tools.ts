import { z } from "zod";
import mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { ToolFactory } from '../tool-factory.js';
import {
  addNode,
  getNode,
  markTraversed,
  reSight,
  shortestPath,
  type LandmarkType
} from '../navigation-graph.js';
import {
  acceptableDeathEnvelope,
  stateDependentParams,
  ucbBonus,
  type DeathEnvelope
} from '../risk-evaluator.js';
import type { Position } from '../dead-reckoning.js';

type Landmark = {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  type: string;
  dimension: string;
  discoveredAt: number;
};

const worldMap = new Map<string, Landmark>();
let lastLandmarkId = 0;

// Maps flat worldMap landmark ids to the navigation-graph node ids so the
// landmark set and the traversal graph stay in sync (additive, guarded).
const landmarkNodeByLandmarkId = new Map<string, string>();

// Per-radial-sector UCB exploration bookkeeping: how many times each sweep
// sector has been probed. A less-visited sector earns a larger exploration
// bonus, so repeated sweeps steer the bot toward novel territory.
const sectorVisitCounts = new Map<string, number>();

const EXPLORATION_CONSTANT = 2;

const MAX_EXPLORE_PROBES = 400;

const FUNCTIONAL_BLOCKS = new Set([
  'chest', 'crafting_table', 'furnace', 'torch', 'water', 'lava',
  'flowing_water', 'flowing_lava'
]);

const ORE_TYPES = [
  'coal', 'iron', 'gold', 'diamond', 'redstone', 'lapis', 'emerald', 'copper'
];

function buildDefaultNotable(): Set<string> {
  const set = new Set(FUNCTIONAL_BLOCKS);
  for (const ore of ORE_TYPES) {
    set.add(`${ore}_ore`);
    set.add(`deepslate_${ore}_ore`);
  }
  return set;
}

const DEFAULT_NOTABLE = buildDefaultNotable();
const STRUCTURE_KEYWORDS = ['village', 'temple', 'ruin', 'shipwreck'];

function dimensionOf(bot: mineflayer.Bot): string {
  return bot.game?.dimension ?? 'unknown';
}

function distance3d(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number
): number {
  return Math.hypot(ax - bx, ay - by, az - bz);
}

function landmarkNear(lm: Landmark, x: number, y: number, z: number, tolerance = 2): boolean {
  return Math.abs(lm.x - x) <= tolerance
    && Math.abs(lm.y - y) <= tolerance
    && Math.abs(lm.z - z) <= tolerance;
}

function toGraphType(type: string): LandmarkType {
  const t = type.toLowerCase();
  if (t === 'village') return 'village';
  if (t === 'cave' || t.includes('cave')) return 'cave';
  if (t === 'ore' || t.includes('_ore') || t.includes('ore')) return 'ore';
  if (t === 'death' || t === 'grave') return 'death';
  if (t === 'monument' || t.includes('temple') || t.includes('ruin') || t.includes('shipwreck')) {
    return 'monument';
  }
  if (t === 'nether_portal' || t.includes('portal') || t === 'nether') return 'nether_portal';
  return 'base';
}

function lastAddedNodeId(): string | undefined {
  return landmarkNodeByLandmarkId.get(`landmark-${lastLandmarkId}`);
}

function addLandmark(
  name: string,
  x: number,
  y: number,
  z: number,
  type: string,
  dimension: string
): boolean {
  for (const lm of worldMap.values()) {
    if (lm.type === type && landmarkNear(lm, x, y, z)) {
      return false;
    }
  }
  const id = `landmark-${++lastLandmarkId}`;
  worldMap.set(id, {
    id,
    name,
    x: Math.round(x),
    y: Math.round(y),
    z: Math.round(z),
    type,
    dimension,
    discoveredAt: Date.now()
  });
  const node = addNode({
    name,
    x: Math.round(x),
    y: Math.round(y),
    z: Math.round(z),
    type: toGraphType(type)
  });
  landmarkNodeByLandmarkId.set(id, node.id);
  return true;
}

function botHealth(bot: mineflayer.Bot): number | undefined {
  return typeof bot.health === 'number' && Number.isFinite(bot.health) ? bot.health : undefined;
}

/**
 * Dead-reckoning drift correction on a landmark re-sighting. Wraps the
 * navigation graph's reSight: maps a worldMap landmark id (or a raw node id)
 * to its node and returns the accumulated drift vector, or null if the node is
 * unknown.
 */
export function reSightLandmark(id: string, actualPos: Position): Position | null {
  const nodeId = landmarkNodeByLandmarkId.get(id) ?? id;
  const node = getNode(nodeId);
  if (!node) return null;
  return reSight(nodeId, actualPos);
}

// Re-sight an already-recorded landmark that the bot just encountered again,
// applying the drift correction toward its actual position.
function reSightNearby(x: number, y: number, z: number, type: string): Position | null {
  for (const lm of worldMap.values()) {
    if (lm.type === type && landmarkNear(lm, x, y, z)) {
      return reSightLandmark(lm.id, { x, y, z });
    }
  }
  return null;
}

// Test seams for the exploration wiring (additive; existing tools untouched).
export function setSectorVisitCounts(counts: Record<string, number>): void {
  sectorVisitCounts.clear();
  for (const [key, value] of Object.entries(counts)) {
    sectorVisitCounts.set(key, value);
  }
}

export function sectorVisitCount(key: string): number {
  return sectorVisitCounts.get(key) ?? 0;
}

function classifyBlock(name: string, notable: Set<string>): string | undefined {
  if (notable.has(name)) return name;
  for (const keyword of STRUCTURE_KEYWORDS) {
    if (name.includes(keyword)) return keyword;
  }
  return undefined;
}

export function registerMapTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "map-mark",
    "Record a discovered landmark (village, cave, chest, etc.) in the persistent world map",
    {
      name: z.string().describe("Landmark name"),
      x: z.coerce.number().optional().describe("X coordinate (defaults to the bot's current position)"),
      y: z.coerce.number().optional().describe("Y coordinate (defaults to the bot's current position)"),
      z: z.coerce.number().optional().describe("Z coordinate (defaults to the bot's current position)"),
      type: z.string().optional().describe("Landmark type (e.g. village, cave, chest)")
    },
    async ({ name, x, y, z, type }) => {
      const bot = getBot();
      const pos = bot.entity?.position;
      const lx = x ?? (pos ? pos.x : 0);
      const ly = y ?? (pos ? pos.y : 0);
      const lz = z ?? (pos ? pos.z : 0);
      const added = addLandmark(name, lx, ly, lz, type ?? 'mark', dimensionOf(bot));
      let driftCorrected: Position | undefined;
      if (!added) {
        const drift = reSightNearby(lx, ly, lz, type ?? 'mark');
        if (drift && (drift.x !== 0 || drift.y !== 0 || drift.z !== 0)) {
          driftCorrected = drift;
        }
      }
      const typeSuffix = type ? ` [${type}]` : '';
      const response = factory.createResponse(`Marked ${name} at (${Math.round(lx)}, ${Math.round(ly)}, ${Math.round(lz)})${typeSuffix}.`);
      if (driftCorrected) {
        (response as Record<string, unknown>).driftCorrected = driftCorrected;
      }
      return response;
    }
  );

  factory.registerTool(
    "map-list",
    "List all landmarks in the world map, optionally filtered by type",
    {
      type: z.string().optional().describe("Only show landmarks of this type")
    },
    async ({ type }) => {
      let list = Array.from(worldMap.values());
      if (type) list = list.filter((lm) => lm.type === type);
      if (list.length === 0) {
        return factory.createResponse("Map empty");
      }
      list.sort((a, b) => a.discoveredAt - b.discoveredAt);
      const lines = list.map((lm) =>
        `- ${lm.name} (${lm.type}) at (${lm.x},${lm.y},${lm.z}) [${lm.dimension}]`
      );
      return factory.createResponse(lines.join('\n'));
    }
  );

  factory.registerTool(
    "map-clear",
    "Clear all landmarks from the world map",
    {},
    async () => {
      const count = worldMap.size;
      worldMap.clear();
      return factory.createResponse(`Map cleared (${count} landmark${count === 1 ? '' : 's'} removed).`);
    }
  );

  factory.registerTool(
    "map-nearby",
    "List landmarks within a radius of the bot's current position, sorted by distance",
    {
      radius: z.coerce.number().finite().optional().describe("Radius in blocks (default: 64)"),
      type: z.string().optional().describe("Only show landmarks of this type")
    },
    async ({ radius = 64, type }) => {
      const bot = getBot();
      const pos = bot.entity?.position;
      if (!pos) {
        return factory.createResponse("No position available");
      }
      let list = Array.from(worldMap.values());
      if (type) list = list.filter((lm) => lm.type === type);
      const nearby = list
        .map((lm) => ({ lm, distance: distance3d(lm.x, lm.y, lm.z, pos.x, pos.y, pos.z) }))
        .filter(({ distance }) => distance <= radius)
        .sort((a, b) => a.distance - b.distance);
      if (nearby.length === 0) {
        return factory.createResponse(`No landmarks within ${radius} blocks`);
      }
      const lines = nearby.map(({ lm, distance }) =>
        `- ${lm.name} at (${lm.x},${lm.y},${lm.z}), ${distance.toFixed(1)} blocks away`
      );
      return factory.createResponse(lines.join('\n'));
    }
  );

  factory.registerTool(
    "explore",
    "Sweep a circular area around the bot and record notable blocks (ores, chests, structures) as landmarks in the world map",
    {
      radius: z.coerce.number().finite().optional().describe("Sweep radius in blocks (default: 32)"),
      sectors: z.coerce.number().int().positive().optional().describe("Number of radial directions to sweep (default: 8)"),
      discover: z.array(z.string()).optional().describe("Additional block types to look for")
    },
    async ({ radius = 32, sectors = 8, discover = [] }) => {
      const bot = getBot();
      const origin = bot.entity?.position;
      if (!origin) {
        return factory.createResponse("No position available");
      }

      const dimension = dimensionOf(bot);
      addLandmark('explore-start', origin.x, origin.y, origin.z, 'start', dimension);
      const graphIds: string[] = [];
      const startNodeId = lastAddedNodeId();
      if (startNodeId) {
        graphIds.push(startNodeId);
      }

      const notable = new Set(DEFAULT_NOTABLE);
      for (const item of discover) {
        notable.add(item);
      }

      const probesPerSector = Math.max(1, Math.ceil(radius / 4));
      const effectiveSectors = Math.max(1, Math.min(sectors, Math.floor(MAX_EXPLORE_PROBES / probesPerSector)));
      const maxDistance = Math.max(4, radius);

      const discovered: string[] = [];
      const sectorInterest = new Map<string, number>();
      let lastDrift: Position | null = null;

      for (let s = 0; s < effectiveSectors; s++) {
        const key = String(s);
        sectorVisitCounts.set(key, (sectorVisitCounts.get(key) ?? 0) + 1);
        const angle = (s / effectiveSectors) * 2 * Math.PI;
        const dirX = Math.cos(angle);
        const dirZ = Math.sin(angle);
        for (let d = 4; d <= maxDistance; d += 4) {
          const px = Math.floor(origin.x + dirX * d);
          const py = Math.floor(origin.y);
          const pz = Math.floor(origin.z + dirZ * d);
          let blockName: string | undefined;
          try {
            blockName = bot.blockAt(new Vec3(px, py, pz))?.name;
          } catch {
            blockName = undefined;
          }
          if (!blockName) continue;
          const type = classifyBlock(blockName, notable);
          if (!type) continue;
          if (addLandmark(blockName, px, py, pz, type, dimension)) {
            discovered.push(blockName);
            sectorInterest.set(key, (sectorInterest.get(key) ?? 0) + 1);
            const nodeId = lastAddedNodeId();
            if (nodeId) {
              graphIds.push(nodeId);
            }
          } else {
            const drift = reSightNearby(px, py, pz, type);
            if (drift && (drift.x !== 0 || drift.y !== 0 || drift.z !== 0)) {
              lastDrift = drift;
            }
          }
        }
      }

      if (typeof bot.findBlocks === 'function') {
        const mcData = minecraftData(bot.version);
        for (const blockType of notable) {
          const blockId = mcData.blocksByName[blockType]?.id;
          if (blockId === undefined) continue;
          let positions: Vec3[] = [];
          try {
            positions = bot.findBlocks({
              point: origin,
              matching: blockId,
              maxDistance,
              count: 10
            });
          } catch {
            positions = [];
          }
          for (const p of positions) {
            if (addLandmark(blockType, p.x, p.y, p.z, blockType, dimension)) {
              discovered.push(blockType);
              const nodeId = lastAddedNodeId();
              if (nodeId) {
                graphIds.push(nodeId);
              }
            }
          }
        }

        for (const keyword of STRUCTURE_KEYWORDS) {
          const ids = Object.values(mcData.blocksByName)
            .filter((b) => b.name.includes(keyword))
            .map((b) => b.id);
          if (ids.length === 0) continue;
          let positions: Vec3[] = [];
          try {
            positions = bot.findBlocks({
              point: origin,
              matching: ids,
              maxDistance,
              count: 10
            });
          } catch {
            positions = [];
          }
          for (const p of positions) {
            if (addLandmark(keyword, p.x, p.y, p.z, keyword, dimension)) {
              discovered.push(keyword);
              const nodeId = lastAddedNodeId();
              if (nodeId) {
                graphIds.push(nodeId);
              }
            }
          }
        }
      }

      // Mark traversed edges between consecutive landmarks the bot moved
      // between during this sweep, using the position deltas as lengths.
      for (let i = 1; i < graphIds.length; i++) {
        const fromNode = getNode(graphIds[i - 1]);
        const toNode = getNode(graphIds[i]);
        if (!fromNode || !toNode) continue;
        const length = distance3d(fromNode.x, fromNode.y, fromNode.z, toNode.x, toNode.y, toNode.z);
        markTraversed(fromNode.id, toNode.id, length);
      }

      // UCB exploration ranking: interest found this sweep plus an exploration
      // bonus that decays with visit count, so the bot steers toward novel
      // sectors on the next sweep.
      let totalPlays = 0;
      for (const count of sectorVisitCounts.values()) {
        totalPlays += count;
      }
      const rankedSectors = Array.from({ length: effectiveSectors }, (_, i) => String(i))
        .map((key) => {
          const visits = sectorVisitCounts.get(key) ?? 0;
          const interest = sectorInterest.get(key) ?? 0;
          return {
            sector: key,
            visits,
            interest,
            score: interest + ucbBonus(visits, totalPlays, EXPLORATION_CONSTANT)
          };
        })
        .sort((a, b) => b.score - a.score || a.sector.localeCompare(b.sector));
      const recommendedSector = rankedSectors[0]?.sector ?? '0';

      // Death-envelope / risk posture from the bot's current health. Guarded so
      // an unknown or absent bot never throws.
      const health = botHealth(bot);
      const params = stateDependentParams({ health });
      const envelope: DeathEnvelope = acceptableDeathEnvelope({ health });
      const signal = health === undefined || health >= 10 ? 'safe to explore' : 'conservative';
      const deathEnvelope = {
        health: health ?? null,
        deathBudget: params.deathBudget,
        acceptablePDeath: envelope.acceptablePDeath,
        riskAttitude: envelope.riskAttitude,
        guarded: envelope.guarded,
        signal
      };

      const text = discovered.length === 0
        ? `Explored radius ${radius}: nothing new.`
        : `Explored radius ${radius}: discovered ${discovered.length} landmark(s): ${discovered.join(', ')}`;
      const response = factory.createResponse(text);
      const fields: Record<string, unknown> = {
        rankedSectors,
        recommendedSector,
        deathEnvelope
      };
      if (lastDrift) {
        fields.driftCorrected = lastDrift;
      }
      for (const [key, value] of Object.entries(fields)) {
        (response as Record<string, unknown>)[key] = value;
      }
      return response;
    }
  );
}

export function graphPath(fromId: string, toId: string): string[] | null {
  const from = landmarkNodeByLandmarkId.get(fromId) ?? fromId;
  const to = landmarkNodeByLandmarkId.get(toId) ?? toId;
  if (!getNode(from) || !getNode(to)) {
    return null;
  }
  return shortestPath(from, to);
}

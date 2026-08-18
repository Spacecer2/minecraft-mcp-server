import { z } from "zod";
import { ToolFactory } from '../tool-factory.js';

export interface TemplatePalette {
  wall: string;
  corner: string;
  roof: string;
  door: string;
  glass: string;
  porch: string;
}

export interface TemplateLayout {
  name: string;
  footprint: { w: number; d: number };
  layers: string[][];
}

export interface TemplateOpts {
  w?: number;
  d?: number;
  height?: number;
  palette?: Record<string, string>;
}

export const DEFAULT_PALETTE: TemplatePalette = {
  wall: 'oak_planks',
  corner: 'oak_log',
  roof: 'spruce_planks',
  door: 'air',
  glass: 'glass',
  porch: 'oak_fence'
};

export function resolvePalette(palette?: Record<string, string>): TemplatePalette {
  return { ...DEFAULT_PALETTE, ...(palette ?? {}) };
}

export function blockNameForCode(code: string, palette: TemplatePalette): string {
  switch (code) {
    case '.':
      return 'air';
    case 'W':
      return palette.wall;
    case 'C':
      return palette.corner;
    case 'R':
      return palette.roof;
    case 'D':
      return palette.door;
    case 'G':
      return palette.glass;
    case 'P':
      return palette.porch;
    default:
      return 'air';
  }
}

function solidRow(w: number): string {
  if (w <= 1) return 'W';
  return 'C' + 'W'.repeat(w - 2) + 'C';
}

function doorFront(w: number): string {
  const cells = Array(w).fill('W') as string[];
  cells[0] = 'C';
  cells[w - 1] = 'C';
  cells[Math.floor(w / 2)] = 'D';
  return cells.join('');
}

function porchFront(w: number): string {
  const cells = Array(w).fill('P') as string[];
  cells[0] = 'C';
  cells[w - 1] = 'C';
  cells[Math.floor(w / 2)] = 'D';
  return cells.join('');
}

function wallRows(front: string, solid: string, d: number): string[] {
  const rows = [front];
  for (let z = 1; z < d - 1; z++) {
    rows.push(solid);
  }
  rows.push(solid);
  return rows;
}

function gableRoof(w: number, d: number): string[][] {
  const layers: string[][] = [];
  for (let t = 0; t <= Math.floor(d / 2); t++) {
    const rows: string[] = [];
    for (let z = 0; z < d; z++) {
      rows.push(z >= t && z <= d - 1 - t ? 'R'.repeat(w) : '.'.repeat(w));
    }
    layers.push(rows);
  }
  return layers;
}

function crenellation(w: number, d: number): string[] {
  const edge = Array(w).fill('W') as string[];
  edge[0] = '.';
  edge[w - 1] = '.';
  const rows = [edge.join('')];
  for (let z = 1; z < d - 1; z++) {
    rows.push(solidRow(w));
  }
  rows.push(edge.join(''));
  return rows;
}

function makeHouse(opts: TemplateOpts): TemplateLayout {
  const w = Math.max(3, opts.w ?? 6);
  const d = Math.max(3, opts.d ?? 5);
  const h = Math.max(1, opts.height ?? 3);
  const solid = solidRow(w);
  const front = doorFront(w);
  const layers: string[][] = [];
  layers.push(wallRows(front, solid, d));
  for (let i = 0; i < h; i++) {
    layers.push(wallRows(solid, solid, d));
  }
  layers.push(...gableRoof(w, d));
  return { name: 'house', footprint: { w, d }, layers };
}

function makeCottage(opts: TemplateOpts): TemplateLayout {
  const w = Math.max(3, opts.w ?? 8);
  const d = Math.max(3, opts.d ?? 7);
  const h = Math.max(1, opts.height ?? 4);
  const solid = solidRow(w);
  const front = porchFront(w);
  const layers: string[][] = [];
  layers.push(wallRows(front, solid, d));
  for (let i = 0; i < h; i++) {
    layers.push(wallRows(solid, solid, d));
  }
  layers.push(...gableRoof(w, d));
  return { name: 'cottage', footprint: { w, d }, layers };
}

function makeTower(opts: TemplateOpts): TemplateLayout {
  const w = Math.max(3, opts.w ?? 5);
  const d = Math.max(3, opts.d ?? 5);
  const h = Math.max(1, opts.height ?? 6);
  const solid = solidRow(w);
  const layers: string[][] = [];
  for (let i = 0; i < h; i++) {
    layers.push(wallRows(solid, solid, d));
  }
  layers.push(crenellation(w, d));
  return { name: 'tower', footprint: { w, d }, layers };
}

function makeBridge(opts: TemplateOpts): TemplateLayout {
  const w = Math.max(3, opts.w ?? 3);
  const d = Math.max(3, opts.d ?? 9);
  const row = 'R' + 'W'.repeat(Math.max(0, w - 2)) + 'R';
  const layers = [Array(d).fill(row)];
  return { name: 'bridge', footprint: { w, d }, layers };
}

function makeShed(opts: TemplateOpts): TemplateLayout {
  const w = Math.max(3, opts.w ?? 3);
  const d = Math.max(3, opts.d ?? 3);
  const h = Math.max(1, opts.height ?? 3);
  const solid = solidRow(w);
  const layers: string[][] = [];
  for (let i = 0; i < h; i++) {
    layers.push(wallRows(solid, solid, d));
  }
  layers.push(Array(d).fill('R'.repeat(w)));
  return { name: 'shed', footprint: { w, d }, layers };
}

export const TEMPLATES: Record<string, (opts: TemplateOpts) => TemplateLayout> = {
  house: makeHouse,
  cottage: makeCottage,
  tower: makeTower,
  bridge: makeBridge,
  shed: makeShed
};

export const TEMPLATE_DEFAULTS: Record<string, { w: number; d: number }> = {
  house: { w: 6, d: 5 },
  cottage: { w: 8, d: 7 },
  tower: { w: 5, d: 5 },
  bridge: { w: 3, d: 9 },
  shed: { w: 3, d: 3 }
};

export function getTemplateNames(): string[] {
  return Object.keys(TEMPLATES);
}

export function generateTemplate(name: string, opts: TemplateOpts = {}): TemplateLayout {
  const builder = TEMPLATES[name];
  if (!builder) {
    throw new Error(`Unknown template ${name}`);
  }
  return builder(opts);
}

export function countNonAir(layout: TemplateLayout, palette: TemplatePalette): number {
  let count = 0;
  for (const layer of layout.layers) {
    for (const row of layer) {
      for (const code of row) {
        if (blockNameForCode(code, palette) !== 'air') {
          count++;
        }
      }
    }
  }
  return count;
}

export function registerTemplateTools(factory: ToolFactory): void {
  factory.registerTool(
    "load-template",
    "Preview a parametric building template before placing. Returns the footprint, per-layer grid of block names, and the total block count so the agent can see the blueprint.",
    {
      name: z.string().describe("Template name (see list-templates)"),
      w: z.coerce.number().optional().describe("Override width"),
      d: z.coerce.number().optional().describe("Override depth"),
      height: z.coerce.number().optional().describe("Override number of wall layers"),
      palette: z.record(z.string(), z.string()).optional().describe("Block palette overrides: wall, corner, roof, door, glass, porch")
    },
    async ({ name, w, d, height, palette }: { name: string, w?: number, d?: number, height?: number, palette?: Record<string, string> }) => {
      if (!TEMPLATES[name]) {
        return factory.createErrorResponse(`Unknown template ${name}. Use list-templates.`);
      }
      const layout = generateTemplate(name, { w, d, height, palette });
      const pal = resolvePalette(palette);
      const lines = [
        `Template ${layout.name} (footprint ${layout.footprint.w}x${layout.layers.length}x${layout.footprint.d}):`
      ];
      layout.layers.forEach((layer, idx) => {
        lines.push(`Layer ${idx}:`);
        for (const row of layer) {
          const cells = [...row].map((code) => {
            const blockName = blockNameForCode(code, pal);
            return blockName === 'air' ? '.' : blockName;
          });
          lines.push(' ' + cells.join(' '));
        }
      });
      lines.push(`Block count: ${countNonAir(layout, pal)}`);
      return factory.createResponse(lines.join('\n'));
    }
  );

  factory.registerTool(
    "list-templates",
    "List available building templates with their default footprint (WxD).",
    {},
    async () => {
      const lines = getTemplateNames().map((name) => {
        const def = TEMPLATE_DEFAULTS[name];
        return `${name} (${def.w}x${def.d})`;
      });
      return factory.createResponse(`Templates:\n${lines.join('\n')}`);
    }
  );
}

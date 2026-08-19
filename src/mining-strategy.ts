export type BlockPos = { x: number; y: number; z: number };

export type SegmentAxis = 'x' | 'z';

export type MineSegment = {
  kind: 'main' | 'branch';
  axis: SegmentAxis;
  from: BlockPos;
  to: BlockPos;
  length: number;
};

export type BranchMinePlan = {
  origin: BlockPos;
  level: number;
  mainTunnel: MineSegment;
  branches: MineSegment[];
  order: MineSegment[];
  quitWhenYieldBelow: number;
};

export type BranchMineOptions = {
  axis?: SegmentAxis;
  branchSpacing?: number;
  branchLength?: number;
  branchCount?: number;
  quitWhenYieldBelow?: number;
  level?: number;
};

export const DEFAULT_BRANCH_SPACING = 3;
export const DEFAULT_BRANCH_LENGTH = 10;
export const DEFAULT_BRANCH_COUNT = 6;
export const QUIT_BLOCK_WINDOW = 30;
export const DEFAULT_ENVIRONMENT_AVG_ORE_PER_BLOCK = 0.05;

function makeSegment(
  kind: MineSegment['kind'],
  axis: SegmentAxis,
  from: BlockPos,
  length: number
): MineSegment {
  const to: BlockPos =
    axis === 'x'
      ? { x: from.x + length, y: from.y + 1, z: from.z }
      : { x: from.x, y: from.y + 1, z: from.z + length };
  return { kind, axis, from: { ...from }, to, length };
}

export function segmentBlocks(seg: MineSegment): BlockPos[] {
  const blocks: BlockPos[] = [];
  for (let i = 0; i < seg.length; i++) {
    const x = seg.from.x + (seg.axis === 'x' ? i : 0);
    const z = seg.from.z + (seg.axis === 'z' ? i : 0);
    blocks.push({ x, y: seg.from.y, z });
    blocks.push({ x, y: seg.from.y + 1, z });
  }
  return blocks;
}

export function planBranchMine(
  origin: BlockPos,
  opts: BranchMineOptions = {}
): BranchMinePlan {
  const axis = opts.axis ?? 'x';
  const branchSpacing = opts.branchSpacing ?? DEFAULT_BRANCH_SPACING;
  const branchLength = opts.branchLength ?? DEFAULT_BRANCH_LENGTH;
  const branchCount = opts.branchCount ?? DEFAULT_BRANCH_COUNT;
  const quitWhenYieldBelow = opts.quitWhenYieldBelow ?? DEFAULT_ENVIRONMENT_AVG_ORE_PER_BLOCK;
  const level = opts.level ?? origin.y;

  const base: BlockPos = { x: origin.x, y: level, z: origin.z };
  const mainLength = branchCount * branchSpacing + 1;

  const mainTunnel = makeSegment('main', axis, base, mainLength);

  const branches: MineSegment[] = [];
  for (let i = 1; i <= branchCount; i++) {
    const offset = i * branchSpacing;
    const perp: SegmentAxis = axis === 'x' ? 'z' : 'x';
    const from: BlockPos =
      axis === 'x'
        ? { x: origin.x + offset, y: level, z: origin.z + 1 }
        : { x: origin.x + 1, y: level, z: origin.z + offset };
    branches.push(makeSegment('branch', perp, from, branchLength));
  }

  return {
    origin: { ...origin },
    level,
    mainTunnel,
    branches,
    order: [mainTunnel, ...branches],
    quitWhenYieldBelow
  };
}

export function branchYield(oresFound: number, blocksMined: number, timeSeconds: number): number {
  if (timeSeconds <= 0) {
    return oresFound > 0 ? Infinity : 0;
  }
  return (oresFound / timeSeconds) * 60;
}

export function shouldQuitBranch(
  oresFound: number,
  blocksMined: number,
  environmentAvgOrePerBlock: number = DEFAULT_ENVIRONMENT_AVG_ORE_PER_BLOCK
): boolean {
  if (blocksMined < QUIT_BLOCK_WINDOW) return false;
  if (environmentAvgOrePerBlock <= 0) {
    return oresFound <= 0;
  }
  const current = blocksMined > 0 ? oresFound / blocksMined : 0;
  return current < environmentAvgOrePerBlock;
}

const KNOWN_GOOD_LEVELS: Record<string, number[]> = {
  diamond: [-59],
  iron: [15, -59],
  coal: [96, 136],
  copper: [48],
  gold: [-16, -59],
  redstone: [-59, 15],
  lapis_lazuli: [-32],
  emerald: [256]
};

export function knownGoodLevels(item: string): number[] {
  const name = item.toLowerCase();
  return KNOWN_GOOD_LEVELS[name] ?? [];
}
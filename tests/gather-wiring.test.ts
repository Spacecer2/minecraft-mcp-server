import test from 'ava';
import sinon from 'sinon';
import type mineflayer from 'mineflayer';
import { dropLowValueIfFull, branchMineStrategy, gatherItem } from '../src/tools/gather-tools.js';
import { slotValue, HIGH_VALUE_THRESHOLD } from '../src/foraging.js';
import { shouldQuitBranch, segmentBlocks, DEFAULT_ENVIRONMENT_AVG_ORE_PER_BLOCK } from '../src/mining-strategy.js';
import { Vec3 } from 'vec3';

type FakeItem = { name: string; count: number };

function fakeBot(items: FakeItem[], emptySlotCount: number, toss?: (item: FakeItem) => void) {
  return {
    inventory: {
      items: () => items,
      emptySlotCount: () => emptySlotCount
    },
    tossStack: toss
  };
}

test('dropLowValueIfFull drops low-value items before high-value when inventory is full', (t) => {
  const dropped: FakeItem[] = [];
  const bot = fakeBot(
    [
      { name: 'dirt', count: 20 },
      { name: 'andesite', count: 16 },
      { name: 'diamond', count: 1 }
    ],
    1,
    (item) => dropped.push(item)
  );

  const droppedCount = dropLowValueIfFull(bot as never, 'diamond');

  t.is(droppedCount, 36);
  t.is(dropped.length, 2);
  t.deepEqual(
    dropped.map((i) => i.name),
    ['dirt', 'andesite']
  );
  t.false(dropped.some((i) => i.name === 'diamond'));
});

test('dropLowValueIfFull returns zero when inventory has plenty of free slots', (t) => {
  const dropped: FakeItem[] = [];
  const bot = fakeBot(
    [
      { name: 'dirt', count: 20 },
      { name: 'diamond', count: 1 }
    ],
    20,
    (item) => dropped.push(item)
  );

  const droppedCount = dropLowValueIfFull(bot as never, 'diamond');

  t.is(droppedCount, 0);
  t.is(dropped.length, 0);
});

test('dropLowValueIfFull returns zero when the gathered item is not high-value', (t) => {
  const dropped: FakeItem[] = [];
  const bot = fakeBot([{ name: 'dirt', count: 20 }], 1, (item) => dropped.push(item));

  const droppedCount = dropLowValueIfFull(bot as never, 'cobblestone');

  t.is(droppedCount, 0);
  t.is(dropped.length, 0);
});

test('dropLowValueIfFull skips items at or above the junk threshold', (t) => {
  const dropped: FakeItem[] = [];
  const bot = fakeBot(
    [
      { name: 'dirt', count: 20 },
      { name: 'coal', count: 10 }
    ],
    0,
    (item) => dropped.push(item)
  );

  const droppedCount = dropLowValueIfFull(bot as never, 'diamond');

  t.true(slotValue('coal') < HIGH_VALUE_THRESHOLD);
  t.true(slotValue('coal') >= 4);
  t.is(droppedCount, 20);
  t.is(dropped.length, 1);
  t.is(dropped[0].name, 'dirt');
});

test('branchMineStrategy returns a plan with a main tunnel and branches for ore', (t) => {
  const strategy = branchMineStrategy('diamond_ore', { x: 0, y: -59, z: 0 });

  t.true(strategy.isOre);
  t.not(strategy.plan, null);
  t.not(strategy.plan!.mainTunnel, null);
  t.true(strategy.plan!.branches.length > 0);
  t.true(strategy.plan!.order.length > 0);
});

test('branchMineStrategy reports non-ore items with no plan', (t) => {
  const strategy = branchMineStrategy('wood', { x: 0, y: 64, z: 0 });

  t.false(strategy.isOre);
  t.is(strategy.plan, null);
  t.false(strategy.shouldQuit(0, 30));
});

test('branchMineStrategy shouldQuit uses the plan yield threshold', (t) => {
  const strategy = branchMineStrategy('iron_ore', new Vec3(0, 15, 0) as never);

  t.true(strategy.isOre);
  t.true(strategy.shouldQuit(0, 30));
  t.false(strategy.shouldQuit(3, 10));
});

test('shouldQuitBranch returns true when yield drops below environment average', (t) => {
  t.true(shouldQuitBranch(0, 30, DEFAULT_ENVIRONMENT_AVG_ORE_PER_BLOCK));
});

test('shouldQuitBranch returns false within the quit block window', (t) => {
  t.false(shouldQuitBranch(3, 10, DEFAULT_ENVIRONMENT_AVG_ORE_PER_BLOCK));
});

test('shouldQuitBranch returns false when yield is above the environment average', (t) => {
  t.false(shouldQuitBranch(3, 30, DEFAULT_ENVIRONMENT_AVG_ORE_PER_BLOCK));
});

type OreFakeBot = {
  bot: mineflayer.Bot;
  items: FakeItem[];
  dugPositions: Vec3[];
  moveYs: number[];
  findBlockCalls: { count: number };
};

function makeOreFakeBot(opts: { addOrePerDig?: boolean } = {}): OreFakeBot {
  const items: FakeItem[] = [];
  const dugPositions: Vec3[] = [];
  const moveYs: number[] = [];
  const position = new Vec3(0, 64, 0);
  const findBlockCalls = { count: 0 };
  let pendingOre = 0;

  const bot = {
    version: '1.21',
    entity: { position },
    entities: new Map(),
    inventory: {
      items: () => items,
      emptySlotCount: () => 30
    },
    findBlock: () => {
      findBlockCalls.count += 1;
      return null;
    },
    blockAt: (pos: Vec3) => ({ name: 'stone', position: pos }),
    dig: async (block: { position: Vec3 }) => {
      dugPositions.push(block.position);
      if (opts.addOrePerDig) pendingOre += 1;
    },
    pathfinder: {
      goto: async (goal: { x: number; y: number; z: number }) => {
        moveYs.push(goal.y);
        position.set(goal.x, goal.y, goal.z);
        if (pendingOre > 0) {
          items.push({ name: 'diamond', count: pendingOre });
          pendingOre = 0;
        }
      }
    }
  } as unknown as mineflayer.Bot;

  return { bot, items, dugPositions, moveYs, findBlockCalls };
}

async function driveClock<T>(run: () => Promise<T>): Promise<T> {
  const clock = sinon.useFakeTimers();
  try {
    let done = false;
    let result!: T;
    let error: unknown;
    const p = run();
    p.then(
      (r) => {
        result = r;
        done = true;
      },
      (e) => {
        error = e;
        done = true;
      }
    );
    for (let i = 0; i < 10000 && !done; i++) {
      await clock.tickAsync(301);
    }
    if (!done) throw new Error('gatherItem did not settle within the virtual time budget');
    if (error) throw error;
    return result;
  } finally {
    clock.restore();
  }
}

test.serial('gatherItem with branchMining moves to the known-good level and digs every planned segment', async (t) => {
  const { bot, dugPositions, moveYs, findBlockCalls } = makeOreFakeBot({ addOrePerDig: true });
  const strategy = branchMineStrategy('diamond', new Vec3(0, 64, 0));
  const plan = strategy.plan!;
  const expectedBlocks = plan.order.reduce((n, seg) => n + segmentBlocks(seg).length, 0);
  const plannedPositions = new Set(
    plan.order.flatMap((seg) => segmentBlocks(seg).map((p) => `${p.x},${p.y},${p.z}`))
  );

  const result = await driveClock(() => gatherItem(bot, 'diamond', 999, 10, { branchMining: true }));

  t.is(result.quitBranch, false);
  t.is(result.dug, expectedBlocks);
  t.is(result.blocksMined, expectedBlocks);
  t.is(result.oresFound, expectedBlocks);
  t.is(result.have, expectedBlocks);
  t.is(moveYs[0], -59);
  t.is(dugPositions.length, expectedBlocks);
  t.true(dugPositions.every((p) => plannedPositions.has(`${p.x},${p.y},${p.z}`)));
  t.is(findBlockCalls.count, 0);
});

test.serial('gatherItem with branchMining quits when ore yield drops below the environment average', async (t) => {
  const { bot, dugPositions, moveYs } = makeOreFakeBot({ addOrePerDig: false });

  const result = await driveClock(() => gatherItem(bot, 'diamond', 999, 10, { branchMining: true }));

  t.is(result.quitBranch, true);
  t.is(result.blocksMined, 30);
  t.is(result.dug, 30);
  t.is(result.oresFound, 0);
  t.is(result.have, 0);
  t.is(moveYs[0], -59);
  t.is(dugPositions.length, 30);
});

test.serial('gatherItem leaves branch mining off by default and falls back to findBlock', async (t) => {
  const { bot, dugPositions, moveYs, findBlockCalls } = makeOreFakeBot({ addOrePerDig: true });

  const result = await gatherItem(bot, 'diamond', 3, 5);

  t.is(result.quitBranch, false);
  t.is(result.dug, 0);
  t.is(result.have, 0);
  t.is(moveYs.length, 0);
  t.is(dugPositions.length, 0);
  t.true(findBlockCalls.count > 0);
});

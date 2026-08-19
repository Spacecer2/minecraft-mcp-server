import test from 'ava';
import {
  planBranchMine,
  segmentBlocks,
  branchYield,
  shouldQuitBranch,
  knownGoodLevels,
  QUIT_BLOCK_WINDOW,
  DEFAULT_BRANCH_SPACING
} from '../src/mining-strategy.js';

test('planBranchMine generates a main tunnel and branches every 3 blocks', (t) => {
  const plan = planBranchMine({ x: 0, y: -59, z: 0 });

  t.is(plan.mainTunnel.kind, 'main');
  t.is(plan.mainTunnel.axis, 'x');
  t.is(plan.mainTunnel.length, 6 * DEFAULT_BRANCH_SPACING + 1);
  t.is(plan.branches.length, 6);
  t.is(plan.order.length, 7);
  t.deepEqual(plan.order[0], plan.mainTunnel);

  plan.branches.forEach((branch, i) => {
    t.is(branch.kind, 'branch');
    t.is(branch.axis, 'z');
    t.is(branch.from.x, (i + 1) * DEFAULT_BRANCH_SPACING);
  });
});

test('planBranchMine segments are 2-high 1-wide', (t) => {
  const plan = planBranchMine({ x: 0, y: -59, z: 0 }, { branchLength: 4, branchCount: 2 });

  for (const seg of plan.order) {
    const blocks = segmentBlocks(seg);
    t.is(blocks.length, seg.length * 2);
    for (const b of blocks) {
      t.true(b.y === -59 || b.y === -58);
    }
    const along = new Set(blocks.map((b) => (seg.axis === 'x' ? b.x : b.z)));
    t.is(along.size, seg.length);
  }
});

test('planBranchMine honors custom spacing, count, and level', (t) => {
  const plan = planBranchMine({ x: 100, y: 40, z: -50 }, { branchSpacing: 3, branchCount: 4, level: -59 });

  t.is(plan.level, -59);
  t.deepEqual(plan.branches.map((b) => b.from.x - 100), [3, 6, 9, 12]);
  t.is(plan.mainTunnel.length, 4 * 3 + 1);
});

test('branchYield computes ores per minute', (t) => {
  t.is(branchYield(3, 30, 60), 3);
  t.is(branchYield(0, 30, 60), 0);
  t.is(branchYield(2, 10, 0), Infinity);
});

test('shouldQuitBranch quits when ~0 ores are found in 30 blocks', (t) => {
  t.true(shouldQuitBranch(0, QUIT_BLOCK_WINDOW, 0.05));
  t.true(shouldQuitBranch(1, QUIT_BLOCK_WINDOW, 0.05));
  t.true(shouldQuitBranch(0, QUIT_BLOCK_WINDOW, 0));
});

test('shouldQuitBranch keeps mining when yield is above the environment average', (t) => {
  t.false(shouldQuitBranch(5, QUIT_BLOCK_WINDOW, 0.05));
  t.false(shouldQuitBranch(0, QUIT_BLOCK_WINDOW - 1, 0.05));
  t.false(shouldQuitBranch(5, QUIT_BLOCK_WINDOW, 0));
});

test('knownGoodLevels returns the target y-levels', (t) => {
  t.deepEqual(knownGoodLevels('diamond'), [-59]);
  t.deepEqual(knownGoodLevels('iron'), [15, -59]);
  t.true(knownGoodLevels('coal').length > 0);
  t.true(knownGoodLevels('coal').every((y) => y > 0));
  t.true(knownGoodLevels('copper').length > 0);
  t.deepEqual(knownGoodLevels('dirt'), []);
});
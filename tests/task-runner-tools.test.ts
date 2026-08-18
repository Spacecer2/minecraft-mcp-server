import test from 'ava';
import sinon from 'sinon';
import minecraftData from 'minecraft-data';
import { registerTaskRunnerTools, resetTaskRuns } from '../src/tools/task-runner-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import type mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import { setInterrupt, clearInterrupt } from '../src/interrupt.js';

type Executor = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;

function makeBuildBot() {
  const botPos = new Vec3(0, 70, 0);
  const placed = new Map<string, string>();

  const blockAt = sinon.stub().callsFake((pos: Vec3) => {
    const key = `${pos.x},${pos.y},${pos.z}`;
    if (placed.has(key)) return { name: placed.get(key), position: pos };
    if (pos.y === 63) return { name: 'stone', position: pos };
    return { name: 'air', position: pos };
  });

  const placeBlock = sinon.stub().callsFake(async (ref: { position: Vec3 }, vec: Vec3) => {
    const target = ref.position.plus(vec);
    placed.set(`${target.x},${target.y},${target.z}`, 'oak_planks');
  });

  const bot = {
    entity: { position: botPos },
    blockAt,
    placeBlock,
    canSeeBlock: () => true,
    lookAt: sinon.stub().resolves(),
    pathfinder: { goto: sinon.stub().resolves() }
  } as unknown as Partial<mineflayer.Bot>;

  return { bot, blockAt, placeBlock };
}

function makeGatherBot(targetCount: number) {
  let dug = false;
  const findBlock = sinon.stub().returns({ name: 'oak_log', position: new Vec3(5, 64, 8) });
  const inventory = sinon.stub().callsFake(() =>
    dug ? [{ name: 'oak_log', count: targetCount, slot: 1 }] : []
  );
  const dig = sinon.stub().callsFake(async () => { dug = true; });
  const goto = sinon.stub().resolves();

  const bot = {
    version: '1.21',
    entity: { position: new Vec3(0, 64, 0) },
    findBlock,
    inventory: { items: inventory },
    dig,
    pathfinder: { goto }
  } as unknown as Partial<mineflayer.Bot>;

  return { bot, findBlock, inventory, dig, goto };
}

type InvItem = { name: string; count: number; slot: number };
type EntityLike = { type?: string; username?: string; name?: string; position: Vec3 };

function makeDeliverBot(items: InvItem[]) {
  let inv = [...items];
  const player: EntityLike = { type: 'player', username: 'Spacecer2', position: new Vec3(145, -59, 31) };
  const inventory = sinon.stub().callsFake(() => inv);
  const tossStack = sinon.stub().callsFake(async (item: InvItem) => {
    inv = inv
      .map(i => (i.name === item.name ? { ...i, count: 0 } : i))
      .filter(i => i.count > 0);
  });
  const nearestEntity = sinon.stub().callsFake((filter: (e: EntityLike) => boolean) => (filter(player) ? player : null));
  const goto = sinon.stub().resolves();

  const bot = {
    version: '1.21',
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: inventory },
    tossStack,
    nearestEntity,
    pathfinder: { goto }
  } as unknown as Partial<mineflayer.Bot>;

  return { bot, inventory, tossStack, nearestEntity, goto, player };
}

function makeCropBreadBot() {
  const wheatId = minecraftData('1.21').blocksByName.wheat.id;
  const wheatPos = new Vec3(10, 63, 5);
  let inv: InvItem[] = [];
  const player: EntityLike = { type: 'player', username: 'Spacecer2', position: new Vec3(145, -59, 31) };

  const findBlocks = sinon.stub().callsFake(({ matching }: { matching: number }) =>
    matching === wheatId ? [wheatPos] : []
  );
  const blockAt = sinon.stub().callsFake((pos: Vec3) =>
    pos.equals(wheatPos)
      ? { name: 'wheat', metadata: 7, position: wheatPos }
      : { name: 'air', position: pos }
  );
  const dig = sinon.stub().callsFake(async () => {
    inv = [...inv, { name: 'wheat', count: 4, slot: 1 }];
  });
  const recipesFor = sinon.stub().returns([{ id: 1 }]);
  const craft = sinon.stub().callsFake(async () => {
    inv = inv
      .map(i => (i.name === 'wheat' ? { ...i, count: i.count - 3 } : i))
      .filter(i => i.count > 0);
    inv = [...inv, { name: 'bread', count: 1, slot: 2 }];
  });
  const inventory = sinon.stub().callsFake(() => inv);
  const nearestEntity = sinon.stub().callsFake((filter: (e: EntityLike) => boolean) => (filter(player) ? player : null));
  const tossStack = sinon.stub().callsFake(async (item: InvItem) => {
    inv = inv
      .map(i => (i.name === item.name ? { ...i, count: 0 } : i))
      .filter(i => i.count > 0);
  });
  const goto = sinon.stub().resolves();

  const bot = {
    version: '1.21',
    entity: { position: new Vec3(0, 64, 0) },
    findBlocks,
    blockAt,
    dig,
    recipesFor,
    craft,
    inventory: { items: inventory },
    nearestEntity,
    tossStack,
    pathfinder: { goto }
  } as unknown as Partial<mineflayer.Bot>;

  return { bot, findBlocks, blockAt, dig, recipesFor, craft, inventory, nearestEntity, tossStack, goto, player };
}

function makeNoWheatBot() {
  let inv: InvItem[] = [];
  const player: EntityLike = { type: 'player', username: 'Spacecer2', position: new Vec3(1, 2, 3) };
  const findBlocks = sinon.stub().returns([]);
  const findBlock = sinon.stub().returns(null);
  const blockAt = sinon.stub().returns({ name: 'air', position: new Vec3(0, 0, 0) });
  const inventory = sinon.stub().callsFake(() => inv);
  const nearestEntity = sinon.stub().callsFake((filter: (e: EntityLike) => boolean) => (filter(player) ? player : null));
  const goto = sinon.stub().resolves();

  const bot = {
    version: '1.21',
    entity: { position: new Vec3(0, 64, 0) },
    findBlocks,
    findBlock,
    blockAt,
    inventory: { items: inventory },
    nearestEntity,
    pathfinder: { goto }
  } as unknown as Partial<mineflayer.Bot>;

  return { bot, findBlocks, findBlock, inventory, nearestEntity, goto, player };
}

function setup(bot: Partial<mineflayer.Bot>) {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const mockManager = {
    getPrimaryName: sinon.stub().returns('primary'),
    getConnection: sinon.stub().returns(mockConnection)
  };
  const factory = new ToolFactory(mockServer, mockManager);
  registerTaskRunnerTools(factory, () => bot as mineflayer.Bot);
  resetTaskRuns();
  const getExecutor = (name: string): Executor => {
    const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
    const call = toolCalls.find((c) => c.args[0] === name);
    return call!.args[3] as Executor;
  };
  return { mockServer, factory, getExecutor };
}

test.serial('registerTaskRunnerTools registers all four task tools', (t) => {
  const { mockServer } = setup(makeBuildBot().bot);
  const names = (mockServer.tool as sinon.SinonStub).getCalls().map(c => c.args[0]);
  for (const name of ['run-goal', 'run-task-status', 'run-task-step', 'abort-task']) {
    t.true(names.includes(name), `missing ${name}`);
  }
});

test.serial('run-goal build creates a task-run and reports a start message', async (t) => {
  const { getExecutor } = setup(makeBuildBot().bot);
  const runGoal = getExecutor('run-goal');
  const status = getExecutor('run-task-status');

  const result = await runGoal({ goal: 'build a cottage', template: 'cottage' });
  t.false(!!result.isError);
  t.is(
    result.content[0].text,
    'Started build goal 1: building cottage at (0,70,0). Execute with task-run-status / run-task-step.'
  );

  const st = await status({});
  t.false(!!st.isError);
  t.true(st.content[0].text.includes('Task 1: build cottage at (0,70,0)'));
  t.true(st.content[0].text.includes('Status: running'));
  t.true(st.content[0].text.includes('Progress: 0/'));
  t.true(st.content[0].text.includes('blocks placed (stage: foundation)'));
});

test.serial('run-goal build defaults to house and uses the bot position as anchor', async (t) => {
  const { getExecutor } = setup(makeBuildBot().bot);
  const runGoal = getExecutor('run-goal');

  const result = await runGoal({ goal: 'build a shed', x: 10, y: 64, z: 20 });
  t.false(!!result.isError);
  t.is(
    result.content[0].text,
    'Started build goal 1: building shed at (10,64,20). Execute with task-run-status / run-task-step.'
  );
});

test.serial('run-goal build rejects an unknown template', async (t) => {
  const { getExecutor } = setup(makeBuildBot().bot);
  const runGoal = getExecutor('run-goal');

  const result = await runGoal({ goal: 'build a castle', template: 'castle' });
  t.true(!!result.isError);
  t.true(result.content[0].text.includes('Unknown template castle. Use list-templates.'));
});

test.serial('run-goal collect gathers items and reports completion', async (t) => {
  const gather = makeGatherBot(32);
  const { getExecutor } = setup(gather.bot);
  const runGoal = getExecutor('run-goal');
  const status = getExecutor('run-task-status');

  const result = await runGoal({ goal: 'collect 32 wood' });
  t.false(!!result.isError);
  t.is(result.content[0].text, 'Gather goal complete: have 32/32 wood.');
  t.true(gather.findBlock.calledOnce);
  t.true(gather.dig.calledOnce);
  t.true(gather.goto.calledOnce);
  t.is(gather.findBlock.firstCall.args[0].matching, minecraftData('1.21').blocksByName.oak_log.id);
  t.is(gather.findBlock.firstCall.args[0].maxDistance, 24);

  const st = await status({});
  t.false(!!st.isError);
  t.true(st.content[0].text.includes('Status: done'));
  t.true(st.content[0].text.includes('Progress: have 32/32 wood'));
});

test.serial('run-goal collect defaults the count to 16 without a number', async (t) => {
  const gather = makeGatherBot(16);
  const { getExecutor } = setup(gather.bot);
  const runGoal = getExecutor('run-goal');

  const result = await runGoal({ goal: 'gather wood' });
  t.false(!!result.isError);
  t.is(result.content[0].text, 'Gather goal complete: have 16/16 wood.');
});

test.serial('run-goal returns an error for an unknown goal', async (t) => {
  const { getExecutor } = setup(makeBuildBot().bot);
  const runGoal = getExecutor('run-goal');

  const result = await runGoal({ goal: 'fly to the moon' });
  t.true(!!result.isError);
  t.true(
    result.content[0].text.includes(
      "Unknown goal 'fly to the moon'. Supported: build <template>, collect <n> <item>, harvest <crop>, give/drop <food>."
    )
  );
});

test.serial('run-goal drop bread delivers existing bread without crafting', async (t) => {
  const { bot, tossStack, nearestEntity, goto } = makeDeliverBot([{ name: 'bread', count: 1, slot: 1 }]);
  const { getExecutor } = setup(bot);
  const runGoal = getExecutor('run-goal');

  const result = await runGoal({ goal: 'drop me some bread' });
  t.false(!!result.isError);
  t.is(result.content[0].text, 'delivered bread x1 to Spacecer2 at (145,-59,31)');
  t.true(tossStack.calledOnce);
  t.true(nearestEntity.called);
  t.true(goto.called);
});

test.serial('run-goal give me bread also delivers existing bread', async (t) => {
  const { bot, tossStack } = makeDeliverBot([{ name: 'bread', count: 1, slot: 1 }]);
  const { getExecutor } = setup(bot);
  const runGoal = getExecutor('run-goal');

  const result = await runGoal({ goal: 'give me bread' });
  t.false(!!result.isError);
  t.is(result.content[0].text, 'delivered bread x1 to Spacecer2 at (145,-59,31)');
  t.true(tossStack.calledOnce);
});

test.serial('run-goal harvest wheat harvests mature crops', async (t) => {
  const { bot, dig } = makeCropBreadBot();
  const { getExecutor } = setup(bot);
  const runGoal = getExecutor('run-goal');

  const result = await runGoal({ goal: 'harvest wheat' });
  t.false(!!result.isError);
  t.is(result.content[0].text, 'harvested 4 wheat');
  t.true(dig.calledOnce);
});

test.serial('run-goal crops then bread harvests, makes and delivers', async (t) => {
  const { bot, dig, craft, tossStack } = makeCropBreadBot();
  const { getExecutor } = setup(bot);
  const runGoal = getExecutor('run-goal');

  const result = await runGoal({ goal: 'get some crops and drop me some bread' });
  t.false(!!result.isError);
  t.is(
    result.content[0].text,
    'harvested 4 wheat → made bread x1 → delivered bread x1 to Spacecer2 at (145,-59,31)'
  );
  t.true(dig.calledOnce);
  t.true(craft.calledOnce);
  t.true(tossStack.calledOnce);
});

test.serial('run-goal bread blocks with needDecision when no wheat is available', async (t) => {
  const { bot, findBlocks } = makeNoWheatBot();
  const { getExecutor } = setup(bot);
  const runGoal = getExecutor('run-goal');

  const result = await runGoal({ goal: 'drop me some bread' });
  t.false(!!result.isError);
  t.true(result.content[0].text.includes('BLOCKED: no wheat available'));
  t.true(result.content[0].text.includes('"missing":"wheat"'));
  t.true(result.content[0].text.includes('run-task-resume'));
  t.true(findBlocks.called);
});

test.serial('run-task-step advances a build task by placing the next plan blocks', async (t) => {
  const { bot, placeBlock } = makeBuildBot();
  const { getExecutor } = setup(bot);
  const runGoal = getExecutor('run-goal');
  const step = getExecutor('run-task-step');
  const status = getExecutor('run-task-status');

  await runGoal({ goal: 'build a house', x: 10, y: 64, z: 20 });
  const result = await step({ steps: 3 });
  t.false(!!result.isError);
  t.is(result.content[0].text, 'Executed 3 step(s): 3 placed, 0 failed. Progress: 3/173 blocks.');
  t.is(placeBlock.callCount, 3);

  const st = await status({});
  t.true(st.content[0].text.includes('Progress: 3/173 blocks placed'));
  t.true(st.content[0].text.includes('Status: running'));
});

test.serial('run-task-step reports an already-complete goal', async (t) => {
  const { bot } = makeBuildBot();
  const { getExecutor } = setup(bot);
  const runGoal = getExecutor('run-goal');
  const step = getExecutor('run-task-step');

  await runGoal({ goal: 'build a house', x: 10, y: 64, z: 20 });
  await step({ steps: 1000 });
  const result = await step({ steps: 5 });
  t.false(!!result.isError);
  t.is(result.content[0].text, 'Goal 1 already complete.');
});

test.serial('run-task-status errors when no task-run exists', async (t) => {
  const { getExecutor } = setup(makeBuildBot().bot);
  const status = getExecutor('run-task-status');

  const result = await status({});
  t.true(!!result.isError);
  t.true(result.content[0].text.includes('No task-run found. Start one with run-goal.'));
});

test.serial('abort-task marks the task failed and clears its plan', async (t) => {
  const { getExecutor } = setup(makeBuildBot().bot);
  const runGoal = getExecutor('run-goal');
  const abort = getExecutor('abort-task');
  const status = getExecutor('run-task-status');

  await runGoal({ goal: 'build a shed' });
  const aborted = await abort({});
  t.false(!!aborted.isError);
  t.is(aborted.content[0].text, 'Task 1 aborted.');

  const st = await status({});
  t.true(st.content[0].text.includes('Status: failed'));
  t.true(st.content[0].text.includes('Error: aborted by user'));
});

test.serial('run-goal returns INTERRUPTED when the interrupt flag is set', async (t) => {
  clearInterrupt();
  setInterrupt('test');
  t.teardown(() => clearInterrupt());

  const { bot } = makeBuildBot();
  const { getExecutor } = setup(bot);
  const runGoal = getExecutor('run-goal');

  const result = await runGoal({ goal: 'build a house' });
  t.true(!!result.isError);
  t.true(result.content[0].text.includes('INTERRUPTED'));
});

test.serial('run-task-step returns INTERRUPTED and leaves the task resumable', async (t) => {
  const { bot } = makeBuildBot();
  const { getExecutor } = setup(bot);
  const runGoal = getExecutor('run-goal');
  const step = getExecutor('run-task-step');
  const status = getExecutor('run-task-status');

  await runGoal({ goal: 'build a house', x: 10, y: 64, z: 20 });

  clearInterrupt();
  setInterrupt('test');
  t.teardown(() => clearInterrupt());
  const result = await step({ steps: 5 });

  t.true(!!result.isError);
  t.true(result.content[0].text.includes('INTERRUPTED'));

  const st = await status({});
  t.true(st.content[0].text.includes('Status: running'));
});

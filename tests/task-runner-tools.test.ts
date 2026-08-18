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
  t.true(result.content[0].text.includes("Unknown goal 'fly to the moon'. Supported: build <template>, collect <n> <item>."));
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

test.serial('run-task-step returns INTERRUPTED and leaves the task resumable', async (t) => {
  clearInterrupt();
  setInterrupt('test');
  t.teardown(() => clearInterrupt());

  const { bot } = makeBuildBot();
  const { getExecutor } = setup(bot);
  const runGoal = getExecutor('run-goal');
  const step = getExecutor('run-task-step');
  const status = getExecutor('run-task-status');

  await runGoal({ goal: 'build a house', x: 10, y: 64, z: 20 });
  const result = await step({ steps: 5 });

  t.true(!!result.isError);
  t.true(result.content[0].text.includes('INTERRUPTED'));

  const st = await status({});
  t.true(st.content[0].text.includes('Status: running'));
});

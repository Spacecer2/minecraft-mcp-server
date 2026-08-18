import test from 'ava';
import sinon from 'sinon';
import { registerPlanTools, resetPlans } from '../src/tools/plan-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import type mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import { setInterrupt, clearInterrupt } from '../src/interrupt.js';

function makePlanBot() {
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

function setup() {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const mockManager = {
    getPrimaryName: sinon.stub().returns('primary'),
    getConnection: sinon.stub().returns(mockConnection)
  };
  const factory = new ToolFactory(mockServer, mockManager);
  const { bot, blockAt, placeBlock } = makePlanBot();
  registerPlanTools(factory, () => bot as mineflayer.Bot);
  resetPlans();
  return { mockServer, factory, bot, blockAt, placeBlock };
}

function getExecutor(mockServer: McpServer, toolName: string) {
  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const call = toolCalls.find(c => c.args[0] === toolName);
  return call!.args[3];
}

test.serial('registerPlanTools registers all four plan tools', (t) => {
  const { mockServer } = setup();
  const names = (mockServer.tool as sinon.SinonStub).getCalls().map(c => c.args[0]);
  for (const name of ['plan-build', 'plan-status', 'execute-plan', 'abort-plan']) {
    t.true(names.includes(name), `missing ${name}`);
  }
});

test.serial('plan-build creates a plan from a template', async (t) => {
  const { mockServer } = setup();
  const planBuild = getExecutor(mockServer, 'plan-build');

  const result = await planBuild({ name: 'test-house', x: 10, y: 64, z: 20, template: 'house' });
  t.false(!!result.isError);
  t.is(result.content[0].text, 'Plan 1 created: 173 blocks across 3 stages.');
});

test.serial('plan-build accepts custom dimensions and palette', async (t) => {
  const { mockServer } = setup();
  const planBuild = getExecutor(mockServer, 'plan-build');

  const result = await planBuild({
    name: 'shed', x: 0, y: 64, z: 0, template: 'shed',
    w: 4, d: 4, palette: { wall: 'stone_bricks' }
  });
  t.false(!!result.isError);
  t.true(result.content[0].text.includes('blocks across'));
});

test.serial('plan-build rejects an unknown template', async (t) => {
  const { mockServer } = setup();
  const planBuild = getExecutor(mockServer, 'plan-build');

  const result = await planBuild({ name: 'x', x: 0, y: 64, z: 0, template: 'castle' });
  t.true(!!result.isError);
  t.true(result.content[0].text.includes('Unknown template castle. Use list-templates.'));
});

test.serial('plan-status returns a summary of the last plan', async (t) => {
  const { mockServer } = setup();
  const planBuild = getExecutor(mockServer, 'plan-build');
  const planStatus = getExecutor(mockServer, 'plan-status');

  await planBuild({ name: 'test-house', x: 10, y: 64, z: 20, template: 'house' });
  const result = await planStatus({});
  t.false(!!result.isError);

  const text = result.content[0].text;
  t.true(text.includes('Plan 1: test-house (house) at (10,64,20)'));
  t.true(text.includes('Total: 173 blocks (0 placed, 173 pending)'));
  t.true(text.includes('Stages: foundation (29), walls (90), roof (54)'));
  t.true(text.includes('Current stage: foundation'));
  t.true(text.includes('Next steps:'));
  t.true(text.includes('#0 oak_log at (10,64,20) [foundation]'));
});

test.serial('plan-status reports an error when no plan exists', async (t) => {
  const { mockServer } = setup();
  const planStatus = getExecutor(mockServer, 'plan-status');

  const result = await planStatus({});
  t.true(!!result.isError);
  t.true(result.content[0].text.includes('No plan found. Create one with plan-build.'));
});

test.serial('execute-plan places the next blocks and marks them placed', async (t) => {
  const { mockServer, placeBlock } = setup();
  const planBuild = getExecutor(mockServer, 'plan-build');
  const execute = getExecutor(mockServer, 'execute-plan');
  const planStatus = getExecutor(mockServer, 'plan-status');

  await planBuild({ name: 'test-house', x: 10, y: 64, z: 20, template: 'house' });
  const result = await execute({ steps: 8 });
  t.false(!!result.isError);
  t.is(result.content[0].text, 'Executed 8 step(s): 8 placed, 0 failed. Next: 165 remaining.');
  t.is(placeBlock.callCount, 8);

  const status = await planStatus({});
  t.true(status.content[0].text.includes('Total: 173 blocks (8 placed, 165 pending)'));
});

test.serial('execute-plan defaults to 8 steps and can be scoped by id', async (t) => {
  const { mockServer } = setup();
  const planBuild = getExecutor(mockServer, 'plan-build');
  const execute = getExecutor(mockServer, 'execute-plan');

  await planBuild({ name: 'first', x: 10, y: 64, z: 20, template: 'house' });
  await planBuild({ name: 'second', x: 30, y: 64, z: 20, template: 'house' });

  const result = await execute({ id: 1, steps: 2 });
  t.false(!!result.isError);
  t.true(result.content[0].text.includes('Executed 2 step(s): 2 placed, 0 failed. Next: 171 remaining.'));
});

test.serial('execute-plan with a stage filter only places blocks from that stage', async (t) => {
  const { mockServer } = setup();
  const planBuild = getExecutor(mockServer, 'plan-build');
  const execute = getExecutor(mockServer, 'execute-plan');

  await planBuild({ name: 'test-house', x: 10, y: 64, z: 20, template: 'house' });

  const first = await execute({ stage: 'foundation', steps: 5 });
  t.false(!!first.isError);
  t.is(first.content[0].text, 'Executed 5 step(s): 5 placed, 0 failed. Next: 168 remaining.');

  const rest = await execute({ stage: 'foundation', steps: 100 });
  t.false(!!rest.isError);
  t.is(rest.content[0].text, 'Executed 24 step(s): 24 placed, 0 failed. Next: 144 remaining.');
});

test.serial('execute-plan stops on a failure and marks the step failed', async (t) => {
  const { mockServer, blockAt } = setup();
  const planBuild = getExecutor(mockServer, 'plan-build');
  const execute = getExecutor(mockServer, 'execute-plan');

  // Occupy the first target block so placement fails.
  blockAt.callsFake((pos: Vec3) => {
    if (pos.y === 64 && pos.x === 10 && pos.z === 20) return { name: 'cobblestone', position: pos };
    if (pos.y === 63) return { name: 'stone', position: pos };
    return { name: 'air', position: pos };
  });

  await planBuild({ name: 'test-house', x: 10, y: 64, z: 20, template: 'house' });
  const result = await execute({ steps: 8 });
  t.false(!!result.isError);
  t.true(result.content[0].text.includes('Executed 1 step(s): 0 placed, 1 failed.'));
});

test.serial('execute-plan reports an error when no plan exists', async (t) => {
  const { mockServer } = setup();
  const execute = getExecutor(mockServer, 'execute-plan');

  const result = await execute({ steps: 8 });
  t.true(!!result.isError);
  t.true(result.content[0].text.includes('No plan found. Create one with plan-build.'));
});

test.serial('abort-plan clears a plan by id', async (t) => {
  const { mockServer } = setup();
  const planBuild = getExecutor(mockServer, 'plan-build');
  const planStatus = getExecutor(mockServer, 'plan-status');
  const abort = getExecutor(mockServer, 'abort-plan');

  await planBuild({ name: 'test-house', x: 10, y: 64, z: 20, template: 'house' });
  const aborted = await abort({ id: 1 });
  t.false(!!aborted.isError);
  t.true(aborted.content[0].text.includes('Plan 1 aborted and cleared.'));

  const status = await planStatus({});
  t.true(!!status.isError);
});

test.serial('abort-plan with no id clears all plans', async (t) => {
  const { mockServer } = setup();
  const planBuild = getExecutor(mockServer, 'plan-build');
  const planStatus = getExecutor(mockServer, 'plan-status');
  const abort = getExecutor(mockServer, 'abort-plan');

  await planBuild({ name: 'one', x: 10, y: 64, z: 20, template: 'house' });
  const aborted = await abort({});
  t.false(!!aborted.isError);
  t.true(aborted.content[0].text.includes('All plans aborted and cleared.'));

  const status = await planStatus({});
  t.true(!!status.isError);
});

test.serial('execute-plan returns INTERRUPTED when the interrupt flag is set', async (t) => {
  clearInterrupt();
  setInterrupt('test');
  t.teardown(() => clearInterrupt());

  const { mockServer, placeBlock } = setup();
  const planBuild = getExecutor(mockServer, 'plan-build');
  const execute = getExecutor(mockServer, 'execute-plan');

  await planBuild({ name: 'test-house', x: 10, y: 64, z: 20, template: 'house' });
  const result = await execute({ steps: 8 });

  t.true(!!result.isError);
  t.true(result.content[0].text.includes('Executed 0 step(s); INTERRUPTED'));
  t.true(result.content[0].text.includes('INTERRUPTED'));
  t.is(placeBlock.callCount, 0);
});

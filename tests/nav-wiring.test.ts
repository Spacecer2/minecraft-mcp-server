import test from 'ava';
import sinon from 'sinon';
import { Vec3 } from 'vec3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import type mineflayer from 'mineflayer';
import { ToolFactory } from '../src/tool-factory.js';
import { registerMapTools, graphPath } from '../src/tools/map-tools.js';
import { registerNavigationTools } from '../src/tools/navigation-tools.js';
import {
  resetNavigationGraphForTest,
  getNode,
  nodes,
  markTraversed
} from '../src/navigation-graph.js';
import { tripBudget } from '../src/dead-reckoning.js';

function setupTools(bot: Partial<mineflayer.Bot>) {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const mockManager = {
    getPrimaryName: sinon.stub().returns('primary'),
    getConnection: sinon.stub().returns(mockConnection)
  };
  const factory = new ToolFactory(mockServer, mockManager);
  return { mockServer, factory, getBot: () => bot as mineflayer.Bot };
}

function executorFor(mockServer: McpServer, name: string) {
  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const call = toolCalls.find(c => c.args[0] === name);
  return call!.args[3];
}

function makeBot(position = new Vec3(0, 64, 0)) {
  return {
    entity: { position },
    game: { dimension: 'minecraft:overworld' }
  } as unknown as Partial<mineflayer.Bot>;
}

test.beforeEach(() => {
  resetNavigationGraphForTest();
});

test.serial('map-mark mirrors landmarks into the navigation graph and graphPath routes through an intermediate', async (t) => {
  const bot = makeBot(new Vec3(0, 64, 0));
  const { mockServer, factory, getBot } = setupTools(bot);
  registerMapTools(factory, getBot);
  const mark = executorFor(mockServer, 'map-mark');
  const clear = executorFor(mockServer, 'map-clear');

  await clear({});
  await mark({ name: 'base', type: 'base', x: 0, y: 64, z: 0 });
  await mark({ name: 'cave', type: 'cave', x: 10, y: 40, z: 0 });
  await mark({ name: 'village', type: 'village', x: 20, y: 64, z: 0 });

  const graphNodes = nodes();
  t.is(graphNodes.length, 3);
  t.is(getNode(graphNodes[0].id)?.name, 'base');
  t.is(getNode(graphNodes[1].id)?.type, 'cave');
  t.is(getNode(graphNodes[2].id)?.type, 'village');

  // No edges exist from marking alone, so no path yet.
  t.is(graphPath(graphNodes[0].id, graphNodes[2].id), null);
  t.is(graphPath('landmark-1', 'landmark-3'), null);

  // Wire the traversal chain the way explore does, then the path resolves.
  markTraversed(graphNodes[0].id, graphNodes[1].id, 10);
  markTraversed(graphNodes[1].id, graphNodes[2].id, 20);
  t.deepEqual(graphPath(graphNodes[0].id, graphNodes[2].id), [
    graphNodes[0].id, graphNodes[1].id, graphNodes[2].id
  ]);
  t.deepEqual(graphPath('landmark-1', 'landmark-3'), [
    graphNodes[0].id, graphNodes[1].id, graphNodes[2].id
  ]);
});

test.serial('graphPath returns null for unknown landmark ids', (t) => {
  t.is(graphPath('landmark-999', 'landmark-1000'), null);
  t.is(graphPath('node-999', 'node-1000'), null);
});

test('tripBudget is infeasible when the target is too far for the deadline and feasible when close', (t) => {
  const now = Date.now();
  const far = tripBudget({ x: 1000, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 20, now + 10 * 60000, now);
  t.false(far.feasible);
  t.is(far.remainingTime, 10);
  t.is(far.returnDistance, 1000);

  const close = tripBudget({ x: 100, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 20, now + 10 * 60000, now);
  t.true(close.feasible);
});

test('trip-check returns the budget fields and the return vector home', async (t) => {
  const bot = makeBot(new Vec3(0, 0, 0));
  const { mockServer, factory, getBot } = setupTools(bot);
  registerNavigationTools(factory, getBot);
  const tripCheck = executorFor(mockServer, 'trip-check');

  const tooFar = await tripCheck({ x: 100, y: 0, z: 0, distancePerMinute: 20, returnDeadlineMinutes: 2 });
  t.falsy(tooFar.isError);
  const farPayload = JSON.parse(tooFar.content[0].text);
  t.false(farPayload.feasible);
  t.is(farPayload.remainingTime, 2);
  t.is(farPayload.returnDistance, 100);
  t.is(farPayload.maxSafeOutreach, 20);
  t.deepEqual(farPayload.returnVector, { x: 100, y: 0, z: 0 });

  const close = await tripCheck({ x: 30, y: 0, z: 0, distancePerMinute: 20, returnDeadlineMinutes: 5 });
  const closePayload = JSON.parse(close.content[0].text);
  t.true(closePayload.feasible);
});

test('trip-check errors when the bot has no position', async (t) => {
  const { mockServer, factory, getBot } = setupTools({} as Partial<mineflayer.Bot>);
  registerNavigationTools(factory, getBot);
  const tripCheck = executorFor(mockServer, 'trip-check');
  const result = await tripCheck({});
  t.true(result.isError);
  t.true(result.content[0].text.includes('No position available'));
});


import test from 'ava';
import sinon from 'sinon';
import type mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import { ucbBonus } from '../src/risk-evaluator.js';
import { setDeadReckonedPos, getNode, nodes, resetNavigationGraphForTest } from '../src/navigation-graph.js';
import {
  registerMapTools,
  reSightLandmark,
  setSectorVisitCounts
} from '../src/tools/map-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';

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
  return { mockServer, factory };
}

function getExecutor(mockServer: McpServer, toolName: string) {
  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const call = toolCalls.find(c => c.args[0] === toolName);
  return call!.args[3];
}

function makeBot(health?: number) {
  return {
    entity: { position: new Vec3(0, 64, 0) },
    game: { dimension: 'minecraft:overworld' },
    health,
    blockAt: sinon.stub().returns({ name: 'air' })
  } as unknown as Partial<mineflayer.Bot>;
}

function registerAll(mockServer: McpServer, factory: ToolFactory, bot: Partial<mineflayer.Bot>) {
  registerMapTools(factory, () => bot as mineflayer.Bot);
  const exec = (name: string) => getExecutor(mockServer, name);
  return { mark: exec('map-mark'), explore: exec('explore') };
}

test('ucbBonus favors novel (unvisited) sectors over heavily visited ones', (t) => {
  const novel = ucbBonus(0, 100, 2);
  const visited = ucbBonus(50, 100, 2);
  t.true(novel > visited);
  t.true(novel > 0);
});

test('reSightLandmark returns a drift vector and pulls the node toward actual', async (t) => {
  resetNavigationGraphForTest();
  const { mockServer, factory } = setup();
  const bot = makeBot();
  const { mark } = registerAll(mockServer, factory, bot);

  await mark({ name: 'village', type: 'village', x: 0, y: 0, z: 0 });
  const node = nodes()[0];
  t.truthy(node);

  // Simulate the odometer drift: the bot believes the village is 50 blocks off.
  setDeadReckonedPos(node.id, { x: -50, y: 0, z: -50 });

  const drift = reSightLandmark(node.id, { x: 0, y: 0, z: 0 });
  t.deepEqual(drift, { x: 50, y: 0, z: 50 });

  const updated = getNode(node.id);
  t.is(updated.x, 0);
  t.is(updated.z, 0);
});

test('reSightLandmark returns null for an unknown id', (t) => {
  resetNavigationGraphForTest();
  t.is(reSightLandmark('node-9999', { x: 0, y: 0, z: 0 }), null);
});

test('recommended sector advances to a less-visited sector after repeated explore of one', async (t) => {
  resetNavigationGraphForTest();
  const { mockServer, factory } = setup();
  const bot = makeBot();
  const { explore } = registerAll(mockServer, factory, bot);

  // Sector "0" has been swept many times already; the others are fresh.
  setSectorVisitCounts({ '0': 20 });

  const result = await explore({ radius: 32, sectors: 8 });
  t.false(!!result.isError);

  const ranked = (result as Record<string, unknown>).rankedSectors as Array<{
    sector: string;
    visits: number;
    score: number;
  }>;
  const recommended = (result as Record<string, unknown>).recommendedSector as string;

  t.true(Array.isArray(ranked));
  t.true(ranked.length > 0);
  t.is(ranked[0].sector, recommended);
  // The heavily visited sector is no longer the top pick.
  t.not(recommended, '0');
  t.true(ranked.some((r) => r.sector === '0'));
});

test('low-health bot yields a conservative signal; healthy yields permissive', async (t) => {
  resetNavigationGraphForTest();

  const healthy = setup();
  const healthyBot = makeBot(18);
  const healthyTools = registerAll(healthy.mockServer, healthy.factory, healthyBot);
  const healthyResult = await healthyTools.explore({ radius: 32, sectors: 8 });
  const healthyEnv = (healthyResult as Record<string, unknown>).deathEnvelope as {
    signal: string;
  };
  t.is(healthyEnv.signal, 'safe to explore');

  const low = setup();
  const lowBot = makeBot(4);
  const lowTools = registerAll(low.mockServer, low.factory, lowBot);
  const lowResult = await lowTools.explore({ radius: 32, sectors: 8 });
  const lowEnv = (lowResult as Record<string, unknown>).deathEnvelope as {
    signal: string;
  };
  t.is(lowEnv.signal, 'conservative');
});

test('explore does not throw when the bot health is unknown', async (t) => {
  resetNavigationGraphForTest();
  const { mockServer, factory } = setup();
  const bot = makeBot();
  delete (bot as Record<string, unknown>).health;
  const { explore } = registerAll(mockServer, factory, bot);
  const result = await explore({ radius: 32, sectors: 8 });
  t.false(!!result.isError);
  const env = (result as Record<string, unknown>).deathEnvelope as { signal: string };
  t.is(env.signal, 'safe to explore');
});

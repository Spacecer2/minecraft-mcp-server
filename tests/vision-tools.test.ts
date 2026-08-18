import test from 'ava';
import sinon from 'sinon';
import { registerVisionTools } from '../src/tools/vision-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import type mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';

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

test('registerVisionTools registers get-bot-stats, describe-view and interact-entity', (t) => {
  const { mockServer, factory } = setup();
  registerVisionTools(factory, () => ({} as mineflayer.Bot));
  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  for (const name of ['get-bot-stats', 'describe-view', 'interact-entity']) {
    const call = toolCalls.find(c => c.args[0] === name);
    t.truthy(call, `expected ${name} to be registered`);
  }
});

test('get-bot-stats consolidates world state, inventory and surroundings into one dashboard', async (t) => {
  const { mockServer, factory } = setup();
  const mockBot = {
    entity: {
      id: 1,
      position: new Vec3(10.7, 64.2, -5.3),
      yaw: Math.PI,
      pitch: 0.1
    },
    game: { dimension: 'minecraft:overworld', gameMode: 'survival', difficulty: 'normal' },
    time: { timeOfDay: 6000 },
    health: 20,
    food: 19,
    saturation: 18.5,
    experience: { level: 7 },
    weather: 'rain',
    heldItem: { name: 'stone_pickaxe' },
    inventory: {
      items: () => [
        { name: 'stone', count: 5 },
        { name: 'dirt', count: 3 },
        { name: 'stone', count: 2 }
      ]
    },
    entities: new Map<number, unknown>([
      [10, { id: 10, name: 'creeper', type: 'mob', position: new Vec3(5, 64, 5), health: 20 }],
      [11, { id: 11, name: 'cow', type: 'mob', position: new Vec3(3, 64, 0), health: 10 }]
    ])
  } as unknown as mineflayer.Bot;
  registerVisionTools(factory, () => mockBot);

  const executor = getExecutor(mockServer, 'get-bot-stats');
  const result = await executor({});

  const text = result.content[0].text;
  t.true(text.includes('Position: (10, 64, -6)'));
  t.true(text.includes('Dimension: minecraft:overworld'));
  t.true(text.includes('Gamemode: survival'));
  t.true(text.includes('Health: 20'));
  t.true(text.includes('Food: 19'));
  t.true(text.includes('Held item: stone_pickaxe'));
  t.true(text.includes('3 stacks, 2 distinct item types (10 total items)'));
  t.true(text.includes('Hostiles within 24 blocks: 1'));
  t.true(text.includes('- creeper at (5, 64, 5)'));
  t.false(text.includes('- cow'));
});

test('get-bot-stats reports no hostiles and empty inventory when absent', async (t) => {
  const { mockServer, factory } = setup();
  const mockBot = {
    entity: { id: 1, position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
    game: { dimension: 'minecraft:overworld', gameMode: 'creative', difficulty: 'peaceful' },
    health: 20,
    food: 20,
    entities: new Map<number, unknown>()
  } as unknown as mineflayer.Bot;
  registerVisionTools(factory, () => mockBot);

  const executor = getExecutor(mockServer, 'get-bot-stats');
  const result = await executor({});

  const text = result.content[0].text;
  t.true(text.includes('Health: 20'));
  t.true(text.includes('Food: 20'));
  t.true(text.includes('Dimension: minecraft:overworld'));
  t.true(text.includes('Inventory is empty'));
  t.true(text.includes('Hostiles within 24 blocks: 0'));
});

test('describe-view reports a non-air block ahead along the facing ray', async (t) => {
  const { mockServer, factory } = setup();
  const mockBot = {
    entity: { id: 1, position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
    blockAt: sinon.stub().callsFake((pos: Vec3) =>
      pos.x === 0 && pos.z === -2 ? { name: 'stone' } : { name: 'air' }
    ),
    entities: new Map<number, unknown>()
  } as unknown as mineflayer.Bot;
  registerVisionTools(factory, () => mockBot);

  const executor = getExecutor(mockServer, 'describe-view');
  const result = await executor({});

  const text = result.content[0].text;
  t.true(text.includes('Looking S:'));
  t.true(text.includes('stone'));
  t.true(text.includes('blocks ahead'));
});

test('describe-view returns clear view when nothing is ahead', async (t) => {
  const { mockServer, factory } = setup();
  const mockBot = {
    entity: { id: 1, position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
    blockAt: sinon.stub().returns({ name: 'air' }),
    entities: new Map<number, unknown>()
  } as unknown as mineflayer.Bot;
  registerVisionTools(factory, () => mockBot);

  const executor = getExecutor(mockServer, 'describe-view');
  const result = await executor({});

  t.is(result.content[0].text, 'Clear view for 16 blocks.');
});

test('describe-view lists entities in the forward hemisphere only', async (t) => {
  const { mockServer, factory } = setup();
  const mockBot = {
    entity: { id: 1, position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
    blockAt: sinon.stub().returns({ name: 'air' }),
    entities: new Map<number, unknown>([
      [10, { id: 10, name: 'cow', type: 'mob', position: new Vec3(0, 64, -5), health: 10 }],
      [11, { id: 11, name: 'zombie', type: 'mob', position: new Vec3(0, 64, 8), health: 20 }]
    ])
  } as unknown as mineflayer.Bot;
  registerVisionTools(factory, () => mockBot);

  const executor = getExecutor(mockServer, 'describe-view');
  const result = await executor({});

  const text = result.content[0].text;
  t.true(text.includes('- cow 5.0 blocks ahead (friendly)'));
  t.false(text.includes('zombie'));
});

test('describe-view never throws when blockAt fails', async (t) => {
  const { mockServer, factory } = setup();
  const mockBot = {
    entity: { id: 1, position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
    blockAt: sinon.stub().throws(new Error('boom')),
    entities: new Map<number, unknown>()
  } as unknown as mineflayer.Bot;
  registerVisionTools(factory, () => mockBot);

  const executor = getExecutor(mockServer, 'describe-view');
  const result = await executor({});

  t.is(result.content[0].text, 'Clear view for 16 blocks.');
});

test('interact-entity uses the nearest matching entity', async (t) => {
  const { mockServer, factory } = setup();
  const mockEntity = { id: 10, name: 'villager', type: 'mob', position: new Vec3(3, 64, 0) };
  const useOn = sinon.stub().resolves();
  const mockBot = {
    entity: { id: 1, position: new Vec3(0, 64, 0) },
    nearestEntity: sinon.stub().returns(mockEntity),
    useOn
  } as unknown as mineflayer.Bot;
  registerVisionTools(factory, () => mockBot);

  const executor = getExecutor(mockServer, 'interact-entity');
  const result = await executor({ entityType: 'villager', action: 'use' });

  t.is(result.content[0].text, 'Used villager at (3, 64, 0)');
  t.true(useOn.calledOnce);
});

test('interact-entity attacks the nearest entity', async (t) => {
  const { mockServer, factory } = setup();
  const mockEntity = { id: 10, name: 'zombie', type: 'mob', position: new Vec3(2, 64, 0) };
  const attack = sinon.stub().resolves();
  const mockBot = {
    entity: { id: 1, position: new Vec3(0, 64, 0) },
    nearestEntity: sinon.stub().returns(mockEntity),
    attack
  } as unknown as mineflayer.Bot;
  registerVisionTools(factory, () => mockBot);

  const executor = getExecutor(mockServer, 'interact-entity');
  const result = await executor({ action: 'attack' });

  t.is(result.content[0].text, 'Attacked zombie at (2, 64, 0)');
  t.true(attack.calledOnce);
});

test('interact-entity reports no entity when none matches', async (t) => {
  const { mockServer, factory } = setup();
  const mockBot = {
    entity: { id: 1, position: new Vec3(0, 64, 0) },
    nearestEntity: sinon.stub().returns(null)
  } as unknown as mineflayer.Bot;
  registerVisionTools(factory, () => mockBot);

  const executor = getExecutor(mockServer, 'interact-entity');
  const result = await executor({ entityType: 'creeper', action: 'use' });

  t.is(result.content[0].text, 'No entity of type creeper within 6 blocks.');
});

test('interact-entity reports no entity when the nearest is out of range', async (t) => {
  const { mockServer, factory } = setup();
  const mockEntity = { id: 10, name: 'cow', type: 'mob', position: new Vec3(30, 64, 0) };
  const mockBot = {
    entity: { id: 1, position: new Vec3(0, 64, 0) },
    nearestEntity: sinon.stub().returns(mockEntity)
  } as unknown as mineflayer.Bot;
  registerVisionTools(factory, () => mockBot);

  const executor = getExecutor(mockServer, 'interact-entity');
  const result = await executor({ entityType: 'cow', maxDistance: 6 });

  t.is(result.content[0].text, 'No entity of type cow within 6 blocks.');
});

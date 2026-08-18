import test from 'ava';
import sinon from 'sinon';
import { registerWorldStateTools } from '../src/tools/world-state-tools.js';
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

test('registerWorldStateTools registers get-world-state tool', (t) => {
  const { mockServer, factory } = setup();
  registerWorldStateTools(factory, () => ({} as mineflayer.Bot));
  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const call = toolCalls.find(c => c.args[0] === 'get-world-state');
  t.truthy(call);
  t.is(call!.args[1], 'Get the bot\'s current world state: position, facing (from yaw/pitch), dimension, gamemode, time of day, health, food, biome, and held item');
});

test('get-world-state returns a compact snapshot of orientation and survival state', async (t) => {
  const { mockServer, factory } = setup();
  const mockBot = {
    entity: {
      id: 1,
      position: new Vec3(10.7, 64.2, -5.3),
      yaw: Math.PI,
      pitch: 0.1,
      onGround: true,
      biome: { name: 'plains' }
    },
    game: { dimension: 'minecraft:overworld', gameMode: 'survival', difficulty: 'normal' },
    time: { timeOfDay: 6000 },
    health: 20,
    food: 19,
    saturation: 18.5,
    experience: { level: 7 },
    weather: 'rain',
    blockAt: sinon.stub().returns({ light: 15 }),
    heldItem: { name: 'stone_pickaxe' }
  } as unknown as mineflayer.Bot;
  registerWorldStateTools(factory, () => mockBot);

  const executor = getExecutor(mockServer, 'get-world-state');
  const result = await executor({});

  const text = result.content[0].text;
  t.true(text.includes('Position: (10, 64, -6)'));
  t.true(text.includes('Facing: N'));
  t.true(text.includes('Dimension: minecraft:overworld'));
  t.true(text.includes('Gamemode: survival'));
  t.true(text.includes('Time of day: 6000'));
  t.true(text.includes('Day/night: day'));
  t.true(text.includes('Difficulty: normal'));
  t.true(text.includes('Weather: rain'));
  t.true(text.includes('Health: 20'));
  t.true(text.includes('Food: 19'));
  t.true(text.includes('Saturation: 18.5'));
  t.true(text.includes('XP level: 7'));
  t.true(text.includes('On ground: true'));
  t.true(text.includes('Biome: plains'));
  t.true(text.includes('Light level: 15'));
  t.true(text.includes('Held item: stone_pickaxe'));
});

test('get-world-state reports night when timeOfDay is at or past 13000', async (t) => {
  const { mockServer, factory } = setup();
  const mockBot = {
    entity: { id: 1, position: new Vec3(0, 64, 0) },
    game: { dimension: 'minecraft:overworld', gameMode: 'survival', difficulty: 'hard' },
    time: { timeOfDay: 18000 },
    health: 20,
    food: 20,
    experience: { level: 3 }
  } as unknown as mineflayer.Bot;
  registerWorldStateTools(factory, () => mockBot);

  const executor = getExecutor(mockServer, 'get-world-state');
  const result = await executor({});

  const text = result.content[0].text;
  t.true(text.includes('Day/night: night'));
  t.true(text.includes('Difficulty: hard'));
  t.true(text.includes('XP level: 3'));
});

test('get-world-state falls back gracefully when state is missing', async (t) => {
  const { mockServer, factory } = setup();
  const mockBot = {} as unknown as mineflayer.Bot;
  registerWorldStateTools(factory, () => mockBot);

  const executor = getExecutor(mockServer, 'get-world-state');
  const result = await executor({});

  const text = result.content[0].text;
  t.true(text.includes('Position: (?, ?, ?)'));
  t.true(text.includes('Facing: ?'));
  t.true(text.includes('Dimension: unknown'));
  t.true(text.includes('Held item: empty'));
  t.true(text.includes('Day/night: unknown'));
  t.true(text.includes('Difficulty: unknown'));
  t.true(text.includes('Weather: clear'));
  t.true(text.includes('Saturation: unknown'));
  t.true(text.includes('XP level: unknown'));
  t.true(text.includes('Light level: unknown'));
});

test('get-world-state never throws when blockAt fails', async (t) => {
  const { mockServer, factory } = setup();
  const mockBot = {
    entity: { id: 1, position: new Vec3(0, 64, 0) },
    blockAt: sinon.stub().throws(new Error('boom'))
  } as unknown as mineflayer.Bot;
  registerWorldStateTools(factory, () => mockBot);

  const executor = getExecutor(mockServer, 'get-world-state');
  const result = await executor({});

  t.true(result.content[0].text.includes('Light level: unknown'));
});

test('get-surroundings lists nearby entities and reports hostile danger', async (t) => {
  const { mockServer, factory } = setup();
  const mockBot = {
    entity: { id: 1, position: new Vec3(0, 64, 0) },
    entities: new Map<number, unknown>([
      [10, { id: 10, name: 'creeper', type: 'mob', position: new Vec3(5, 64, 5), health: 20 }],
      [11, { id: 11, name: 'cow', type: 'mob', position: new Vec3(3, 64, 0), health: 10 }]
    ])
  } as unknown as mineflayer.Bot;
  registerWorldStateTools(factory, () => mockBot);

  const executor = getExecutor(mockServer, 'get-surroundings');
  const result = await executor({ radius: 16 });

  const text = result.content[0].text;
  t.true(text.includes('- cow (friendly) at (3, 64, 0), distance 3.0, 10 health'));
  t.true(text.includes('- creeper (HOSTILE) at (5, 64, 5), distance 7.1, 20 health'));
  t.true(text.includes('Danger: 1 hostile entity nearby'));
});

test('get-surroundings reports Danger: none when only friendly entities are nearby', async (t) => {
  const { mockServer, factory } = setup();
  const mockBot = {
    entity: { id: 1, position: new Vec3(0, 64, 0) },
    entities: new Map<number, unknown>([
      [11, { id: 11, name: 'cow', type: 'mob', position: new Vec3(3, 64, 0), health: 10 }]
    ])
  } as unknown as mineflayer.Bot;
  registerWorldStateTools(factory, () => mockBot);

  const executor = getExecutor(mockServer, 'get-surroundings');
  const result = await executor({ radius: 16 });

  const text = result.content[0].text;
  t.true(text.includes('- cow (friendly) at (3, 64, 0), distance 3.0, 10 health'));
  t.true(text.includes('Danger: none'));
});

test('get-surroundings handles empty entities', async (t) => {
  const { mockServer, factory } = setup();
  const mockBot = {
    entity: { id: 1, position: new Vec3(0, 64, 0) },
    entities: new Map<number, unknown>()
  } as unknown as mineflayer.Bot;
  registerWorldStateTools(factory, () => mockBot);

  const executor = getExecutor(mockServer, 'get-surroundings');
  const result = await executor({ radius: 16 });

  const text = result.content[0].text;
  t.true(text.includes('No entities nearby'));
  t.true(text.includes('Danger: none'));
});

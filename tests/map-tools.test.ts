import test from 'ava';
import sinon from 'sinon';
import { registerMapTools } from '../src/tools/map-tools.js';
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

function makeBot(position = new Vec3(0, 64, 0)) {
  return {
    entity: { position },
    game: { dimension: 'minecraft:overworld' }
  } as unknown as Partial<mineflayer.Bot>;
}

function registerAll(mockServer: McpServer, factory: ToolFactory, bot: Partial<mineflayer.Bot>) {
  registerMapTools(factory, () => bot as mineflayer.Bot);
  const exec = (name: string) => getExecutor(mockServer, name);
  return {
    mark: exec('map-mark'),
    list: exec('map-list'),
    clear: exec('map-clear'),
    nearby: exec('map-nearby'),
    explore: exec('explore')
  };
}

test.serial('registerMapTools registers all world map tools', (t) => {
  const { mockServer, factory } = setup();
  registerMapTools(factory, () => ({} as mineflayer.Bot));
  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const names = toolCalls.map(call => call.args[0]);
  for (const name of ['map-mark', 'map-list', 'map-clear', 'map-nearby', 'explore']) {
    t.true(names.includes(name), `${name} should be registered`);
  }
});

test.serial('map-mark adds a landmark (defaulting to bot position) and map-list shows it', async (t) => {
  const { mockServer, factory } = setup();
  const bot = makeBot(new Vec3(10, 20, 30));
  const { mark, list, clear } = registerAll(mockServer, factory, bot);

  await clear({});
  const marked = await mark({ name: 'village', type: 'village' });
  t.false(!!marked.isError);
  t.true(marked.content[0].text.includes('Marked village at (10, 20, 30) [village].'));

  const listed = await list({});
  t.false(!!listed.isError);
  t.true(listed.content[0].text.includes('- village (village) at (10,20,30) [minecraft:overworld]'));
});

test.serial('map-list filters by type', async (t) => {
  const { mockServer, factory } = setup();
  const bot = makeBot();
  const { mark, list, clear } = registerAll(mockServer, factory, bot);

  await clear({});
  await mark({ name: 'village', type: 'village', x: 0, y: 0, z: 0 });
  await mark({ name: 'cave', type: 'cave', x: 5, y: 0, z: 0 });

  const all = await list({});
  t.true(all.content[0].text.includes('village'));
  t.true(all.content[0].text.includes('cave'));

  const filtered = await list({ type: 'village' });
  t.true(filtered.content[0].text.includes('village'));
  t.false(filtered.content[0].text.includes('cave'));
});

test.serial('map-clear empties the map', async (t) => {
  const { mockServer, factory } = setup();
  const bot = makeBot();
  const { mark, list, clear } = registerAll(mockServer, factory, bot);

  await clear({});
  await mark({ name: 'outpost', type: 'village', x: 1, y: 0, z: 1 });
  const cleared = await clear({});
  t.false(!!cleared.isError);
  t.true(cleared.content[0].text.includes('Map cleared'));

  const listed = await list({});
  t.true(listed.content[0].text.includes('Map empty'));
});

test.serial('map-nearby filters landmarks by distance and sorts ascending', async (t) => {
  const { mockServer, factory } = setup();
  const bot = makeBot(new Vec3(0, 0, 0));
  const { mark, nearby, clear } = registerAll(mockServer, factory, bot);

  await clear({});
  await mark({ name: 'near1', type: 'test', x: 5, y: 0, z: 5 });
  await mark({ name: 'far', type: 'test', x: 100, y: 0, z: 0 });
  await mark({ name: 'near2', type: 'test', x: 20, y: 0, z: 0 });

  const result = await nearby({ radius: 64 });
  t.false(!!result.isError);
  const text = result.content[0].text;
  t.true(text.includes('- near1 at (5,0,5)'));
  t.true(text.includes('- near2 at (20,0,0)'));
  t.false(text.includes('far'));
  t.true(text.indexOf('near1') < text.indexOf('near2'));
});

test.serial('explore records a notable block as a landmark and reports it', async (t) => {
  const { mockServer, factory } = setup();
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    game: { dimension: 'minecraft:overworld' },
    blockAt: sinon.stub().callsFake((pos: Vec3) =>
      pos.x === 4 && pos.y === 64 && pos.z === 0 ? { name: 'iron_ore' } : { name: 'air' }
    )
  } as unknown as Partial<mineflayer.Bot>;
  const { explore, list, clear } = registerAll(mockServer, factory, bot);

  await clear({});
  const result = await explore({ radius: 32, sectors: 8 });
  t.false(!!result.isError);
  const text = result.content[0].text;
  t.true(text.includes('Explored radius 32'));
  t.true(text.includes('iron_ore'));
  t.true(text.includes('discovered 1 landmark(s)'));

  const listed = await list({});
  t.true(listed.content[0].text.includes('iron_ore'));
});

test.serial('explore reports nothing new when no notable blocks are found', async (t) => {
  const { mockServer, factory } = setup();
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    game: { dimension: 'minecraft:overworld' },
    blockAt: sinon.stub().returns({ name: 'air' })
  } as unknown as Partial<mineflayer.Bot>;
  const { explore, clear } = registerAll(mockServer, factory, bot);

  await clear({});
  const result = await explore({ radius: 32, sectors: 8 });
  t.false(!!result.isError);
  t.true(result.content[0].text.includes('Explored radius 32: nothing new.'));
});

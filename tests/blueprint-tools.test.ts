import test from 'ava';
import sinon from 'sinon';
import { registerBlueprintTools } from '../src/tools/blueprint-tools.js';
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

function makePlaceBot(opts: { position?: Vec3; blocked?: Vec3[] } = {}) {
  const botPos = opts.position ?? new Vec3(10, 64, 20);
  const placed = new Map<string, string>();
  const blocked = opts.blocked ?? [];

  const blockAt = sinon.stub().callsFake((pos: Vec3) => {
    const key = `${pos.x},${pos.y},${pos.z}`;
    if (placed.has(key)) return { name: placed.get(key), position: pos };
    if (blocked.some(b => b.equals(pos))) return { name: 'stone', position: pos };
    if (pos.y === botPos.y - 1) return { name: 'stone', position: pos };
    return { name: 'air', position: pos };
  });

  const placeBlock = sinon.stub().callsFake(async (ref: { position: Vec3 }) => {
    const target = ref.position.plus(new Vec3(0, 1, 0));
    placed.set(`${target.x},${target.y},${target.z}`, 'placed');
  });

  const bot = {
    entity: { position: botPos },
    blockAt,
    placeBlock,
    canSeeBlock: () => true,
    lookAt: sinon.stub().resolves(),
    pathfinder: { goto: sinon.stub().resolves() }
  } as unknown as Partial<mineflayer.Bot>;

  return { bot, blockAt, placeBlock, lookAt: bot.lookAt as sinon.SinonStub };
}

test('registerBlueprintTools registers build-from-grid and redstone-layout', (t) => {
  const { mockServer, factory } = setup();
  registerBlueprintTools(factory, () => ({} as mineflayer.Bot));
  const names = (mockServer.tool as sinon.SinonStub).getCalls().map(c => c.args[0]);
  for (const name of ['build-from-grid', 'redstone-layout']) {
    t.true(names.includes(name), `missing ${name}`);
  }
});

test('build-from-grid places every cell of a 2x2 blueprint', async (t) => {
  const { mockServer, factory } = setup();
  const { bot, placeBlock } = makePlaceBot({ position: new Vec3(10, 64, 20) });
  registerBlueprintTools(factory, () => bot as mineflayer.Bot);

  const executor = getExecutor(mockServer, 'build-from-grid');
  const result = await executor({
    rows: ['WW', 'WW'],
    palette: { W: 'oak_planks' },
    originX: 0,
    originY: 64,
    originZ: 0
  });

  t.false(!!result.isError);
  t.true(result.content[0].text.includes('Blueprint built: 4 placed, 0 failed, 0 air cells.'));
  t.is(placeBlock.callCount, 4);
});

test('build-from-grid treats the "." char as air and skips placement', async (t) => {
  const { mockServer, factory } = setup();
  const { bot, placeBlock } = makePlaceBot({ position: new Vec3(10, 64, 20) });
  registerBlueprintTools(factory, () => bot as mineflayer.Bot);

  const executor = getExecutor(mockServer, 'build-from-grid');
  const result = await executor({
    rows: ['W.', '.W'],
    palette: { W: 'oak_planks', '.': 'air' },
    originX: 0,
    originY: 64,
    originZ: 0
  });

  t.false(!!result.isError);
  t.true(result.content[0].text.includes('Blueprint built: 2 placed, 0 failed, 2 air cells.'));
  t.is(placeBlock.callCount, 2);
});

test('build-from-grid rejects a code missing from the palette', async (t) => {
  const { mockServer, factory } = setup();
  const { bot } = makePlaceBot({ position: new Vec3(10, 64, 20) });
  registerBlueprintTools(factory, () => bot as mineflayer.Bot);

  const executor = getExecutor(mockServer, 'build-from-grid');
  const result = await executor({
    rows: ['WW', 'WX'],
    palette: { W: 'oak_planks' },
    originX: 0,
    originY: 64,
    originZ: 0
  });

  t.true(!!result.isError);
  t.true(result.content[0].text.includes("Unknown block code 'X' in palette."));
});

test('build-from-grid rejects rows of unequal length', async (t) => {
  const { mockServer, factory } = setup();
  const { bot } = makePlaceBot({ position: new Vec3(10, 64, 20) });
  registerBlueprintTools(factory, () => bot as mineflayer.Bot);

  const executor = getExecutor(mockServer, 'build-from-grid');
  const result = await executor({
    rows: ['WW', 'W'],
    palette: { W: 'oak_planks' },
    originX: 0,
    originY: 64,
    originZ: 0
  });

  t.true(!!result.isError);
  t.true(result.content[0].text.includes('Blueprint rows must have equal length.'));
});

test('build-from-grid reports failures for occupied cells', async (t) => {
  const { mockServer, factory } = setup();
  const { bot } = makePlaceBot({ position: new Vec3(10, 64, 20), blocked: [new Vec3(0, 64, 0)] });
  registerBlueprintTools(factory, () => bot as mineflayer.Bot);

  const executor = getExecutor(mockServer, 'build-from-grid');
  const result = await executor({
    rows: ['W'],
    palette: { W: 'oak_planks' },
    originX: 0,
    originY: 64,
    originZ: 0
  });

  t.false(!!result.isError);
  t.true(result.content[0].text.includes('Blueprint built: 0 placed, 1 failed, 0 air cells.'));
  t.true(result.content[0].text.includes("already a block (stone) there"));
});

test('redstone-layout returns a recognizable plan for each type', async (t) => {
  const { mockServer, factory } = setup();
  registerBlueprintTools(factory, () => ({} as mineflayer.Bot));
  const executor = getExecutor(mockServer, 'redstone-layout');

  const expectations: [string, RegExp][] = [
    ['door', /pressure plate|door/i],
    ['lamp', /lamp/i],
    ['trap', /tripwire|hook|string/i],
    ['piston', /piston/i],
    ['rsswitch', /torch|latch/i],
    ['auto-farm', /observer|crop|hopper/i]
  ];

  for (const [type, pattern] of expectations) {
    const result = await executor({ type });
    t.false(!!result.isError, `${type} should not error`);
    t.true(pattern.test(result.content[0].text), `${type} should mention ${pattern}`);
    t.true(result.content[0].text.includes('size=3'), `${type} should default size to 3`);
  }
});

test('redstone-layout honors a custom size', async (t) => {
  const { mockServer, factory } = setup();
  registerBlueprintTools(factory, () => ({} as mineflayer.Bot));
  const executor = getExecutor(mockServer, 'redstone-layout');

  const result = await executor({ type: 'door', size: 5 });
  t.false(!!result.isError);
  t.true(result.content[0].text.includes('size=5'));
});

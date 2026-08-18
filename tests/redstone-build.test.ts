import test from 'ava';
import sinon from 'sinon';
import { registerRedstoneBuildTools } from '../src/tools/redstone-build.js';
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

function makeRedstoneBot(opts: { position?: Vec3; airCells?: Vec3[]; blocked?: Vec3[] } = {}) {
  const botPos = opts.position ?? new Vec3(5, 64, 5);
  const placed = new Map<string, string>();
  const airCells = (opts.airCells ?? []).map(c => `${c.x},${c.y},${c.z}`);
  const blocked = (opts.blocked ?? []).map(c => `${c.x},${c.y},${c.z}`);

  const blockAt = sinon.stub().callsFake((pos: Vec3) => {
    const key = `${pos.x},${pos.y},${pos.z}`;
    if (placed.has(key)) return { name: placed.get(key), position: pos };
    if (airCells.includes(key)) return { name: 'air', position: pos };
    if (blocked.includes(key)) return { name: 'stone', position: pos };
    return { name: 'stone', position: pos };
  });

  const placeBlock = sinon.stub().callsFake(async (ref: { position: Vec3 }, dir: Vec3) => {
    const target = ref.position.plus(dir);
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

  return { bot, blockAt, placeBlock };
}

test('registerRedstoneBuildTools registers place-redstone', (t) => {
  const { mockServer, factory } = setup();
  registerRedstoneBuildTools(factory, () => ({} as mineflayer.Bot));
  const names = (mockServer.tool as sinon.SinonStub).getCalls().map(c => c.args[0]);
  t.true(names.includes('place-redstone'));
});

test('place-redstone lamp places the lamp, lever, and dust trench', async (t) => {
  const { mockServer, factory } = setup();
  const { bot, placeBlock } = makeRedstoneBot({
    position: new Vec3(5, 64, 5),
    airCells: [new Vec3(0, 63, 0), new Vec3(1, 63, 0), new Vec3(0, 62, 0), new Vec3(1, 62, 0)]
  });
  registerRedstoneBuildTools(factory, () => bot as mineflayer.Bot);

  const executor = getExecutor(mockServer, 'place-redstone');
  const result = await executor({ type: 'lamp', x: 0, y: 63, z: 0 });

  t.false(!!result.isError);
  const text = result.content[0].text;
  t.true(text.includes('Placed lamp redstone starter at (0,63,0)'));
  t.true(text.includes('redstone lamp'));
  t.true(text.includes('4 placed, 0 failed.'));
  t.is(placeBlock.callCount, 4);
});

test('place-redstone reports a tally when some cells are blocked', async (t) => {
  const { mockServer, factory } = setup();
  const { bot } = makeRedstoneBot({
    position: new Vec3(5, 64, 5),
    airCells: [new Vec3(0, 63, 0), new Vec3(0, 62, 0), new Vec3(1, 62, 0)],
    blocked: [new Vec3(1, 63, 0)]
  });
  registerRedstoneBuildTools(factory, () => bot as mineflayer.Bot);

  const executor = getExecutor(mockServer, 'place-redstone');
  const result = await executor({ type: 'lamp', x: 0, y: 63, z: 0 });

  t.false(!!result.isError);
  const text = result.content[0].text;
  t.true(text.includes('3 placed, 1 failed'));
  t.true(text.includes('already a block (stone) there'));
});
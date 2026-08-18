import test from 'ava';
import sinon from 'sinon';
import { registerBuildTools } from '../src/tools/build-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import type mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import { setInterrupt, clearInterrupt } from '../src/interrupt.js';

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

function makePlaceBot(opts: { position?: Vec3; blockType?: string } = {}) {
  const botPos = opts.position ?? new Vec3(0, 64, 0);
  const blockType = opts.blockType ?? 'cobblestone';
  const placed = new Map<string, string>();

  const blockAt = sinon.stub().callsFake((pos: Vec3) => {
    const key = `${pos.x},${pos.y},${pos.z}`;
    if (placed.has(key)) return { name: placed.get(key), position: pos };
    if (pos.y === botPos.y - 1) return { name: 'stone', position: pos };
    return { name: 'air', position: pos };
  });

  const placeBlock = sinon.stub().callsFake(async (ref: { position: Vec3 }) => {
    const target = ref.position.plus(new Vec3(0, 1, 0));
    placed.set(`${target.x},${target.y},${target.z}`, blockType);
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

test('registerBuildTools registers place-blocks, fill-area, and place-relative', (t) => {
  const { mockServer, factory } = setup();
  registerBuildTools(factory, () => ({} as mineflayer.Bot));
  const names = (mockServer.tool as sinon.SinonStub).getCalls().map(c => c.args[0]);
  for (const name of ['place-blocks', 'fill-area', 'place-relative']) {
    t.true(names.includes(name), `missing ${name}`);
  }
});

test('place-blocks places every block in a single call', async (t) => {
  const { mockServer, factory } = setup();
  const { bot, placeBlock } = makePlaceBot({ position: new Vec3(10, 64, 20) });
  registerBuildTools(factory, () => bot as mineflayer.Bot);

  const executor = getExecutor(mockServer, 'place-blocks');
  const result = await executor({
    blocks: [
      { x: 11, y: 64, z: 20 },
      { x: 12, y: 64, z: 20 }
    ]
  });

  t.false(!!result.isError);
  t.true(result.content[0].text.includes('Placed 2 block(s); failed 0'));
  t.is(placeBlock.callCount, 2);
});

test('place-blocks reports a failure when a target is already occupied', async (t) => {
  const { mockServer, factory } = setup();
  const botPos = new Vec3(10, 64, 20);
  const blockAt = sinon.stub().callsFake((pos: Vec3) => {
    if (pos.equals(new Vec3(11, 64, 20))) return { name: 'stone', position: pos };
    if (pos.y === botPos.y - 1) return { name: 'stone', position: pos };
    return { name: 'air', position: pos };
  });
  const bot = {
    entity: { position: botPos },
    blockAt,
    placeBlock: sinon.stub().resolves(),
    canSeeBlock: () => true,
    lookAt: sinon.stub().resolves(),
    pathfinder: { goto: sinon.stub().resolves() }
  } as unknown as Partial<mineflayer.Bot>;
  registerBuildTools(factory, () => bot as mineflayer.Bot);

  const executor = getExecutor(mockServer, 'place-blocks');
  const result = await executor({ blocks: [{ x: 11, y: 64, z: 20 }] });

  t.false(!!result.isError);
  t.true(result.content[0].text.includes('Placed 0 block(s); failed 1'));
  t.true(result.content[0].text.includes("couldn't place (11,64,20): already a block (stone) there"));
});

test('place-blocks fails when a target is the bot position', async (t) => {
  const { mockServer, factory } = setup();
  const { bot } = makePlaceBot({ position: new Vec3(10, 64, 20) });
  registerBuildTools(factory, () => bot as mineflayer.Bot);

  const executor = getExecutor(mockServer, 'place-blocks');
  const result = await executor({ blocks: [{ x: 10, y: 64, z: 20 }] });

  t.false(!!result.isError);
  t.true(result.content[0].text.includes('Placed 0 block(s); failed 1'));
  t.true(result.content[0].text.includes("couldn't place (10,64,20): can't place a block where the bot stands or one block above"));
});

test('fill-area fills every air cell in the volume', async (t) => {
  const { mockServer, factory } = setup();
  const { bot, placeBlock } = makePlaceBot({ position: new Vec3(100, 64, 100) });
  registerBuildTools(factory, () => bot as mineflayer.Bot);

  const executor = getExecutor(mockServer, 'fill-area');
  const result = await executor({ x1: 0, y1: 64, z1: 0, x2: 2, y2: 64, z2: 2, blockType: 'cobblestone' });

  t.false(!!result.isError);
  t.true(result.content[0].text.includes('Filled 9 block(s) with cobblestone'));
  t.is(placeBlock.callCount, 9);
});

test('fill-area rejects volumes larger than 216 blocks', async (t) => {
  const { mockServer, factory } = setup();
  const { bot } = makePlaceBot();
  registerBuildTools(factory, () => bot as mineflayer.Bot);

  const executor = getExecutor(mockServer, 'fill-area');
  const result = await executor({ x1: 0, y1: 0, z1: 0, x2: 9, y2: 9, z2: 9, blockType: 'stone' });

  t.true(!!result.isError);
  t.true(result.content[0].text.includes('fill-area too large (max 216). Narrow the volume.'));
});

test('place-relative resolves offsets against the bot position', async (t) => {
  const { mockServer, factory } = setup();
  const { bot, placeBlock } = makePlaceBot({ position: new Vec3(10.4, 64, 20.7) });
  registerBuildTools(factory, () => bot as mineflayer.Bot);

  const executor = getExecutor(mockServer, 'place-relative');
  const result = await executor({ offsets: [{ dx: 1, dy: 0, dz: 0 }] });

  t.false(!!result.isError);
  t.true(result.content[0].text.includes('Placed 1 block(s); failed 0'));

  // floor(10.4)+1 = 11, floor(20.7)+0 = 20 => target (11,64,20); reference below = (11,63,20)
  const referencePos = placeBlock.firstCall.args[0].position as Vec3;
  t.true(referencePos.equals(new Vec3(11, 63, 20)));
});

test('place-relative fails when an offset points at the bot position', async (t) => {
  const { mockServer, factory } = setup();
  const { bot } = makePlaceBot({ position: new Vec3(5, 64, 5) });
  registerBuildTools(factory, () => bot as mineflayer.Bot);

  const executor = getExecutor(mockServer, 'place-relative');
  const result = await executor({ offsets: [{ dx: 0, dy: 0, dz: 0 }] });

  t.false(!!result.isError);
  t.true(result.content[0].text.includes('Placed 0 block(s); failed 1'));
});

test.serial('place-blocks returns INTERRUPTED when the interrupt flag is set', async (t) => {
  clearInterrupt();
  setInterrupt('test');
  t.teardown(() => clearInterrupt());

  const { mockServer, factory } = setup();
  const { bot, placeBlock } = makePlaceBot({ position: new Vec3(10, 64, 20) });
  registerBuildTools(factory, () => bot as mineflayer.Bot);

  const executor = getExecutor(mockServer, 'place-blocks');
  const result = await executor({
    blocks: [
      { x: 11, y: 64, z: 20 },
      { x: 12, y: 64, z: 20 }
    ]
  });

  t.true(!!result.isError);
  t.true(result.content[0].text.includes('Placed 0/2'));
  t.true(result.content[0].text.includes('INTERRUPTED'));
  t.is(placeBlock.callCount, 0);
});

test.serial('fill-area returns INTERRUPTED when the interrupt flag is set', async (t) => {
  clearInterrupt();
  setInterrupt('test');
  t.teardown(() => clearInterrupt());

  const { mockServer, factory } = setup();
  const { bot } = makePlaceBot({ position: new Vec3(100, 64, 100) });
  registerBuildTools(factory, () => bot as mineflayer.Bot);

  const executor = getExecutor(mockServer, 'fill-area');
  const result = await executor({ x1: 0, y1: 64, z1: 0, x2: 2, y2: 64, z2: 2, blockType: 'cobblestone' });

  t.true(!!result.isError);
  t.true(result.content[0].text.includes('Placed 0/9'));
  t.true(result.content[0].text.includes('INTERRUPTED'));
});

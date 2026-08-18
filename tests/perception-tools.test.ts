import test from 'ava';
import sinon from 'sinon';
import { registerPerceptionTools } from '../src/tools/perception-tools.js';
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

function lookingBot(yaw: number, pitch: number) {
  return {
    entity: {
      position: new Vec3(10, 64, 10),
      yaw,
      pitch
    },
    world: {
      raycast: sinon.stub()
    },
    blockAt: sinon.stub()
  } as unknown as Partial<mineflayer.Bot>;
}

test('registerPerceptionTools registers look-ahead, path-status, check-build-site tools', (t) => {
  const { mockServer, factory } = setup();
  registerPerceptionTools(factory, () => ({} as mineflayer.Bot));
  const names = (mockServer.tool as sinon.SinonStub).getCalls().map(call => call.args[0]);
  t.true(names.includes('look-ahead'));
  t.true(names.includes('path-status'));
  t.true(names.includes('check-build-site'));
});

test('look-ahead reports the first block hit by the raycast', async (t) => {
  const { mockServer, factory } = setup();
  const mockBot = lookingBot(0, 0);
  (mockBot.world!.raycast as sinon.SinonStub).returns({ x: 10, y: 64, z: 20 });
  (mockBot.blockAt as sinon.SinonStub).returns({ name: 'stone' });
  registerPerceptionTools(factory, () => mockBot as mineflayer.Bot);

  const executor = getExecutor(mockServer, 'look-ahead');
  const result = await executor({});

  t.false(!!result.isError);
  const text = result.content[0].text;
  t.true(text.includes('Looking S from (10,64,10)'));
  t.true(text.includes('first block stone at (10,64,20)'));
  t.true(text.includes('blocks ahead'));
});

test('look-ahead reports no block when the raycast finds nothing', async (t) => {
  const { mockServer, factory } = setup();
  const mockBot = lookingBot(0, 0);
  (mockBot.world!.raycast as sinon.SinonStub).returns(null);
  (mockBot.blockAt as sinon.SinonStub).returns({ name: 'air' });
  registerPerceptionTools(factory, () => mockBot as mineflayer.Bot);

  const executor = getExecutor(mockServer, 'look-ahead');
  const result = await executor({});

  t.false(!!result.isError);
  t.true(result.content[0].text.includes('No block within 16 blocks'));
});

test('look-ahead falls back to sampling blocks when raycast is unavailable', async (t) => {
  const { mockServer, factory } = setup();
  const mockBot = lookingBot(Math.PI, 0);
  (mockBot.world!.raycast as sinon.SinonStub).throws(new Error('raycast unavailable'));
  (mockBot.blockAt as sinon.SinonStub).callsFake((pos: Vec3) => ({
    name: pos.z === 16 ? 'stone' : 'air'
  }));
  registerPerceptionTools(factory, () => mockBot as mineflayer.Bot);

  const executor = getExecutor(mockServer, 'look-ahead');
  const result = await executor({});

  t.false(!!result.isError);
  const text = result.content[0].text;
  t.true(text.includes('Looking N from (10,64,10)'));
  t.true(text.includes('first block stone at (10,64,16)'));
});

test('path-status flags targets below the world floor', async (t) => {
  const { mockServer, factory } = setup();
  const mockBot = {
    blockAt: sinon.stub().returns({ name: 'air' })
  } as unknown as Partial<mineflayer.Bot>;
  registerPerceptionTools(factory, () => mockBot as mineflayer.Bot);

  const executor = getExecutor(mockServer, 'path-status');
  const result = await executor({ x: 0, y: -70, z: 0 });

  t.false(!!result.isError);
  t.true(result.content[0].text.includes('Unreachable: below world floor (void)'));
});

test('path-status warns when there is no ground directly under the target', async (t) => {
  const { mockServer, factory } = setup();
  const mockBot = {
    blockAt: sinon.stub().callsFake((pos: Vec3) => ({
      name: pos.y === 62 ? 'stone' : 'air'
    }))
  } as unknown as Partial<mineflayer.Bot>;
  registerPerceptionTools(factory, () => mockBot as mineflayer.Bot);

  const executor = getExecutor(mockServer, 'path-status');
  const result = await executor({ x: 0, y: 64, z: 0, range: 2 });

  t.false(!!result.isError);
  t.true(result.content[0].text.includes('Caution: no ground under target (will fall)'));
});

test('path-status reports a reachable target when the ground is solid', async (t) => {
  const { mockServer, factory } = setup();
  const mockBot = {
    blockAt: sinon.stub().returns({ name: 'stone' })
  } as unknown as Partial<mineflayer.Bot>;
  registerPerceptionTools(factory, () => mockBot as mineflayer.Bot);

  const executor = getExecutor(mockServer, 'path-status');
  const result = await executor({ x: 0, y: 64, z: 0 });

  t.false(!!result.isError);
  t.true(result.content[0].text.includes('Target (0,64,0): reachable (likely)'));
});

test('check-build-site rejects volumes larger than 216 blocks', async (t) => {
  const { mockServer, factory } = setup();
  const mockBot = {
    blockAt: sinon.stub().returns({ name: 'stone' })
  } as unknown as Partial<mineflayer.Bot>;
  registerPerceptionTools(factory, () => mockBot as mineflayer.Bot);

  const executor = getExecutor(mockServer, 'check-build-site');
  const result = await executor({ x1: 0, y1: 0, z1: 0, x2: 9, y2: 9, z2: 9 });

  t.true(!!result.isError);
  t.true(result.content[0].text.includes('check-build-site too large (max 216). Narrow the volume.'));
});

test('check-build-site reports interior obstructions', async (t) => {
  const { mockServer, factory } = setup();
  const mockBot = {
    blockAt: sinon.stub().callsFake((pos: Vec3) => {
      if (pos.y === 63) return { name: 'stone' };
      if (pos.x === 1 && pos.y === 64 && pos.z === 0) return { name: 'stone' };
      return { name: 'air' };
    })
  } as unknown as Partial<mineflayer.Bot>;
  registerPerceptionTools(factory, () => mockBot as mineflayer.Bot);

  const executor = getExecutor(mockServer, 'check-build-site');
  const result = await executor({ x1: 0, y1: 64, z1: 0, x2: 2, y2: 65, z2: 0 });

  t.false(!!result.isError);
  const text = result.content[0].text;
  t.true(text.includes('Build site (3 x 1 x 2): 6 blocks. Base: 0 issue(s). Interior: 1 obstruction(s).'));
  t.true(text.includes('- obstruction at (1,64,0): stone'));
});

test('check-build-site flags missing ground under the base layer', async (t) => {
  const { mockServer, factory } = setup();
  const mockBot = {
    blockAt: sinon.stub().callsFake((pos: Vec3) => {
      if (pos.y === 63 && pos.x === 0 && pos.z === 0) return { name: 'air' };
      if (pos.y === 63) return { name: 'stone' };
      return { name: 'air' };
    })
  } as unknown as Partial<mineflayer.Bot>;
  registerPerceptionTools(factory, () => mockBot as mineflayer.Bot);

  const executor = getExecutor(mockServer, 'check-build-site');
  const result = await executor({ x1: 0, y1: 64, z1: 0, x2: 0, y2: 64, z2: 0 });

  t.false(!!result.isError);
  const text = result.content[0].text;
  t.true(text.includes('Base: 1 issue(s).'));
  t.true(text.includes('- no ground at (0,63,0)'));
});

test('check-build-site reports clear when the site is unobstructed', async (t) => {
  const { mockServer, factory } = setup();
  const mockBot = {
    blockAt: sinon.stub().callsFake((pos: Vec3) => ({
      name: pos.y === 63 ? 'stone' : 'air'
    }))
  } as unknown as Partial<mineflayer.Bot>;
  registerPerceptionTools(factory, () => mockBot as mineflayer.Bot);

  const executor = getExecutor(mockServer, 'check-build-site');
  const result = await executor({ x1: 0, y1: 64, z1: 0, x2: 1, y2: 65, z2: 1 });

  t.false(!!result.isError);
  t.is(result.content[0].text, 'Build site clear');
});

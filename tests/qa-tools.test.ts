import test from 'ava';
import sinon from 'sinon';
import { registerQATools } from '../src/tools/qa-tools.js';
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

test('registerQATools registers inspect-build and secure-perimeter', (t) => {
  const { mockServer, factory } = setup();
  registerQATools(factory, () => ({} as mineflayer.Bot));
  const names = (mockServer.tool as sinon.SinonStub).getCalls().map(c => c.args[0]);
  for (const name of ['inspect-build', 'secure-perimeter']) {
    t.true(names.includes(name), `missing ${name}`);
  }
});

test('inspect-build reports a floating block, an interior gap, and materials', async (t) => {
  const { mockServer, factory } = setup();
  const mockBot = {
    entity: { position: new Vec3(0, 64, 0) },
    blockAt: sinon.stub().callsFake((pos: Vec3) => {
      if (pos.y < 0) return { name: 'stone' };
      if (pos.y === 0) return { name: 'stone' };
      if (pos.y === 1 && pos.x === 1 && pos.z === 1) return { name: 'air' };
      if (pos.y === 1) return { name: 'stone' };
      if (pos.y === 2) return { name: 'stone' };
      return { name: 'air' };
    })
  } as unknown as Partial<mineflayer.Bot>;
  registerQATools(factory, () => mockBot as mineflayer.Bot);

  const executor = getExecutor(mockServer, 'inspect-build');
  const result = await executor({ x1: 0, y1: 0, z1: 0, x2: 2, y2: 2, z2: 2 });

  t.false(!!result.isError);
  const text = result.content[0].text;
  t.true(text.includes('Build volume (3 x 3 x 3): 27 cells, 26 non-air.'));
  t.true(text.includes('- stone: 26'));
  t.true(text.includes('- air: 1'));
  t.true(text.includes('- 1 floating block(s), 1 gap(s)'));
  t.true(text.includes('- floating at (1,2,1): stone'));
  t.true(text.includes('- gap at (1,1,1)'));
});

test('inspect-build reports No issues found for a clear volume', async (t) => {
  const { mockServer, factory } = setup();
  const mockBot = {
    entity: { position: new Vec3(0, 64, 0) },
    blockAt: sinon.stub().returns({ name: 'air' })
  } as unknown as Partial<mineflayer.Bot>;
  registerQATools(factory, () => mockBot as mineflayer.Bot);

  const executor = getExecutor(mockServer, 'inspect-build');
  const result = await executor({ x1: 0, y1: 0, z1: 0, x2: 1, y2: 1, z2: 1 });

  t.false(!!result.isError);
  const text = result.content[0].text;
  t.true(text.includes('Build volume (2 x 2 x 2): 8 cells, 0 non-air.'));
  t.true(text.includes('No issues found.'));
});

test('inspect-build rejects volumes larger than 512 blocks', async (t) => {
  const { mockServer, factory } = setup();
  const mockBot = {
    entity: { position: new Vec3(0, 64, 0) },
    blockAt: sinon.stub().returns({ name: 'stone' })
  } as unknown as Partial<mineflayer.Bot>;
  registerQATools(factory, () => mockBot as mineflayer.Bot);

  const executor = getExecutor(mockServer, 'inspect-build');
  const result = await executor({ x1: 0, y1: 0, z1: 0, x2: 8, y2: 8, z2: 8 });

  t.true(!!result.isError);
  t.true(result.content[0].text.includes('inspect-build too large (max 512). Narrow the volume.'));
});

test('secure-perimeter places a bounded ring of lights', async (t) => {
  const { mockServer, factory } = setup();
  const botPos = new Vec3(0, 64, 0);
  const placed = new Map<string, string>();
  const mockBot = {
    entity: { position: botPos },
    blockAt: sinon.stub().callsFake((pos: Vec3) => {
      const key = `${pos.x},${pos.y},${pos.z}`;
      if (placed.has(key)) return { name: 'torch', position: pos };
      if (pos.y < botPos.y) return { name: 'stone', position: pos };
      return { name: 'air', position: pos };
    }),
    placeBlock: sinon.stub().callsFake(async (ref: { position: Vec3 }, dir: Vec3) => {
      const target = ref.position.plus(dir);
      placed.set(`${target.x},${target.y},${target.z}`, 'torch');
    }),
    findBlock: sinon.stub().returns({ name: 'stone', position: new Vec3(0, 63, 0) }),
    canSeeBlock: () => true,
    lookAt: sinon.stub().resolves(),
    pathfinder: { goto: sinon.stub().resolves() }
  } as unknown as Partial<mineflayer.Bot>;
  registerQATools(factory, () => mockBot as mineflayer.Bot);

  const executor = getExecutor(mockServer, 'secure-perimeter');
  const result = await executor({ radius: 4 });

  t.false(!!result.isError);
  t.true(result.content[0].text.includes('Secured perimeter: placed 6 torch.'));
});
import test from 'ava';
import sinon from 'sinon';
import { registerScanTools } from '../src/tools/scan-tools.js';
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

test('registerScanTools registers scan-area and verify-block tools', (t) => {
  const { mockServer, factory } = setup();
  registerScanTools(factory, () => ({} as mineflayer.Bot));
  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const names = toolCalls.map(call => call.args[0]);
  t.true(names.includes('scan-area'));
  t.true(names.includes('verify-block'));
});

test('scan-area returns a readable block grid', async (t) => {
  const { mockServer, factory } = setup();
  const mockBot = {
    blockAt: sinon.stub().callsFake((pos: Vec3) => ({
      name: pos.y === 64 ? 'stone' : 'air'
    }))
  } as unknown as Partial<mineflayer.Bot>;
  registerScanTools(factory, () => mockBot as mineflayer.Bot);

  const executor = getExecutor(mockServer, 'scan-area');
  const result = await executor({ x1: 0, y1: 64, z1: 0, x2: 2, y2: 64, z2: 0 });

  t.false(!!result.isError);
  const text = result.content[0].text;
  t.true(text.includes('Area scan (0,64,0) to (2,64,0) [3 blocks]:'));
  t.true(text.includes('Y=64:'));
  t.true(text.includes('z=0: stone | stone | stone'));
});

test('scan-area rejects volumes larger than 125 blocks', async (t) => {
  const { mockServer, factory } = setup();
  const mockBot = {
    blockAt: sinon.stub().returns({ name: 'stone' })
  } as unknown as Partial<mineflayer.Bot>;
  registerScanTools(factory, () => mockBot as mineflayer.Bot);

  const executor = getExecutor(mockServer, 'scan-area');
  const result = await executor({ x1: 0, y1: 0, z1: 0, x2: 9, y2: 9, z2: 9 });

  t.true(!!result.isError);
  t.true(result.content[0].text.includes('scan-area too large (max 125 blocks). Narrow the volume.'));
});

test('verify-block returns the block at a position', async (t) => {
  const { mockServer, factory } = setup();
  const mockBot = {
    blockAt: sinon.stub().returns({ name: 'diamond_ore' })
  } as unknown as Partial<mineflayer.Bot>;
  registerScanTools(factory, () => mockBot as mineflayer.Bot);

  const executor = getExecutor(mockServer, 'verify-block');
  const result = await executor({ x: 5, y: 12, z: 3 });

  t.false(!!result.isError);
  t.true(result.content[0].text.includes('Block at (5, 12, 3): diamond_ore'));
});

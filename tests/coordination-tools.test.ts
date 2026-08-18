import test from 'ava';
import sinon from 'sinon';
import { registerCoordinationTools } from '../src/tools/coordination-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import type { BotManager } from '../src/bot-manager.js';
import { Vec3 } from 'vec3';

type MockManager = {
  getPrimaryName: sinon.SinonStub;
  getConnection: sinon.SinonStub;
  getNames: sinon.SinonStub;
  setShared: sinon.SinonStub;
  getShared: sinon.SinonStub;
  getAllShared: sinon.SinonStub;
  deleteShared: sinon.SinonStub;
};

function setup(): { server: sinon.SinonStub; manager: MockManager; shared: Map<string, string>; executor: (name: string) => (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }> } {
  const server = sinon.stub() as unknown as sinon.SinonStub;
  const mockServer = { tool: server } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;

  const shared = new Map<string, string>();
  const manager: MockManager = {
    getPrimaryName: sinon.stub().returns('primary'),
    getConnection: sinon.stub().returns(mockConnection),
    getNames: sinon.stub().returns([]),
    setShared: sinon.stub().callsFake((key: string, value: string) => { shared.set(key, value); }),
    getShared: sinon.stub().callsFake((key: string) => shared.get(key)),
    getAllShared: sinon.stub().callsFake(() => Object.fromEntries(shared)),
    deleteShared: sinon.stub().callsFake((key: string) => shared.delete(key))
  };

  const factory = new ToolFactory(mockServer, manager as unknown as BotManager);
  registerCoordinationTools(factory, manager as unknown as BotManager);

  const executor = (name: string) => {
    const call = (server as sinon.SinonStub).getCalls().find(c => c.args[0] === name);
    if (!call) throw new Error(`Tool ${name} not registered`);
    return call.args[3] as (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
  };

  return { server, manager, shared, executor };
}

test('registerCoordinationTools registers all 4 tools', (t) => {
  const { server } = setup();
  const toolNames = (server as sinon.SinonStub).getCalls().map(call => call.args[0]);

  t.true(toolNames.includes('agent-share'));
  t.true(toolNames.includes('agent-recall'));
  t.true(toolNames.includes('agent-forget'));
  t.true(toolNames.includes('list-bot-state'));
});

test('agent-share stores a value on the blackboard', async (t) => {
  const { manager, shared, executor } = setup();

  const result = await executor('agent-share')({ key: 'task', value: 'mine diamonds' });

  t.true(shared.get('task') === 'mine diamonds');
  t.true(manager.setShared.calledWith('task', 'mine diamonds'));
  t.is(result.content[0].text, 'Shared task = mine diamonds');
  t.falsy(result.isError);
});

test('agent-recall returns the shared value for a key', async (t) => {
  const { shared, executor } = setup();
  shared.set('task', 'mine diamonds');

  const result = await executor('agent-recall')({ key: 'task' });

  t.is(result.content[0].text, 'Shared: mine diamonds');
});

test('agent-recall reports when a key has no shared value', async (t) => {
  const { executor } = setup();

  const result = await executor('agent-recall')({ key: 'missing' });

  t.is(result.content[0].text, 'No shared value for missing');
});

test('agent-recall without a key lists all shared values', async (t) => {
  const { shared, executor } = setup();
  shared.set('task', 'mine diamonds');
  shared.set('build', 'castle');

  const result = await executor('agent-recall')({});

  t.true(result.content[0].text.includes('task = mine diamonds'));
  t.true(result.content[0].text.includes('build = castle'));
});

test('agent-recall without a key reports when nothing is shared', async (t) => {
  const { executor } = setup();

  const result = await executor('agent-recall')({});

  t.is(result.content[0].text, 'Nothing shared');
});

test('agent-forget deletes a single shared value', async (t) => {
  const { shared, executor } = setup();
  shared.set('task', 'mine diamonds');
  shared.set('build', 'castle');

  const result = await executor('agent-forget')({ key: 'task' });

  t.is(shared.get('task'), undefined);
  t.true(shared.has('build'));
  t.is(result.content[0].text, 'Forgot shared value for task');
});

test('agent-forget without a key clears all shared values', async (t) => {
  const { shared, executor } = setup();
  shared.set('task', 'mine diamonds');
  shared.set('build', 'castle');

  const result = await executor('agent-forget')({});

  t.is(shared.size, 0);
  t.is(result.content[0].text, 'Cleared all shared values');
});

test('list-bot-state lists bots with state and position', async (t) => {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const primaryConn = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }),
    getState: sinon.stub().returns('connected'),
    getBot: sinon.stub().returns({ entity: { position: new Vec3(10, 64, 20) } })
  } as unknown as BotConnection;
  const helperConn = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }),
    getState: sinon.stub().returns('connecting'),
    getBot: sinon.stub().returns({ entity: { position: new Vec3(0, 64, 0) } })
  } as unknown as BotConnection;
  const manager = {
    getPrimaryName: sinon.stub().returns('primary'),
    getConnection: sinon.stub().callsFake((name?: string) => (name ?? 'primary') === 'helper' ? helperConn : primaryConn),
    getNames: sinon.stub().returns(['primary', 'helper']),
    setShared: sinon.stub(),
    getShared: sinon.stub(),
    getAllShared: sinon.stub().returns({}),
    deleteShared: sinon.stub()
  } as unknown as BotManager;

  const factory = new ToolFactory(mockServer, manager);
  registerCoordinationTools(factory, manager);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const listCall = toolCalls.find(call => call.args[0] === 'list-bot-state')!;
  const result = await listCall.args[3]({});

  t.true(result.content[0].text.includes('primary (primary): connected @ (10, 64, 20)'));
  t.true(result.content[0].text.includes('helper: connecting @ (0, 64, 0)'));
});

test('list-bot-state reports when no bots are active', async (t) => {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const manager = {
    getPrimaryName: sinon.stub().returns('primary'),
    getConnection: sinon.stub().returns(mockConnection),
    getNames: sinon.stub().returns([]),
    setShared: sinon.stub(),
    getShared: sinon.stub(),
    getAllShared: sinon.stub().returns({}),
    deleteShared: sinon.stub()
  } as unknown as BotManager;

  const factory = new ToolFactory(mockServer, manager);
  registerCoordinationTools(factory, manager);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const listCall = toolCalls.find(call => call.args[0] === 'list-bot-state')!;
  const result = await listCall.args[3]({});

  t.is(result.content[0].text, 'No bots active');
});

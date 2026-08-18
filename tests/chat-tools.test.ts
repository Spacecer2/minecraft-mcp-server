import test from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'node:events';
import { registerChatTools } from '../src/tools/chat-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import { MessageStore } from '../src/message-store.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import type mineflayer from 'mineflayer';

function createHarness() {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const mockManager = {
    getPrimaryName: sinon.stub().returns('primary'),
    getConnection: sinon.stub().returns(mockConnection)
  };
  const factory = new ToolFactory(mockServer, mockManager);
  const mockBot = Object.assign(new EventEmitter(), {
    username: 'testbot',
    chat: sinon.stub()
  }) as unknown as mineflayer.Bot;
  const getBot = () => mockBot;
  const messageStore = new MessageStore();

  registerChatTools(factory, getBot, () => messageStore);

  return { mockServer, mockConnection, mockManager, factory, mockBot, getBot, messageStore };
}


test('registerChatTools registers send-chat tool', (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const mockManager = {
    getPrimaryName: sinon.stub().returns('primary'),
    getConnection: sinon.stub().returns(mockConnection)
  };
  const factory = new ToolFactory(mockServer, mockManager);
  const mockBot = {} as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;
  const messageStore = new MessageStore();

  registerChatTools(factory, getBot, () => messageStore);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const sendChatCall = toolCalls.find(call => call.args[0] === 'send-chat');

  t.truthy(sendChatCall);
  t.is(sendChatCall!.args[1], 'Send a chat message in-game');
});

test('registerChatTools registers read-chat tool', (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const mockManager = {
    getPrimaryName: sinon.stub().returns('primary'),
    getConnection: sinon.stub().returns(mockConnection)
  };
  const factory = new ToolFactory(mockServer, mockManager);
  const mockBot = {} as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;
  const messageStore = new MessageStore();

  registerChatTools(factory, getBot, () => messageStore);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const readChatCall = toolCalls.find(call => call.args[0] === 'read-chat');

  t.truthy(readChatCall);
  t.is(readChatCall!.args[1], 'Get recent chat messages from players');
});

test('send-chat calls bot.chat with message', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const mockManager = {
    getPrimaryName: sinon.stub().returns('primary'),
    getConnection: sinon.stub().returns(mockConnection)
  };
  const factory = new ToolFactory(mockServer, mockManager);
  
  const mockBot = {
    chat: sinon.stub()
  } as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;
  const messageStore = new MessageStore();

  registerChatTools(factory, getBot, () => messageStore);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const sendChatCall = toolCalls.find(call => call.args[0] === 'send-chat');
  const executor = sendChatCall!.args[3];

  const result = await executor({ message: 'Hello world' });

  t.true((mockBot.chat as sinon.SinonStub).calledOnceWith('Hello world'));
  t.true(result.content[0].text.includes('Hello world'));
});

test('read-chat returns no messages when empty', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const mockManager = {
    getPrimaryName: sinon.stub().returns('primary'),
    getConnection: sinon.stub().returns(mockConnection)
  };
  const factory = new ToolFactory(mockServer, mockManager);
  
  const mockBot = {} as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;
  const messageStore = new MessageStore();

  registerChatTools(factory, getBot, () => messageStore);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const readChatCall = toolCalls.find(call => call.args[0] === 'read-chat');
  const executor = readChatCall!.args[3];

  const result = await executor({});

  t.true(result.content[0].text.includes('No chat messages found'));
});

test('read-chat returns formatted messages', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const mockManager = {
    getPrimaryName: sinon.stub().returns('primary'),
    getConnection: sinon.stub().returns(mockConnection)
  };
  const factory = new ToolFactory(mockServer, mockManager);
  
  const mockBot = {} as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;
  const messageStore = new MessageStore();

  messageStore.addMessage('player1', 'Hello');
  messageStore.addMessage('player2', 'Hi there');

  registerChatTools(factory, getBot, () => messageStore);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const readChatCall = toolCalls.find(call => call.args[0] === 'read-chat');
  const executor = readChatCall!.args[3];

  const result = await executor({ count: 10 });

  t.true(result.content[0].text.includes('player1'));
  t.true(result.content[0].text.includes('Hello'));
  t.true(result.content[0].text.includes('player2'));
  t.true(result.content[0].text.includes('Hi there'));
  t.true(result.content[0].text.includes('2 chat message'));
});

test('read-chat respects count parameter', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const mockManager = {
    getPrimaryName: sinon.stub().returns('primary'),
    getConnection: sinon.stub().returns(mockConnection)
  };
  const factory = new ToolFactory(mockServer, mockManager);
  
  const mockBot = {} as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;
  const messageStore = new MessageStore();

  for (let i = 0; i < 20; i++) {
    messageStore.addMessage(`player${i}`, `Message ${i}`);
  }

  registerChatTools(factory, getBot, () => messageStore);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const readChatCall = toolCalls.find(call => call.args[0] === 'read-chat');
  const executor = readChatCall!.args[3];

  const result = await executor({ count: 5 });

  t.true(result.content[0].text.includes('5 chat message'));
});

test('read-chat limits count to max messages', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const mockManager = {
    getPrimaryName: sinon.stub().returns('primary'),
    getConnection: sinon.stub().returns(mockConnection)
  };
  const factory = new ToolFactory(mockServer, mockManager);
  
  const mockBot = {} as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;
  const messageStore = new MessageStore();

  for (let i = 0; i < 10; i++) {
    messageStore.addMessage(`player${i}`, `Message ${i}`);
  }

  registerChatTools(factory, getBot, () => messageStore);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const readChatCall = toolCalls.find(call => call.args[0] === 'read-chat');
  const executor = readChatCall!.args[3];

  const result = await executor({ count: 200 });

  t.true(result.content[0].text.includes('10 chat message'));
});

test('read-new-chat returns no messages when empty', async (t) => {
  const { mockServer } = createHarness();

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const readNewCall = toolCalls.find(call => call.args[0] === 'read-new-chat');
  const executor = readNewCall!.args[3];

  const result = await executor({});

  t.true(result.content[0].text.includes('No new chat messages'));
});

test('read-new-chat filters messages by from (case-insensitive partial)', async (t) => {
  const { mockServer, messageStore } = createHarness();

  messageStore.addMessage('Alice', 'Hello Alice');
  messageStore.addMessage('Bob', 'Hello Bob');
  messageStore.addMessage('alice2', 'Another Alice');

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const readNewCall = toolCalls.find(call => call.args[0] === 'read-new-chat');
  const executor = readNewCall!.args[3];

  const result = await executor({ from: 'ALI' });

  t.true(result.content[0].text.includes('2 new chat message'));
  t.true(result.content[0].text.includes('Alice'));
  t.true(result.content[0].text.includes('alice2'));
  t.false(result.content[0].text.includes('Bob'));
});

test('read-new-chat filters messages by onlyMentionsMe', async (t) => {
  const { mockServer, messageStore } = createHarness();

  messageStore.addMessage('Alice', 'Hello testbot please help');
  messageStore.addMessage('Bob', 'General chat, no mentions');

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const readNewCall = toolCalls.find(call => call.args[0] === 'read-new-chat');
  const executor = readNewCall!.args[3];

  const result = await executor({ onlyMentionsMe: true });

  t.true(result.content[0].text.includes('Alice'));
  t.true(result.content[0].text.includes('Hello testbot'));
  t.false(result.content[0].text.includes('General chat'));
});

test('read-new-chat returns no messages when filter matches nothing', async (t) => {
  const { mockServer, messageStore } = createHarness();

  messageStore.addMessage('Alice', 'Hello');

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const readNewCall = toolCalls.find(call => call.args[0] === 'read-new-chat');
  const executor = readNewCall!.args[3];

  const result = await executor({ from: 'zoe' });

  t.true(result.content[0].text.includes('No new chat messages'));
});

test('peek-chat filters by from without advancing cursor', async (t) => {
  const { mockServer, messageStore } = createHarness();

  messageStore.addMessage('Alice', 'Hi');
  messageStore.addMessage('Bob', 'Yo');

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const peekCall = toolCalls.find(call => call.args[0] === 'peek-chat');
  const executor = peekCall!.args[3];

  const result = await executor({ from: 'alice' });

  t.true(result.content[0].text.includes('Alice'));
  t.false(result.content[0].text.includes('Bob'));

  const readNewCall = toolCalls.find(call => call.args[0] === 'read-new-chat');
  const readNewExecutor = readNewCall!.args[3];
  const next = await readNewExecutor({});
  t.true(next.content[0].text.includes('2 new chat message'));
});

test('wait-for-chat returns pending messages immediately', async (t) => {
  const { mockServer, messageStore } = createHarness();

  messageStore.addMessage('player1', 'Hello');

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const waitChatCall = toolCalls.find(call => call.args[0] === 'wait-for-chat');
  const executor = waitChatCall!.args[3];

  const result = await executor({});

  t.true(result.content[0].text.includes('player1'));
  t.true(result.content[0].text.includes('Hello'));
});

test('wait-for-chat resolves on chat event', async (t) => {
  const { mockServer, messageStore, getBot } = createHarness();

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const waitChatCall = toolCalls.find(call => call.args[0] === 'wait-for-chat');
  const executor = waitChatCall!.args[3];

  const promise = executor({ timeoutSeconds: 10 });

  messageStore.addMessage('player1', 'Hello there');
  (getBot() as unknown as EventEmitter).emit('chat', 'player1', 'Hello there');

  const result = await promise;

  t.true(result.content[0].text.includes('Hello there'));
  t.true(result.content[0].text.includes('player1'));
});

test('wait-for-chat with from filter ignores non-matching messages', async (t) => {
  const { mockServer, messageStore, getBot } = createHarness();

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const waitChatCall = toolCalls.find(call => call.args[0] === 'wait-for-chat');
  const executor = waitChatCall!.args[3];

  const promise = executor({ timeoutSeconds: 10, from: 'alice' });

  messageStore.addMessage('bob', 'Hi bob');
  (getBot() as unknown as EventEmitter).emit('chat', 'bob', 'Hi bob');

  messageStore.addMessage('alice', 'Hello from alice');
  (getBot() as unknown as EventEmitter).emit('chat', 'alice', 'Hello from alice');

  const result = await promise;

  t.true(result.content[0].text.includes('alice'));
  t.false(result.content[0].text.includes('Hi bob'));
});

test('wait-for-chat times out when no message arrives', async (t) => {
  const { mockServer } = createHarness();

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const waitChatCall = toolCalls.find(call => call.args[0] === 'wait-for-chat');
  const executor = waitChatCall!.args[3];

  const result = await executor({ timeoutSeconds: 1 });

  t.true(result.content[0].text.includes('Timed out after 1s'));
});


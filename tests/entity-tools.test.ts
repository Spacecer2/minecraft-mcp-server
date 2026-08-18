import test from 'ava';
import sinon from 'sinon';
import { registerEntityTools } from '../src/tools/entity-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import type mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';

test('registerEntityTools registers find-entity tool', (t) => {
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

  registerEntityTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const findEntityCall = toolCalls.find(call => call.args[0] === 'find-entity');

  t.truthy(findEntityCall);
  t.is(findEntityCall!.args[1], 'Find the nearest entity of a specific type');
});

test('find-entity returns entity when found', async (t) => {
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

  const mockEntity = {
    name: 'zombie',
    type: 'mob',
    position: new Vec3(5, 64, 8)
  };
  const mockBot = {
    entity: {
      position: new Vec3(0, 64, 0)
    },
    nearestEntity: sinon.stub().returns(mockEntity)
  } as unknown as mineflayer.Bot;
  const getBot = () => mockBot;

  registerEntityTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const findEntityCall = toolCalls.find(call => call.args[0] === 'find-entity');
  const executor = findEntityCall!.args[3];

  const result = await executor({ type: 'zombie', maxDistance: 16 });

  t.true(result.content[0].text.includes('zombie'));
  t.true(result.content[0].text.includes('5'));
  t.true(result.content[0].text.includes('64'));
  t.true(result.content[0].text.includes('8'));
});

test('find-entity returns not found when entity too far', async (t) => {
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
  
  const mockEntity = {
    name: 'zombie',
    type: 'mob',
    position: new Vec3(100, 64, 100)
  };
  const mockBot = {
    entity: {
      position: new Vec3(0, 64, 0)
    },
    nearestEntity: sinon.stub().returns(mockEntity)
  } as unknown as mineflayer.Bot;
  const getBot = () => mockBot;

  registerEntityTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const findEntityCall = toolCalls.find(call => call.args[0] === 'find-entity');
  const executor = findEntityCall!.args[3];

  const result = await executor({ type: 'zombie', maxDistance: 16 });

  t.true(result.content[0].text.includes('No zombie found within 16 blocks'));
});

test('find-entity returns not found when no entity exists', async (t) => {
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
    entity: {
      position: new Vec3(0, 64, 0)
    },
    nearestEntity: sinon.stub().returns(null)
  } as unknown as mineflayer.Bot;
  const getBot = () => mockBot;

  registerEntityTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const findEntityCall = toolCalls.find(call => call.args[0] === 'find-entity');
  const executor = findEntityCall!.args[3];

  const result = await executor({ type: 'zombie', maxDistance: 16 });

  t.true(result.content[0].text.includes('No zombie found'));
});

test('find-entity handles player type', async (t) => {
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
  
  const mockEntity = {
    username: 'TestPlayer',
    type: 'player',
    position: new Vec3(5, 64, 5)
  };
  const mockBot = {
    entity: {
      position: new Vec3(0, 64, 0)
    },
    nearestEntity: sinon.stub().returns(mockEntity)
  } as unknown as mineflayer.Bot;
  const getBot = () => mockBot;

  registerEntityTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const findEntityCall = toolCalls.find(call => call.args[0] === 'find-entity');
  const executor = findEntityCall!.args[3];

  const result = await executor({ type: 'player', maxDistance: 16 });

  t.true(result.content[0].text.includes('TestPlayer'));
});

test('find-entity searches any entity when type not specified', async (t) => {
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
  
  const mockEntity = {
    name: 'cow',
    type: 'mob',
    position: new Vec3(5, 64, 5)
  };
  const mockBot = {
    entity: {
      position: new Vec3(0, 64, 0)
    },
    nearestEntity: sinon.stub().returns(mockEntity)
  } as unknown as mineflayer.Bot;
  const getBot = () => mockBot;

  registerEntityTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const findEntityCall = toolCalls.find(call => call.args[0] === 'find-entity');
  const executor = findEntityCall!.args[3];

  const result = await executor({ maxDistance: 16 });

  t.true(result.content[0].text.includes('cow'));
});

function setupWithBot(mockBot: unknown) {
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
  const getBot = () => mockBot as mineflayer.Bot;
  registerEntityTools(factory, getBot);
  return mockServer;
}

function getToolExecutor(mockServer: McpServer, toolName: string) {
  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const call = toolCalls.find(c => c.args[0] === toolName);
  return call!.args[3];
}

test('registerEntityTools registers find-hostiles tool', (t) => {
  const mockServer = setupWithBot({});
  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const call = toolCalls.find(c => c.args[0] === 'find-hostiles');
  t.truthy(call);
  t.is(call!.args[1], 'Find nearby hostile mobs (zombies, creepers, etc.) within a maximum distance');
});

test('find-hostiles returns a hostile entity within range', async (t) => {
  const mockBot = {
    entity: { id: 1, position: new Vec3(0, 64, 0) },
    entities: new Map<number, unknown>([
      [1, { id: 1, name: 'Player', type: 'player', position: new Vec3(0, 64, 0) }],
      [10, { id: 10, name: 'zombie', type: 'mob', position: new Vec3(5, 64, 8), health: 10 }],
      [11, { id: 11, name: 'cow', type: 'mob', position: new Vec3(3, 64, 0), health: 10 }]
    ])
  };
  const mockServer = setupWithBot(mockBot);
  const executor = getToolExecutor(mockServer, 'find-hostiles');

  const result = await executor({ maxDistance: 24 });

  const text = result.content[0].text;
  t.true(text.includes('- zombie at (5, 64, 8), distance 9.4, health 10'));
  t.false(text.includes('cow'));
});

test('find-hostiles respects maxDistance', async (t) => {
  const mockBot = {
    entity: { id: 1, position: new Vec3(0, 64, 0) },
    entities: new Map<number, unknown>([
      [10, { id: 10, name: 'zombie', type: 'mob', position: new Vec3(30, 64, 0), health: 10 }]
    ])
  };
  const mockServer = setupWithBot(mockBot);
  const executor = getToolExecutor(mockServer, 'find-hostiles');

  const result = await executor({ maxDistance: 16 });

  t.is(result.content[0].text, 'No hostiles within 16 blocks');
});

test('find-hostiles returns no hostiles when entities is empty', async (t) => {
  const mockBot = {
    entity: { id: 1, position: new Vec3(0, 64, 0) },
    entities: new Map<number, unknown>()
  };
  const mockServer = setupWithBot(mockBot);
  const executor = getToolExecutor(mockServer, 'find-hostiles');

  const result = await executor({ maxDistance: 24 });

  t.is(result.content[0].text, 'No hostiles within 24 blocks');
});

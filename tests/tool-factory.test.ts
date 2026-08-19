import test from 'ava';
import sinon from 'sinon';
import { ToolFactory, makePrimalDispatcher } from '../src/tool-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';

test('createResponse returns proper MCP response format', (t) => {
  const mockServer = {} as McpServer;
  const mockConnection = {} as BotConnection;
  const mockManager = {
    getPrimaryName: sinon.stub().returns('primary'),
    getConnection: sinon.stub().returns(mockConnection)
  };
  const factory = new ToolFactory(mockServer, mockManager);
  
  const response = factory.createResponse('Test message');
  
  t.deepEqual(response, {
    content: [{ type: 'text', text: 'Test message' }]
  });
});

test('createResponse handles empty string', (t) => {
  const mockServer = {} as McpServer;
  const mockConnection = {} as BotConnection;
  const mockManager = {
    getPrimaryName: sinon.stub().returns('primary'),
    getConnection: sinon.stub().returns(mockConnection)
  };
  const factory = new ToolFactory(mockServer, mockManager);
  
  const response = factory.createResponse('');
  
  t.deepEqual(response, {
    content: [{ type: 'text', text: '' }]
  });
});

test('createErrorResponse with Error object', (t) => {
  const mockServer = {} as McpServer;
  const mockConnection = {} as BotConnection;
  const mockManager = {
    getPrimaryName: sinon.stub().returns('primary'),
    getConnection: sinon.stub().returns(mockConnection)
  };
  const factory = new ToolFactory(mockServer, mockManager);
  
  const error = new Error('Connection timeout');
  const response = factory.createErrorResponse(error);
  
  t.deepEqual(response, {
    content: [{ type: 'text', text: 'Failed: Connection timeout' }],
    isError: true
  });
});

test('createErrorResponse with string', (t) => {
  const mockServer = {} as McpServer;
  const mockConnection = {} as BotConnection;
  const mockManager = {
    getPrimaryName: sinon.stub().returns('primary'),
    getConnection: sinon.stub().returns(mockConnection)
  };
  const factory = new ToolFactory(mockServer, mockManager);
  
  const response = factory.createErrorResponse('Invalid argument');
  
  t.deepEqual(response, {
    content: [{ type: 'text', text: 'Failed: Invalid argument' }],
    isError: true
  });
});

test('createErrorResponse includes isError flag', (t) => {
  const mockServer = {} as McpServer;
  const mockConnection = {} as BotConnection;
  const mockManager = {
    getPrimaryName: sinon.stub().returns('primary'),
    getConnection: sinon.stub().returns(mockConnection)
  };
  const factory = new ToolFactory(mockServer, mockManager);
  
  const response = factory.createErrorResponse('Error occurred');
  
  t.true(response.isError === true);
});

test('registerTool calls server.tool with correct parameters', async (t) => {
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
  const schema = { type: 'object', properties: {} };
  const executor = sinon.stub().resolves({ content: [{ type: 'text', text: 'Success' }] });
  
  factory.registerTool('test_tool', 'A test tool', schema, executor);
  
  t.true((mockServer.tool as sinon.SinonStub).calledOnce);
  t.is((mockServer.tool as sinon.SinonStub).firstCall.args[0], 'test_tool');
  t.is((mockServer.tool as sinon.SinonStub).firstCall.args[1], 'A test tool');
  t.truthy((mockServer.tool as sinon.SinonStub).firstCall.args[2]);
});

test('registerTool executor checks connection before executing', async (t) => {
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
  const executor = sinon.stub().resolves({ content: [{ type: 'text', text: 'Success' }] });
  
  factory.registerTool('test_tool', 'A test tool', {}, executor);
  
  const registeredExecutor = (mockServer.tool as sinon.SinonStub).firstCall.args[3];
  await registeredExecutor({ arg: 'value' });
  
  t.true((mockConnection.checkConnectionAndReconnect as sinon.SinonStub).calledOnce);
});

test('registerTool executor returns error when not connected', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ 
      connected: false, 
      message: 'Bot is not connected' 
    })
  } as unknown as BotConnection;
  const mockManager = {
    getPrimaryName: sinon.stub().returns('primary'),
    getConnection: sinon.stub().returns(mockConnection)
  };
  
  const factory = new ToolFactory(mockServer, mockManager);
  const executor = sinon.stub().resolves({ content: [{ type: 'text', text: 'Success' }] });
  
  factory.registerTool('test_tool', 'A test tool', {}, executor);
  
  const registeredExecutor = (mockServer.tool as sinon.SinonStub).firstCall.args[3];
  const response = await registeredExecutor({ arg: 'value' });
  
  t.deepEqual(response, {
    content: [{ type: 'text', text: 'Bot is not connected' }],
    isError: true
  });
  t.true((executor as sinon.SinonStub).notCalled);
});

test('registerTool executor calls executor when connected', async (t) => {
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
  const executor = sinon.stub().resolves({ content: [{ type: 'text', text: 'Success' }] });
  
  factory.registerTool('test_tool', 'A test tool', {}, executor);
  
  const registeredExecutor = (mockServer.tool as sinon.SinonStub).firstCall.args[3];
  const args = { arg: 'value' };
  await registeredExecutor(args);
  
  t.true((executor as sinon.SinonStub).calledOnceWith(args));
});

test('registerTool executor returns executor result when successful', async (t) => {
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
  const expectedResponse = { content: [{ type: 'text', text: 'Tool executed' }] };
  const executor = sinon.stub().resolves(expectedResponse);
  
  factory.registerTool('test_tool', 'A test tool', {}, executor);
  
  const registeredExecutor = (mockServer.tool as sinon.SinonStub).firstCall.args[3];
  const response = await registeredExecutor({ arg: 'value' });
  
  t.deepEqual(response, expectedResponse);
});

test('registerTool executor catches and returns error response on exception', async (t) => {
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
  const error = new Error('Execution failed');
  const executor = sinon.stub().rejects(error);
  
  factory.registerTool('test_tool', 'A test tool', {}, executor);
  
  const registeredExecutor = (mockServer.tool as sinon.SinonStub).firstCall.args[3];
  const response = await registeredExecutor({ arg: 'value' });
  
  t.deepEqual(response, {
    content: [{ type: 'text', text: 'Failed: Execution failed' }],
    isError: true
  });
});

// ---------------------------------------------------------------------------
// TOOL VISIBILITY ('primal' hidden tools vs 'major' LLM-facing tools)
// ---------------------------------------------------------------------------

function makeVisibilityHarness() {
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
  return { mockServer, factory };
}

test('registerTool with visibility primal does NOT surface via server.tool but stores the executor', async (t) => {
  const { mockServer, factory } = makeVisibilityHarness();
  const executor = sinon.stub().resolves({ content: [{ type: 'text', text: 'Internal done' }] });

  factory.registerTool('primal-internal', 'Hidden internal tool', {}, executor, { visibility: 'primal' });

  t.is((mockServer.tool as sinon.SinonStub).callCount, 0, 'server.tool must NOT be called for a primal tool');
  t.true(factory.isPrimalTool('primal-internal'));

  const response = await factory.callPrimal('primal-internal', { arg: 1 });
  t.deepEqual(response, { content: [{ type: 'text', text: 'Internal done' }] });
  t.true((executor as sinon.SinonStub).calledOnceWith({ arg: 1 }));
});

test('primal tool is not listed among LLM-facing server.tool registrations', (t) => {
  const { mockServer, factory } = makeVisibilityHarness();
  factory.registerTool('visible-tool', 'Visible', {}, sinon.stub().resolves({ content: [{ type: 'text', text: 'ok' }] }));
  factory.registerTool('hidden-tool', 'Hidden', {}, sinon.stub().resolves({ content: [{ type: 'text', text: 'ok' }] }), { visibility: 'primal' });

  const surfaced = (mockServer.tool as sinon.SinonStub).getCalls().map((c) => c.args[0]);
  t.deepEqual(surfaced, ['visible-tool']);
  t.false(surfaced.includes('hidden-tool'));
  t.true(factory.isPrimalTool('hidden-tool'));
  t.false(factory.isPrimalTool('visible-tool'));
});

test('registerTool defaults to major when no visibility is specified', (t) => {
  const { mockServer, factory } = makeVisibilityHarness();
  factory.registerTool('default-major', 'Default', {}, sinon.stub().resolves({ content: [{ type: 'text', text: 'ok' }] }));

  t.is((mockServer.tool as sinon.SinonStub).callCount, 1);
  t.is((mockServer.tool as sinon.SinonStub).firstCall.args[0], 'default-major');
  t.false(factory.isPrimalTool('default-major'));
});

test('setPrimalToolNames hides tools by name without touching the registration call', (t) => {
  const { mockServer, factory } = makeVisibilityHarness();
  factory.setPrimalToolNames(['hidden-by-name', 'also-hidden']);
  factory.registerTool('visible-tool', 'Visible', {}, sinon.stub().resolves({ content: [{ type: 'text', text: 'ok' }] }));
  factory.registerTool('hidden-by-name', 'Hidden', {}, sinon.stub().resolves({ content: [{ type: 'text', text: 'ok' }] }));
  factory.registerTool('also-hidden', 'Hidden too', {}, sinon.stub().resolves({ content: [{ type: 'text', text: 'ok' }] }));

  const surfaced = (mockServer.tool as sinon.SinonStub).getCalls().map((c) => c.args[0]);
  t.deepEqual(surfaced, ['visible-tool']);
  t.true(factory.isPrimalTool('hidden-by-name'));
  t.true(factory.isPrimalTool('also-hidden'));
  t.false(factory.isPrimalTool('visible-tool'));
});

test('setPrimalToolNames can be called after registration is already surfaced', (t) => {
  const { mockServer, factory } = makeVisibilityHarness();
  factory.registerTool('registered-tool', 'Tool', {}, sinon.stub().resolves({ content: [{ type: 'text', text: 'ok' }] }));
  // Marking a name after registration does not retroactively unsurface it
  // (registration already called server.tool), but it is recorded as primal.
  factory.setPrimalToolNames(['registered-tool']);
  t.is((mockServer.tool as sinon.SinonStub).callCount, 1);
});

test('callPrimal returns an error response for an unknown primal tool', async (t) => {
  const { factory } = makeVisibilityHarness();
  const response = await factory.callPrimal('does-not-exist', {});
  t.is(response.isError, true);
  t.true(response.content[0].text.includes('Unknown primal tool: does-not-exist'));
});

// ---------------------------------------------------------------------------
// makePrimalDispatcher — the live seam the task-runner uses to invoke hidden
// primal tools through callPrimal.
// ---------------------------------------------------------------------------

test('makePrimalDispatcher invokes the executor of a registered hidden tool and returns its result', async (t) => {
  const { factory } = makeVisibilityHarness();
  const executor = sinon.stub().resolves({
    content: [{ type: 'text', text: 'Collected 32/32 wood after 1 digs' }]
  });
  factory.registerTool('collect-item', 'Hidden gather', {}, executor, { visibility: 'primal' });

  const dispatch = makePrimalDispatcher(factory);
  const result = await dispatch('collect-item', { itemName: 'wood', count: 32 });

  t.true(result.ok);
  t.is(result.text, 'Collected 32/32 wood after 1 digs');
  t.true((executor as sinon.SinonStub).calledOnceWith({ itemName: 'wood', count: 32 }));
});

test('makePrimalDispatcher reports ok:false for an unknown tool name', async (t) => {
  const { factory } = makeVisibilityHarness();
  const dispatch = makePrimalDispatcher(factory);
  const result = await dispatch('does-not-exist', {});
  t.false(result.ok);
  t.true(result.text.includes('Unknown primal tool: does-not-exist'));
});

test('makePrimalDispatcher reports ok:false when the executor throws', async (t) => {
  const { factory } = makeVisibilityHarness();
  factory.registerTool(
    'boom-tool',
    'Hidden',
    {},
    sinon.stub().rejects(new Error('explosion')),
    { visibility: 'primal' }
  );
  const dispatch = makePrimalDispatcher(factory);
  const result = await dispatch('boom-tool', {});
  t.false(result.ok);
  t.true(result.text.includes('explosion'));
});

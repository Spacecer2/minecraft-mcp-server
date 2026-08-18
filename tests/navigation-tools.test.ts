import test from 'ava';
import sinon from 'sinon';
import { registerNavigationTools } from '../src/tools/navigation-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import type { BotConnection } from '../src/bot-connection.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';

function setup(mockBot: Partial<mineflayer.Bot>) {
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

  registerNavigationTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  return { factory, toolCalls };
}

function executorFor(toolCalls: sinon.SinonSpyCall[], name: string) {
  const call = toolCalls.find(c => c.args[0] === name);
  return call!.args[3];
}

test('registerNavigationTools registers move-toward, move-toward-bearing, goto-entity, save-location, goto-named, and list-locations', (t) => {
  const { toolCalls } = setup({});
  const names = toolCalls.map(c => c.args[0]);
  for (const expected of ['move-toward', 'move-toward-bearing', 'goto-entity', 'save-location', 'goto-named', 'list-locations']) {
    t.true(names.includes(expected), `expected ${expected} to be registered`);
  }
});

test('list-locations returns message when empty', async (t) => {
  const { toolCalls } = setup({});
  const listExecutor = executorFor(toolCalls, 'list-locations');

  const result = await listExecutor({});

  t.falsy(result.isError);
  t.true(result.content[0].text.includes('No saved locations'));
});

test('move-toward moves relative to current position', async (t) => {
  const mockBot = {
    pathfinder: {
      goto: sinon.stub().resolves(),
      stop: sinon.stub()
    },
    entity: {
      position: new Vec3(10, 64, 10)
    }
  } as unknown as Partial<mineflayer.Bot>;
  const { toolCalls } = setup(mockBot);
  const executor = executorFor(toolCalls, 'move-toward');

  const result = await executor({ dx: 5, dz: -2 });

  t.falsy(result.isError);
  t.true(result.content[0].text.includes('Moved to near (15, 64, 8)'));
  t.true(result.content[0].text.includes('now at (10, 64, 10)'));
  t.true((mockBot.pathfinder!.stop as sinon.SinonStub).notCalled);
});

test.serial('move-toward returns timeout error and stops pathfinder', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());

  const mockBot = {
    pathfinder: {
      goto: sinon.stub().returns(new Promise(() => {})),
      stop: sinon.stub()
    },
    entity: {
      position: new Vec3(10, 64, 10)
    }
  } as unknown as Partial<mineflayer.Bot>;
  const { toolCalls } = setup(mockBot);
  const executor = executorFor(toolCalls, 'move-toward');

  const resultPromise = executor({ dx: 5, dz: -2, timeoutMs: 1000 });
  await clock.tickAsync(1000);
  const result = await resultPromise;

  t.true(result.isError);
  t.true(result.content[0].text.includes('Move timed out after 1000ms'));
  t.true(result.content[0].text.includes('Current position: (10, 64, 10)'));
  t.true(result.content[0].text.includes('target: (15, 64, 8)'));
  t.true((mockBot.pathfinder!.stop as sinon.SinonStub).calledOnce);
});

test('move-toward-bearing computes the correct target for heading n', async (t) => {
  const mockBot = {
    pathfinder: {
      goto: sinon.stub().resolves(),
      stop: sinon.stub()
    },
    entity: {
      position: new Vec3(10, 64, 10)
    }
  } as unknown as Partial<mineflayer.Bot>;
  const { toolCalls } = setup(mockBot);
  const executor = executorFor(toolCalls, 'move-toward-bearing');

  const result = await executor({ heading: 'n', distance: 5 });

  const goal = (mockBot.pathfinder!.goto as sinon.SinonStub).firstCall.args[0];
  t.is(goal.x, 10);
  t.is(goal.y, 64);
  t.is(goal.z, 5);
  t.falsy(result.isError);
  t.true(result.content[0].text.includes('Moved 5 blocks n'));
  t.true(result.content[0].text.includes('now at (10, 64, 10)'));
});

test('move-toward-bearing maps heading to the correct offset', async (t) => {
  const mockBot = {
    pathfinder: {
      goto: sinon.stub().resolves(),
      stop: sinon.stub()
    },
    entity: {
      position: new Vec3(0, 64, 0)
    }
  } as unknown as Partial<mineflayer.Bot>;
  const { toolCalls } = setup(mockBot);
  const executor = executorFor(toolCalls, 'move-toward-bearing');

  const cases: Array<{ heading: string; tx: number; tz: number }> = [
    { heading: 'n', tx: 0, tz: -2 },
    { heading: 'ne', tx: 2, tz: -2 },
    { heading: 'e', tx: 2, tz: 0 },
    { heading: 'se', tx: 2, tz: 2 },
    { heading: 's', tx: 0, tz: 2 },
    { heading: 'sw', tx: -2, tz: 2 },
    { heading: 'w', tx: -2, tz: 0 },
    { heading: 'nw', tx: -2, tz: -2 }
  ];

  for (const c of cases) {
    const result = await executor({ heading: c.heading, distance: 2 });
    t.falsy(result.isError, `${c.heading} should succeed`);
    const goal = (mockBot.pathfinder!.goto as sinon.SinonStub).lastCall.args[0];
    t.is(goal.x, c.tx, `${c.heading} x`);
    t.is(goal.z, c.tz, `${c.heading} z`);
  }
});

test('save-location stores a named waypoint', async (t) => {
  const { toolCalls } = setup({});
  const executor = executorFor(toolCalls, 'save-location');

  const result = await executor({ name: 'home', x: 100, y: 64, z: 200 });

  t.falsy(result.isError);
  t.true(result.content[0].text.includes('Saved home at (100, 64, 200)'));
});

test('list-locations returns saved waypoints', async (t) => {
  const { toolCalls } = setup({});
  const saveExecutor = executorFor(toolCalls, 'save-location');
  const listExecutor = executorFor(toolCalls, 'list-locations');

  await saveExecutor({ name: 'home', x: 100, y: 64, z: 200 });
  await saveExecutor({ name: 'base', x: -10, y: 0, z: 30 });

  const result = await listExecutor({});

  t.falsy(result.isError);
  t.true(result.content[0].text.includes('home: (100, 64, 200)'));
  t.true(result.content[0].text.includes('base: (-10, 0, 30)'));
});

test('goto-named moves to a saved waypoint', async (t) => {
  const mockBot = {
    pathfinder: {
      goto: sinon.stub().resolves(),
      stop: sinon.stub()
    },
    entity: {
      position: new Vec3(98, 63, 202)
    }
  } as unknown as Partial<mineflayer.Bot>;
  const { toolCalls } = setup(mockBot);
  const saveExecutor = executorFor(toolCalls, 'save-location');
  const gotoExecutor = executorFor(toolCalls, 'goto-named');

  await saveExecutor({ name: 'home', x: 100, y: 64, z: 200 });
  const result = await gotoExecutor({ name: 'home' });

  t.falsy(result.isError);
  t.true(result.content[0].text.includes('Moved to home at (100, 64, 200)'));
  t.true(result.content[0].text.includes('now at (98, 63, 202)'));
});

test('goto-named returns error for missing waypoint', async (t) => {
  const { toolCalls } = setup({});
  const gotoExecutor = executorFor(toolCalls, 'goto-named');

  const result = await gotoExecutor({ name: 'nowhere' });

  t.true(result.isError);
  t.true(result.content[0].text.includes('No saved location named nowhere'));
});

test('goto-entity follows a mock entity within range', async (t) => {
  const mockEntity = {
    name: 'zombie',
    type: 'mob',
    position: new Vec3(1, 64, 0)
  };
  const mockBot = {
    pathfinder: {
      setGoal: sinon.stub(),
      stop: sinon.stub()
    },
    entity: {
      position: new Vec3(0, 64, 0)
    },
    nearestEntity: sinon.stub().returns(mockEntity)
  } as unknown as mineflayer.Bot;
  const { toolCalls } = setup(mockBot);
  const executor = executorFor(toolCalls, 'goto-entity');

  const result = await executor({ entityType: 'zombie' });

  t.falsy(result.isError);
  t.true(result.content[0].text.includes('Following zombie'));
  t.true(result.content[0].text.includes('now at (0, 64, 0)'));
  t.true(result.content[0].text.includes('target at (1, 64, 0)'));
  t.true((mockBot.pathfinder.setGoal as sinon.SinonStub).calledOnce);
  t.true((mockBot.pathfinder.stop as sinon.SinonStub).notCalled);
});

test('goto-entity returns error when entity not found', async (t) => {
  const mockBot = {
    pathfinder: {
      setGoal: sinon.stub(),
      stop: sinon.stub()
    },
    entity: {
      position: new Vec3(0, 64, 0)
    },
    nearestEntity: sinon.stub().returns(null)
  } as unknown as mineflayer.Bot;
  const { toolCalls } = setup(mockBot);
  const executor = executorFor(toolCalls, 'goto-entity');

  const result = await executor({ entityType: 'ender_dragon' });

  t.true(result.isError);
  t.true(result.content[0].text.includes('No entity matching "ender_dragon" found'));
  t.true((mockBot.pathfinder.setGoal as sinon.SinonStub).notCalled);
});

test.serial('goto-entity times out when target never reached and stops pathfinder', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());

  const mockEntity = {
    name: 'zombie',
    type: 'mob',
    position: new Vec3(50, 64, 0)
  };
  const mockBot = {
    pathfinder: {
      setGoal: sinon.stub(),
      stop: sinon.stub()
    },
    entity: {
      position: new Vec3(0, 64, 0)
    },
    nearestEntity: sinon.stub().returns(mockEntity)
  } as unknown as mineflayer.Bot;
  const { toolCalls } = setup(mockBot);
  const executor = executorFor(toolCalls, 'goto-entity');

  const resultPromise = executor({ entityType: 'zombie', timeoutMs: 500 });
  await clock.tickAsync(200);
  await clock.tickAsync(200);
  await clock.tickAsync(200);
  const result = await resultPromise;

  t.true(result.isError);
  t.true(result.content[0].text.includes('Timed out following zombie after 500ms'));
  t.true((mockBot.pathfinder.stop as sinon.SinonStub).calledOnce);
});

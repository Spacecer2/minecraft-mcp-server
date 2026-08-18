import test from 'ava';
import sinon from 'sinon';
import { registerMotionTools } from '../src/tools/motion-tools.js';
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

  registerMotionTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  return { factory, toolCalls };
}

function executorFor(toolCalls: sinon.SinonSpyCall[], name: string) {
  const call = toolCalls.find(c => c.args[0] === name);
  return call!.args[3];
}

test('registerMotionTools registers find-safe-path, walk-path, wait, and until', (t) => {
  const { toolCalls } = setup({});
  const names = toolCalls.map(c => c.args[0]);
  for (const expected of ['find-safe-path', 'walk-path', 'wait', 'until']) {
    t.true(names.includes(expected), `expected ${expected} to be registered`);
  }
});

test('find-safe-path returns direct path message when no hazards', async (t) => {
  const mockBot = {
    entity: { position: new Vec3(0, 64, 0) },
    blockAt: sinon.stub().returns({ name: 'air' })
  } as unknown as Partial<mineflayer.Bot>;
  const { toolCalls } = setup(mockBot);
  const executor = executorFor(toolCalls, 'find-safe-path');

  const result = await executor({ x: 100, y: 64, z: 0 });

  t.falsy(result.isError);
  t.true(result.content[0].text.includes('Direct path is clear'));
});

test('find-safe-path returns waypoints when a hazard is detected', async (t) => {
  const mockBot = {
    entity: { position: new Vec3(0, 64, 0) },
    blockAt: sinon.stub().callsFake((pos: Vec3) => {
      if ((pos.x === 4 && pos.y === 63 && pos.z === 0) || (pos.x === 4 && pos.y === 64 && pos.z === 0)) {
        return { name: 'lava' };
      }
      return { name: 'air' };
    })
  } as unknown as Partial<mineflayer.Bot>;
  const { toolCalls } = setup(mockBot);
  const executor = executorFor(toolCalls, 'find-safe-path');

  const result = await executor({ x: 100, y: 64, z: 0, step: 4 });

  t.falsy(result.isError);
  t.true(result.content[0].text.includes('Safe path to (100, 64, 0)'));
  t.true(result.content[0].text.includes('waypoint'));
  t.true(result.content[0].text.includes('1. (8, 64, 0)'));
  t.true(result.content[0].text.includes('2. (8, 64, 4)'));
});

test('walk-path walks through all waypoints when goto resolves', async (t) => {
  const mockBot = {
    pathfinder: {
      goto: sinon.stub().resolves(),
      stop: sinon.stub()
    },
    entity: { position: new Vec3(10, 64, 10) }
  } as unknown as Partial<mineflayer.Bot>;
  const { toolCalls } = setup(mockBot);
  const executor = executorFor(toolCalls, 'walk-path');

  const result = await executor({ waypoints: [{ x: 1, y: 64, z: 2 }, { x: 5, y: 64, z: 6 }] });

  t.falsy(result.isError);
  t.true(result.content[0].text.includes('Walked 2/2 legs'));
  t.true(result.content[0].text.includes('now at (10, 64, 10)'));
  t.is((mockBot.pathfinder!.goto as sinon.SinonStub).callCount, 2);
  t.true((mockBot.pathfinder!.stop as sinon.SinonStub).notCalled);
});

test.serial('walk-path stops at a leg that times out', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());

  const mockBot = {
    pathfinder: {
      goto: sinon.stub().returns(new Promise(() => {})),
      stop: sinon.stub()
    },
    entity: { position: new Vec3(10, 64, 10) }
  } as unknown as Partial<mineflayer.Bot>;
  const { toolCalls } = setup(mockBot);
  const executor = executorFor(toolCalls, 'walk-path');

  const resultPromise = executor({ waypoints: [{ x: 1, y: 64, z: 2 }, { x: 5, y: 64, z: 6 }], timeoutMs: 1000 });
  await clock.tickAsync(1000);
  const result = await resultPromise;

  t.true(result.isError);
  t.true(result.content[0].text.includes('Stopped at leg 1 (timed out)'));
  t.true((mockBot.pathfinder!.stop as sinon.SinonStub).calledOnce);
});

test.serial('wait blocks for the requested seconds', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());

  const { toolCalls } = setup({});
  const executor = executorFor(toolCalls, 'wait');

  const resultPromise = executor({ seconds: 5 });
  await clock.tickAsync(5000);
  const result = await resultPromise;

  t.falsy(result.isError);
  t.true(result.content[0].text.includes('Waited 5s.'));
});

test.serial('wait clamps to maxSeconds', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());

  const { toolCalls } = setup({});
  const executor = executorFor(toolCalls, 'wait');

  const resultPromise = executor({ seconds: 100, maxSeconds: 10 });
  await clock.tickAsync(10000);
  const result = await resultPromise;

  t.falsy(result.isError);
  t.true(result.content[0].text.includes('Waited 10s.'));
});

test('until returns quickly when night condition is already met', async (t) => {
  const mockBot = {
    time: { timeOfDay: 15000 }
  } as unknown as Partial<mineflayer.Bot>;
  const { toolCalls } = setup(mockBot);
  const executor = executorFor(toolCalls, 'until');

  const result = await executor({ condition: 'night' });

  t.falsy(result.isError);
  t.true(result.content[0].text.includes("Condition 'night' met after"));
});

test('until returns quickly when hungry condition is already met', async (t) => {
  const mockBot = {
    food: 5
  } as unknown as Partial<mineflayer.Bot>;
  const { toolCalls } = setup(mockBot);
  const executor = executorFor(toolCalls, 'until');

  const result = await executor({ condition: 'hungry' });

  t.falsy(result.isError);
  t.true(result.content[0].text.includes("Condition 'hungry' met after"));
});

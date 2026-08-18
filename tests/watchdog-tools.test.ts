import test from 'ava';
import sinon from 'sinon';
import { registerWatchdogTools } from '../src/tools/watchdog-tools.js';
import { resetWatchdogToolsForTest } from '../src/tools/watchdog-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import { watchdog, resetWatchdogForTest } from '../src/watchdog.js';
import { isInterrupted, clearInterrupt, getInterruptReason } from '../src/interrupt.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import type mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';

type Executor = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;

function setupWithBot(mockBot: unknown): { mockServer: McpServer } {
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
  registerWatchdogTools(factory, getBot);
  return { mockServer };
}

function getToolExecutor(mockServer: McpServer, toolName: string): Executor {
  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const call = toolCalls.find((c) => c.args[0] === toolName);
  return call!.args[3] as Executor;
}

function makeBot(overrides: Record<string, unknown> = {}): mineflayer.Bot {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const base: Record<string, unknown> = {
    username: 'primary',
    entity: {
      id: 1,
      position: new Vec3(0, 64, 0),
      velocity: new Vec3(0, 0, 0),
      onGround: true,
      fireTicks: 0,
      flameTicks: 0,
      air: 300
    },
    health: 20,
    food: 20,
    saturation: 5,
    time: { timeOfDay: 6000 },
    isSleeping: false,
    inventory: { items: () => [] },
    chat: sinon.stub(),
    on: (event: string, handler: (...args: unknown[]) => void) => {
      handlers[event] = handler;
    },
    removeListener: (event: string) => {
      delete handlers[event];
    },
    emit: (event: string, ...args: unknown[]) => {
      if (handlers[event]) handlers[event](...args);
    }
  };
  return { ...base, ...overrides } as unknown as mineflayer.Bot;
}

test.beforeEach(() => {
  resetWatchdogForTest();
  resetWatchdogToolsForTest();
});

test.serial('registerWatchdogTools registers the watchdog tools', (t) => {
  const { mockServer } = setupWithBot(makeBot());
  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const names = toolCalls.map((c) => c.args[0]);
  for (const expected of [
    'watchdog-start', 'read-interrupt', 'watchdog-status',
    'watchdog-stop', 'watchdog-resume', 'set-mode', 'get-mode'
  ]) {
    t.true(names.includes(expected), `expected ${expected} to be registered`);
  }
});

test.serial('watchdog-start returns a started message and enables events', async (t) => {
  const clock = sinon.useFakeTimers();
  try {
    const { mockServer } = setupWithBot(makeBot());
    const start = getToolExecutor(mockServer, 'watchdog-start');
    const result = await start({ events: ['low-health', 'hunger'], intervalMs: 500 });

    t.true(result.content[0].text.includes('Watchdog started'));
    t.true(result.content[0].text.includes('low-health'));
    t.true(result.content[0].text.includes('hunger'));

    const status = watchdog.getWatchdogStatus();
    t.true(status.running);
    t.deepEqual([...status.enabledEvents].sort(), ['hunger', 'low-health']);
    t.is(watchdog.getMode(), 'idle');
  } finally {
    clock.restore();
    resetWatchdogForTest();
  }
});

test.serial('tick triggers on low-health when health is low', async (t) => {
  const clock = sinon.useFakeTimers();
  try {
    const { mockServer } = setupWithBot(makeBot({ health: 5 }));
    const start = getToolExecutor(mockServer, 'watchdog-start');
    await start({ events: ['low-health'] });

    watchdog.tick();

    t.true(isInterrupted());
    const reason = getInterruptReason() ?? '';
    t.true(reason.includes('low health'));
    t.is(watchdog.getMode(), 'defense');
    t.is(watchdog.triggerCount, 1);
    const status = watchdog.getWatchdogStatus();
    t.truthy(status.lastTrigger);
    t.is(status.lastTrigger!.event, 'low-health');
    t.is(status.lastTrigger!.message, reason);

    const read = getToolExecutor(mockServer, 'read-interrupt');
    const res = await read({});
    t.true(res.content[0].text.includes('low health'));
    t.is(res.content[0].text, reason);

    // read-interrupt consumes the directive but NOT the interrupt flag.
    const res2 = await read({});
    t.is(res2.content[0].text, 'No interrupt pending.');
    t.true(isInterrupted());
  } finally {
    clock.restore();
    resetWatchdogForTest();
  }
});

test.serial('tick does NOT trigger on low-health when health is high', async (t) => {
  const clock = sinon.useFakeTimers();
  try {
    const { mockServer } = setupWithBot(makeBot({ health: 20 }));
    const start = getToolExecutor(mockServer, 'watchdog-start');
    await start({ events: ['low-health'] });

    watchdog.tick();

    t.false(isInterrupted());
    t.is(watchdog.triggerCount, 0);
    t.is(watchdog.getMode(), 'idle');

    const read = getToolExecutor(mockServer, 'read-interrupt');
    const res = await read({});
    t.is(res.content[0].text, 'No interrupt pending.');
  } finally {
    clock.restore();
    resetWatchdogForTest();
  }
});

test.serial('tick triggers on hostile within distance and switches to defense', async (t) => {
  const clock = sinon.useFakeTimers();
  try {
    const bot = makeBot({
      entity: { id: 1, position: new Vec3(0, 64, 0) },
      entities: new Map<number, unknown>([
        [2, { id: 2, name: 'zombie', type: 'mob', position: new Vec3(3, 64, 0) }]
      ])
    });
    const { mockServer } = setupWithBot(bot);
    const start = getToolExecutor(mockServer, 'watchdog-start');
    await start({ events: ['hostile'] });

    watchdog.tick();

    t.true(isInterrupted());
    const reason = getInterruptReason() ?? '';
    t.true(reason.includes('hostiles within'));
    t.is(watchdog.getMode(), 'defense');
  } finally {
    clock.restore();
    resetWatchdogForTest();
  }
});

test.serial('tick triggers on creeper within 5 and switches to flee', async (t) => {
  const clock = sinon.useFakeTimers();
  try {
    const bot = makeBot({
      entity: { id: 1, position: new Vec3(0, 64, 0) },
      entities: new Map<number, unknown>([
        [2, { id: 2, name: 'creeper', type: 'mob', position: new Vec3(2, 64, 0) }]
      ])
    });
    const { mockServer } = setupWithBot(bot);
    const start = getToolExecutor(mockServer, 'watchdog-start');
    await start({ events: ['creeper'] });

    watchdog.tick();

    t.true(isInterrupted());
    const reason = getInterruptReason() ?? '';
    t.true(reason.includes('CREEPER within'));
    t.is(watchdog.getMode(), 'flee');
  } finally {
    clock.restore();
    resetWatchdogForTest();
  }
});

test.serial('watchdog-resume clears the interrupt and restores the prior mode', async (t) => {
  const clock = sinon.useFakeTimers();
  try {
    const { mockServer } = setupWithBot(makeBot({ health: 5 }));
    const start = getToolExecutor(mockServer, 'watchdog-start');
    await start({ events: ['low-health'] });

    watchdog.tick();
    t.true(isInterrupted());
    t.is(watchdog.getMode(), 'defense');

    const resume = getToolExecutor(mockServer, 'watchdog-resume');
    const res = await resume({});

    t.false(isInterrupted());
    t.is(watchdog.getMode(), 'idle');
    t.is(watchdog.prevMode, null);
    t.true(res.content[0].text.includes('Watchdog resumed'));
    t.true(res.content[0].text.includes('idle'));
  } finally {
    clock.restore();
    resetWatchdogForTest();
  }
});

test.serial('watchdog-stop stops the watchdog so tick no longer triggers', async (t) => {
  const clock = sinon.useFakeTimers();
  try {
    const { mockServer } = setupWithBot(makeBot({ health: 5 }));
    const start = getToolExecutor(mockServer, 'watchdog-start');
    await start({ events: ['low-health'] });

    const stop = getToolExecutor(mockServer, 'watchdog-stop');
    await stop({});

    t.false(watchdog.getWatchdogStatus().running);
    t.is(watchdog.timer, null);

    clearInterrupt();
    watchdog.tick();
    t.false(isInterrupted());
    t.is(watchdog.triggerCount, 0);
  } finally {
    clock.restore();
    resetWatchdogForTest();
  }
});

test.serial('set-mode and get-mode round-trip', async (t) => {
  const { mockServer } = setupWithBot(makeBot());
  const setMode = getToolExecutor(mockServer, 'set-mode');
  const getMode = getToolExecutor(mockServer, 'get-mode');

  const setRes = await setMode({ mode: 'defense' });
  t.true(setRes.content[0].text.includes('defense'));
  t.is(watchdog.getMode(), 'defense');

  const getRes = await getMode({});
  t.is(getRes.content[0].text, 'Mode: defense.');
});

test.serial('watchdog-status reports state and last trigger', async (t) => {
  const clock = sinon.useFakeTimers();
  try {
    const { mockServer } = setupWithBot(makeBot({ health: 5 }));
    const start = getToolExecutor(mockServer, 'watchdog-start');
    await start({ events: ['low-health'] });
    watchdog.tick();

    const status = getToolExecutor(mockServer, 'watchdog-status');
    const res = await status({});
    const text = res.content[0].text;

    t.true(text.includes('Watchdog: running'));
    t.true(text.includes('low-health'));
    t.true(text.includes('trigger #1'));
  } finally {
    clock.restore();
    resetWatchdogForTest();
  }
});

test.serial('chat event: a player message triggers an interrupt and switches to listen mode', async (t) => {
  const clock = sinon.useFakeTimers();
  try {
    const bot = makeBot();
    const { mockServer } = setupWithBot(bot);
    const start = getToolExecutor(mockServer, 'watchdog-start');
    await start({ events: ['chat'] });

    // Simulate a player writing in chat (background listener fires).
    (bot as unknown as { emit: (e: string, ...a: unknown[]) => void }).emit('chat', 'Spacecer2', 'come to my house');

    t.true(isInterrupted());
    const reason = getInterruptReason() ?? '';
    t.true(reason.includes('PLAYER COMMAND from Spacecer2'));
    t.true(reason.includes('come to my house'));
    t.is(watchdog.getMode(), 'listen');
    t.is(watchdog.triggerCount, 1);
    t.is(watchdog.lastTrigger!.event, 'chat');

    const read = getToolExecutor(mockServer, 'read-interrupt');
    const res = await read({});
    t.true(res.content[0].text.includes('PLAYER COMMAND from Spacecer2'));
  } finally {
    clock.restore();
    resetWatchdogForTest();
  }
});

test.serial('chat event: the bot\'s own chat does NOT trigger an interrupt', async (t) => {
  const clock = sinon.useFakeTimers();
  try {
    const bot = makeBot();
    const { mockServer } = setupWithBot(bot);
    const start = getToolExecutor(mockServer, 'watchdog-start');
    await start({ events: ['chat'] });

    // The bot's own username ('primary') broadcasting should be ignored.
    (bot as unknown as { emit: (e: string, ...a: unknown[]) => void }).emit('chat', 'primary', 'LLM-powered bot ready');

    t.false(isInterrupted());
    t.is(watchdog.triggerCount, 0);
    t.is(watchdog.getMode(), 'idle');
  } finally {
    clock.restore();
    resetWatchdogForTest();
  }
});

test.serial('chat event does not fire when chat is not enabled', async (t) => {
  const clock = sinon.useFakeTimers();
  try {
    const bot = makeBot();
    const { mockServer } = setupWithBot(bot);
    const start = getToolExecutor(mockServer, 'watchdog-start');
    await start({ events: ['low-health'] }); // chat NOT enabled

    (bot as unknown as { emit: (e: string, ...a: unknown[]) => void }).emit('chat', 'Spacecer2', 'hello');

    t.false(isInterrupted());
    t.is(watchdog.triggerCount, 0);
  } finally {
    clock.restore();
    resetWatchdogForTest();
  }
});

test.serial('watchdog-listen enables background chat listening and switches to listen mode', async (t) => {
  const bot = makeBot();
  const { mockServer } = setupWithBot(bot);
  const listen = getToolExecutor(mockServer, 'watchdog-listen');
  const res = await listen({});

  t.true(res.content[0].text.includes('listening for player chat'));
  t.is(watchdog.getMode(), 'listen');
  t.true(watchdog.enabledEvents.has('chat'));

  // A subsequent player message now interrupts.
  (bot as unknown as { emit: (e: string, ...a: unknown[]) => void }).emit('chat', 'Spacecer2', 'stop building');
  t.true(isInterrupted());
  const reason = getInterruptReason() ?? '';
  t.true(reason.includes('stop building'));
});

test.serial('listen tool reports background listening is active', async (t) => {
  const bot = makeBot();
  const { mockServer } = setupWithBot(bot);
  const listen = getToolExecutor(mockServer, 'listen');
  const res = await listen({});

  t.true(res.content[0].text.includes('Listening for player chat'));
  t.is(watchdog.getMode(), 'listen');
});

test.serial('death event: emitting death triggers an interrupt in dead mode', async (t) => {
  const clock = sinon.useFakeTimers();
  try {
    const bot = makeBot();
    const { mockServer } = setupWithBot(bot);
    const start = getToolExecutor(mockServer, 'watchdog-start');
    await start({ events: ['low-health'] });
    // 'death' is event-driven-only and not exposed in the tool's events enum,
    // so enable it on the watchdog directly.
    watchdog.enableEvent('death');

    (bot as unknown as { emit: (e: string, ...a: unknown[]) => void }).emit('death');

    t.true(isInterrupted());
    const reason = getInterruptReason() ?? '';
    t.true(reason.includes('DIED'));
    t.is(watchdog.getMode(), 'dead');
    t.is(watchdog.triggerCount, 1);
    t.is(watchdog.lastTrigger!.event, 'death');

    const read = getToolExecutor(mockServer, 'read-interrupt');
    const res = await read({});
    t.true(res.content[0].text.includes('DIED'));
  } finally {
    clock.restore();
    resetWatchdogForTest();
  }
});

test.serial('health event: bot.health below 6 triggers low-health instantly', async (t) => {
  const clock = sinon.useFakeTimers();
  try {
    const bot = makeBot({ health: 5 });
    const { mockServer } = setupWithBot(bot);
    const start = getToolExecutor(mockServer, 'watchdog-start');
    await start({ events: ['low-health'] });

    (bot as unknown as { emit: (e: string, ...a: unknown[]) => void }).emit('health');

    t.true(isInterrupted());
    const reason = getInterruptReason() ?? '';
    t.true(reason.includes('low health'));
    t.is(watchdog.getMode(), 'defense');
    t.is(watchdog.triggerCount, 1);
    t.is(watchdog.lastTrigger!.event, 'low-health');
  } finally {
    clock.restore();
    resetWatchdogForTest();
  }
});

test.serial('death event does not trigger when death is not enabled', async (t) => {
  const clock = sinon.useFakeTimers();
  try {
    const bot = makeBot();
    const { mockServer } = setupWithBot(bot);
    const start = getToolExecutor(mockServer, 'watchdog-start');
    await start({ events: ['low-health'] }); // death NOT enabled

    (bot as unknown as { emit: (e: string, ...a: unknown[]) => void }).emit('death');

    t.false(isInterrupted());
    t.is(watchdog.triggerCount, 0);
    t.is(watchdog.getMode(), 'idle');
  } finally {
    clock.restore();
    resetWatchdogForTest();
  }
});

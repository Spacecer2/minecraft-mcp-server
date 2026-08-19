import test from 'ava';
import sinon from 'sinon';
import { Vec3 } from 'vec3';
import { watchdog, resetWatchdogForTest, recordBotDeath } from '../src/watchdog.js';
import { clearInterrupt, isInterrupted } from '../src/interrupt.js';
import {
  deathRegister,
  statistics,
  riskAt,
  resetDeathRegisterForTest
} from '../src/death-register.js';
import type mineflayer from 'mineflayer';

// ava's beforeEach hook does not fire under this tsx/esm setup, so each test
// resets the shared module-level register/watchdog state explicitly.

function makeBot(overrides: Record<string, unknown> = {}): mineflayer.Bot {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const base: Record<string, unknown> = {
    username: 'primary',
    entity: {
      id: 1,
      position: new Vec3(10, 64, -5),
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
    respawn: sinon.stub().resolves(),
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

test('recordBotDeath records a death from live bot state into the register', (t) => {
  resetDeathRegisterForTest();
  resetWatchdogForTest();
  watchdog.setMode('caving');

  const bot = makeBot({ health: 4, entity: { id: 1, position: new Vec3(10, 64, -5) } });
  const entry = recordBotDeath(bot);

  t.truthy(entry);
  t.is(entry!.location, '(10, 64, -5)');
  t.is(entry!.hpAtDeath, 4);
  t.is(entry!.action, 'caving');
  t.is(entry!.cause, 'unknown');

  t.is(deathRegister.count(), 1);
  const s = statistics();
  t.is(s.count, 1);
  t.true(s.locations.includes('(10, 64, -5)'));
  t.is(s.causes.unknown, 1);
  t.is(riskAt('(10, 64, -5)'), 0.25);
});

test('recordBotDeath infers cause from terminal state', (t) => {
  resetDeathRegisterForTest();
  resetWatchdogForTest();

  const voidBot = makeBot({ entity: { id: 1, position: new Vec3(10, -70, -5) } });
  t.is(recordBotDeath(voidBot)!.cause, 'void');

  const fireBot = makeBot({ entity: { id: 1, position: new Vec3(10, 64, -5), fireTicks: 20 } });
  t.is(recordBotDeath(fireBot)!.cause, 'fire');

  const hostileBot = makeBot({
    entity: { id: 1, position: new Vec3(10, 64, -5) },
    entities: {
      zombie1: { id: 99, name: 'zombie', position: new Vec3(12, 64, -5) }
    }
  });
  const hostileEntry = recordBotDeath(hostileBot)!;
  t.is(hostileEntry.cause, 'hostile');
  t.is(hostileEntry.nearbyThreats, 1);

  const creeperBot = makeBot({
    entity: { id: 1, position: new Vec3(10, 64, -5) },
    entities: {
      creeper1: { id: 98, name: 'creeper', position: new Vec3(12, 64, -5) }
    }
  });
  t.is(recordBotDeath(creeperBot)!.cause, 'creeper');
});

test('watchdog death handler records the death and still respawns', (t) => {
  resetDeathRegisterForTest();
  resetWatchdogForTest();
  clearInterrupt();

  const respawn = sinon.stub().resolves();
  const bot = makeBot({ health: 3, respawn });
  watchdog.setBot(bot);
  watchdog.setMode('mining');
  watchdog.enableEvent('death');
  watchdog.running = true;

  (bot as unknown as { emit: (event: string) => void }).emit('death');

  t.true(isInterrupted(), 'death still preempts the agent');
  t.is(watchdog.triggerCount, 1);
  t.is(watchdog.getMode(), 'dead');
  t.true(respawn.calledOnce, 'defensive respawn still runs');

  t.is(deathRegister.count(), 1, 'death was recorded');
  const entry = deathRegister.get()[0];
  t.is(entry!.action, 'mining', 'records the mode the bot was in at death');
  t.is(riskAt('(10, 64, -5)'), 0.25);
});

test('recordBotDeath is defensive on unknown/failing state (no throw)', (t) => {
  resetDeathRegisterForTest();
  resetWatchdogForTest();

  t.is(recordBotDeath(null), null);
  t.is(recordBotDeath(undefined), null);

  // A bot with no entity/position still records with safe defaults, no throw.
  const entry = recordBotDeath({ health: 20 } as unknown as mineflayer.Bot);
  t.truthy(entry);
  t.is(entry!.location, 'unknown');
  t.is(entry!.cause, 'unknown');
  t.is(entry!.hpAtDeath, 20);
  t.is(entry!.nearbyThreats, 0);
  t.is(deathRegister.count(), 1);
});

test('death handler survives a failing persist (fire-and-forget)', (t) => {
  resetDeathRegisterForTest();
  resetWatchdogForTest();
  clearInterrupt();

  const respawn = sinon.stub().resolves();
  const bot = makeBot({
    health: 0,
    respawn,
    remember: async () => {
      throw new Error('persist boom');
    }
  });
  watchdog.setBot(bot);
  watchdog.enableEvent('death');
  watchdog.running = true;

  t.notThrows(() => {
    (bot as unknown as { emit: (event: string) => void }).emit('death');
  });

  t.true(respawn.calledOnce, 'respawn unaffected by persist failure');
  t.is(deathRegister.count(), 1, 'death still recorded');
  t.true(isInterrupted());
});
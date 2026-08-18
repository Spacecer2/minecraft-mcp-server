import test from 'ava';
import {
  setArousalSensor,
  startPrimalLoop,
  stopPrimalLoop,
  resetPrimalBrainForTest,
  primalLoopRunning,
  getLastPrimalDirective
} from '../src/primal-brain.js';
import { arousal, senseAnxiety } from '../src/arousal.js';

/**
 * Verifies the host-side wiring added in src/main.ts:
 *   (a) setArousalSensor( senseAnxiety -> arousal.setAnxiety ) connects the
 *       arousal module to the primal brain's eternal loop, and
 *   (b) startPrimalLoop() for a real (non-fake) bot starts the eternal loop and
 *       feeds anxiety from the sensed danger without crashing.
 *
 * These tests run the actual loop (not a mock), using a minimal fake bot whose
 * sensors `readPrimalSensors` can read. resetPrimalBrainForTest() tears the
 * loop down between tests so no eternal loop leaks across the suite.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Minimal bot shape readPrimalSensors() can handle (no dangerous sensors). */
function makeBot(overrides: Record<string, unknown> = {}): unknown {
  const base: Record<string, unknown> = {
    health: 20,
    oxygenLevel: 20,
    entity: { id: 1, position: { x: 0, y: 64, z: 0 }, fireTicks: 0, flameTicks: 0 },
    entities: new Map()
  };
  return { ...base, ...overrides };
}

/** The exact sensor wiring main.ts uses. */
function wireArousalSensor(): void {
  setArousalSensor((input) => {
    const anxiety = senseAnxiety(input);
    arousal.setAnxiety(anxiety);
    return anxiety;
  });
}

test.beforeEach(() => {
  resetPrimalBrainForTest();
  wireArousalSensor();
  arousal.reset();
});

test.afterEach(() => {
  resetPrimalBrainForTest();
  arousal.reset();
  setArousalSensor(null);
});

test.serial('primal loop starts for a connected (real) bot and runs without crashing', async (t) => {
  const bot = makeBot();
  startPrimalLoop(bot, 10);

  const deadline = Date.now() + 1000;
  while (!primalLoopRunning() && Date.now() < deadline) {
    await sleep(10);
  }

  t.true(primalLoopRunning(), 'primal loop should be running after start');
  // Safe bot -> no directive, anxiety stays 0.
  t.is(arousal.get().anxiety, 0);
  t.is(getLastPrimalDirective(), null);
  stopPrimalLoop();
});

test.serial('arousal sensor raises anxiety when the bot senses danger', async (t) => {
  // Low health (< 6) triggers the low-health safety directive and raises anxiety.
  const bot = makeBot({ health: 5 });
  arousal.setAnxiety(0);
  startPrimalLoop(bot, 10);

  const deadline = Date.now() + 1500;
  while (arousal.get().anxiety === 0 && Date.now() < deadline) {
    await sleep(20);
  }

  t.true(arousal.get().anxiety > 0, 'anxiety should rise when the bot senses danger');
  t.truthy(getLastPrimalDirective(), 'a danger directive should be issued');
  stopPrimalLoop();
});

test.serial('startPrimalLoop is a no-op for a null/absent bot (no crash)', (t) => {
  t.notThrows(() => startPrimalLoop(null, 10));
  t.false(primalLoopRunning());
});

test.serial('starting the loop for a safe bot keeps anxiety low even while running', async (t) => {
  const bot = makeBot({ health: 20, entity: { id: 2, position: { x: 1, y: 80, z: 2 } } });
  startPrimalLoop(bot, 10);

  const deadline = Date.now() + 800;
  while (!primalLoopRunning() && Date.now() < deadline) {
    await sleep(10);
  }
  await sleep(120);

  t.true(primalLoopRunning());
  t.is(arousal.get().anxiety, 0);
  stopPrimalLoop();
});

import test from 'ava';
import sinon from 'sinon';
import { Vec3 } from 'vec3';
import { watchdog, resetWatchdogForTest, PRIORITY_BY_EVENT } from '../src/watchdog.js';
import {
  setInterrupt,
  clearInterrupt,
  isInterrupted,
  getInterruptReason,
  getInterruptPriority,
  interruptSuppressed,
  canPreempt,
  InterruptPriority
} from '../src/interrupt.js';
import type mineflayer from 'mineflayer';

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
  clearInterrupt();
});

test.serial('interrupt priority: a higher-priority interrupt overwrites a pending one', (t) => {
  setInterrupt('night directive', InterruptPriority.P3);
  t.true(isInterrupted());
  t.is(getInterruptReason(), 'night directive');
  t.is(getInterruptPriority(), InterruptPriority.P3);

  // Same priority → suppressed, reason untouched.
  t.true(setInterrupt('same directive', InterruptPriority.P3));
  t.is(getInterruptReason(), 'night directive');

  // Lower priority → suppressed, reason untouched.
  t.true(setInterrupt('planning directive', InterruptPriority.P4));
  t.is(getInterruptReason(), 'night directive');
  t.is(getInterruptPriority(), InterruptPriority.P3);

  // Higher priority → overwrites reason and priority.
  t.true(setInterrupt('creeper directive', InterruptPriority.P1));
  t.is(getInterruptReason(), 'creeper directive');
  t.is(getInterruptPriority(), InterruptPriority.P1);

  clearInterrupt();
  t.false(isInterrupted());
  t.is(getInterruptPriority(), null);
});

test.serial('interrupt priority: setInterrupt returns false only when it newly sets', (t) => {
  clearInterrupt();
  t.false(setInterrupt('first', InterruptPriority.P2));
  t.true(isInterrupted());
  t.true(setInterrupt('second', InterruptPriority.P2));
  t.is(getInterruptReason(), 'first');
});

test.serial('interrupt priority: interruptSuppressed and canPreempt helpers', (t) => {
  clearInterrupt();
  t.false(interruptSuppressed(InterruptPriority.P1));
  t.true(canPreempt(InterruptPriority.P0));

  setInterrupt('base', InterruptPriority.P3);
  t.true(interruptSuppressed(InterruptPriority.P3)); // same → suppressed
  t.true(interruptSuppressed(InterruptPriority.P4)); // lower → suppressed
  t.false(interruptSuppressed(InterruptPriority.P1)); // higher → not suppressed
  t.false(canPreempt(InterruptPriority.P3)); // same → blocked
  t.true(canPreempt(InterruptPriority.P1)); // higher → allowed
});

test.serial('priority mapping: reflexes/survival/chat are P1, goal-policy is P3', (t) => {
  for (const event of ['death', 'void', 'lava', 'drowning', 'on-fire', 'creeper', 'fall', 'hostile', 'low-health', 'hunger', 'chat']) {
    t.is(PRIORITY_BY_EVENT[event], InterruptPriority.P1, `${event} should be P1`);
  }
  t.is(PRIORITY_BY_EVENT['night'], InterruptPriority.P3);
  t.is(PRIORITY_BY_EVENT['inventory-full'], InterruptPriority.P3);
});

test.serial('cooldown: the same event is not re-fired within the cooldown window', (t) => {
  const clock = sinon.useFakeTimers();
  try {
    const bot = makeBot({ health: 5 });
    watchdog.setBot(bot);
    watchdog.enableEvent('low-health');
    watchdog.setCooldownMs(5000);
    watchdog.running = true;

    watchdog.tick();
    t.is(watchdog.triggerCount, 1);
    t.true(isInterrupted());

    clearInterrupt();
    watchdog.tick();
    t.is(watchdog.triggerCount, 1, 'same event suppressed within cooldown');
    t.false(isInterrupted());

    clock.tick(5000);
    clearInterrupt();
    watchdog.tick();
    t.is(watchdog.triggerCount, 2, 'same event fires again after cooldown');
    t.true(isInterrupted());
  } finally {
    clock.restore();
    resetWatchdogForTest();
  }
});

test.serial('cooldown: different events are not blocked by each other', (t) => {
  const clock = sinon.useFakeTimers();
  try {
    const bot = makeBot({ health: 5 });
    watchdog.setBot(bot);
    watchdog.enableEvent('low-health');
    watchdog.setCooldownMs(10000);
    watchdog.running = true;

    watchdog.tick(); // low-health fires
    t.is(watchdog.triggerCount, 1);

    clearInterrupt();
    watchdog.trigger('chat', 'PLAYER COMMAND from X: hello');
    t.is(watchdog.triggerCount, 2, 'chat is a different event and is not cooldown-blocked');
  } finally {
    clock.restore();
    resetWatchdogForTest();
  }
});

test.serial('min-commitment: a lower-priority interrupt is suppressed until commitment elapses', (t) => {
  const clock = sinon.useFakeTimers();
  try {
    const bot = makeBot({ time: { timeOfDay: 18000 } }); // night (P3)
    watchdog.setBot(bot);
    watchdog.enableEvent('night');
    watchdog.running = true;
    watchdog.noteCommitment(10000, InterruptPriority.P2); // action committed at P2

    watchdog.tick();
    t.is(watchdog.triggerCount, 0, 'P3 suppressed while P2 commitment active');
    t.false(isInterrupted());

    clock.tick(10000);
    watchdog.tick();
    t.is(watchdog.triggerCount, 1, 'fires once commitment elapses');
    t.true(isInterrupted());
  } finally {
    clock.restore();
    resetWatchdogForTest();
  }
});

test.serial('min-commitment: P1 safety/reflex interrupts always preempt a committed action', (t) => {
  const clock = sinon.useFakeTimers();
  try {
    const bot = makeBot({ health: 5 });
    watchdog.setBot(bot);
    watchdog.enableEvent('low-health');
    watchdog.running = true;
    watchdog.noteCommitment(60000, InterruptPriority.P2); // long commitment

    watchdog.tick();
    t.is(watchdog.triggerCount, 1, 'P1 low-health preempts despite P2 commitment');
    t.true(isInterrupted());
    t.is(getInterruptReason()?.includes('low health'), true);
  } finally {
    clock.restore();
    resetWatchdogForTest();
  }
});

test.serial('hysteresis: the condition must persist N consecutive ticks before firing', (t) => {
  const bot = makeBot({ health: 5 });
  watchdog.setBot(bot);
  watchdog.enableEvent('low-health');
  watchdog.setHysteresis(3, 'low-health');
  watchdog.running = true;

  watchdog.tick();
  t.is(watchdog.triggerCount, 0);
  watchdog.tick();
  t.is(watchdog.triggerCount, 0);
  watchdog.tick();
  t.is(watchdog.triggerCount, 1, 'fires on the Nth consecutive tick');
  t.true(isInterrupted());
});

test.serial('hysteresis: an intermittent condition resets the consecutive-tick counter', (t) => {
  const bot = makeBot();
  const health = bot as unknown as { health: number };
  watchdog.setBot(bot);
  watchdog.enableEvent('low-health');
  watchdog.setHysteresis(3, 'low-health');
  watchdog.running = true;

  health.health = 5;
  watchdog.tick(); // true (1)
  health.health = 20;
  watchdog.tick(); // false → reset
  health.health = 5;
  watchdog.tick(); // true (1)
  health.health = 5;
  watchdog.tick(); // true (2)
  t.is(watchdog.triggerCount, 0, 'counter was reset by the healthy tick');

  health.health = 5;
  watchdog.tick(); // true (3) → fires
  t.is(watchdog.triggerCount, 1);
  t.true(isInterrupted());
});

test.serial('hysteresis: default of 1 preserves immediate-fire behavior', (t) => {
  const bot = makeBot({ health: 5 });
  watchdog.setBot(bot);
  watchdog.enableEvent('low-health');
  watchdog.running = true;

  watchdog.tick();
  t.is(watchdog.triggerCount, 1);
  t.true(isInterrupted());
});

test.serial('aggregation: recentTriggers keeps a bounded rolling window and updates lastTrigger', (t) => {
  const clock = sinon.useFakeTimers();
  try {
    watchdog.running = true;
    for (let i = 0; i < 25; i++) {
      watchdog.trigger('hostile', `hostile #${i}`);
      clearInterrupt();
    }
    t.is(watchdog.recentTriggers.length, watchdog.maxRecentTriggers);
    t.is(watchdog.recentTriggers[0].message, 'hostile #5', 'oldest entry dropped');
    t.is(watchdog.recentTriggers[watchdog.recentTriggers.length - 1].message, 'hostile #24');
    t.is(watchdog.lastTrigger!.message, 'hostile #24', 'single lastTrigger field preserved');
    t.is(watchdog.getRecentTriggers().length, watchdog.maxRecentTriggers);
  } finally {
    clock.restore();
    resetWatchdogForTest();
  }
});

test.serial('goal disposition: death marks the goal invalid, most events stay resumable', (t) => {
  watchdog.running = true;
  watchdog.trigger('night', 'night directive');
  t.is(watchdog.goalDisposition, 'resumable');
  t.is(watchdog.getGoalDisposition(), 'resumable');

  watchdog.trigger('death', 'DIED');
  t.is(watchdog.getGoalDisposition(), 'invalid');

  watchdog.trigger('reorient', 'FORCED MOVE');
  t.is(watchdog.getGoalDisposition(), 'invalid');
});

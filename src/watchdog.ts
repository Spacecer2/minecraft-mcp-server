/**
 * EVENT-DRIVEN PREEMPTION WATCHDOG
 *
 * A background safety state machine that scans the bot for impending events
 * (hostiles, creepers, falls, void, lava, low health, hunger, fire, night,
 * drowning, full inventory) and, when one fires:
 *
 *   1. increments the trigger counter and records the trigger
 *   2. switches `mode` to an event-specific mode (saving `prevMode`)
 *   3. sets the shared cooperative interrupt (src/interrupt.ts) with a
 *      directive that says CANCEL + how to respond
 *   4. notifies a `listener` (installed by the watchdog tools) so the
 *      directive can be injected into the LLM's message channel
 *
 * Cancellation is cooperative: long-running tools call `checkInterrupt()`
 * between steps and bail with an `[INTERRUPTED]` response. `tick()` is public
 * so tests (and the interval timer) can drive it directly.
 */

import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import {
  setInterrupt,
  clearInterrupt,
  canPreempt,
  InterruptPriority
} from './interrupt.js';
import { isHostileEntity, iterateEntities, distanceToEntity } from './tools/entity-tools.js';
import { startPrimalLoop, stopPrimalLoop } from './primal-brain.js';

export const EVENT_NAMES = [
  'hostile', 'creeper', 'fall', 'void', 'lava', 'low-health', 'hunger',
  'on-fire', 'night', 'drowning', 'inventory-full', 'chat'
] as const;

export type WatchdogEvent = (typeof EVENT_NAMES)[number];

/**
 * Events that are triggered purely by mineflayer listeners, NOT the polled
 * tick loop. `death` and `reorient` have no polled equivalent — they only fire
 * when their bot event fires. `chat` is handled by the background chat
 * listener. Each handler guards on `enabledEvents`, so these events only
 * preempt when explicitly enabled.
 */
export const EVENT_DRIVEN_EVENT_NAMES = ['death', 'reorient', 'chat'] as const;

/** Events are evaluated in this priority order; the first that fires wins this tick. */
const EVENT_PRIORITY: WatchdogEvent[] = [
  'void', 'on-fire', 'creeper', 'fall', 'drowning', 'lava', 'hostile',
  'low-health', 'hunger', 'night', 'inventory-full'
];

/**
 * Event-driven (non-polled) events. `chat` is handled by a background listener
 * attached to the bot's 'chat' event, NOT by the polled tick loop — so a player
 * writing in chat interrupts instantly, in parallel with the agent's actions.
 */

/** The mode the watchdog switches to when each event fires. */
const EVENT_MODES: Record<string, string> = {
  hostile: 'defense',
  creeper: 'flee',
  fall: 'falling',
  void: 'escape',
  lava: 'lava-avoid',
  'low-health': 'defense',
  hunger: 'eat',
  'on-fire': 'fire-emergency',
  night: 'sleep',
  drowning: 'surface',
  'inventory-full': 'inventory',
  chat: 'listen',
  death: 'dead',
  reorient: 'reorient'
};

/**
 * Interrupt priority per event. Reflex/survival events (death, void, lava,
 * drowning, on-fire, creeper, fall, hostile, low-health, hunger) and player
 * chat are P1; goal-policy events (night, inventory-full) are P3. Unknown
 * events default to P1 so an unclassified trigger still preempts.
 */
export const PRIORITY_BY_EVENT: Record<string, InterruptPriority> = {
  death: InterruptPriority.P1,
  void: InterruptPriority.P1,
  lava: InterruptPriority.P1,
  drowning: InterruptPriority.P1,
  'on-fire': InterruptPriority.P1,
  creeper: InterruptPriority.P1,
  fall: InterruptPriority.P1,
  hostile: InterruptPriority.P1,
  'low-health': InterruptPriority.P1,
  hunger: InterruptPriority.P1,
  reorient: InterruptPriority.P1,
  chat: InterruptPriority.P1,
  night: InterruptPriority.P3,
  'inventory-full': InterruptPriority.P3
};

/**
 * Whether the interrupted goal should be discarded or may be resumed after the
 * interrupt. Defaults to 'resumable'; events that permanently invalidate the
 * current plan (death, forced reorientation) mark it 'invalid'.
 */
const DISPOSITION_BY_EVENT: Record<string, 'resumable' | 'invalid'> = {
  death: 'invalid',
  reorient: 'invalid'
};

export type GoalDisposition = 'resumable' | 'invalid';

type Entity = ReturnType<Bot['nearestEntity']>;

export interface WatchdogListener {
  (directive: string, event: string): void;
}

export interface WatchdogTrigger {
  event: string;
  at: number;
  message: string;
}

export interface WatchdogStatus {
  running: boolean;
  mode: string;
  enabledEvents: string[];
  lastTrigger: WatchdogTrigger | null;
  triggerCount: number;
  /** Cooldown (ms) suppressing re-fires of the SAME event (0 = disabled). */
  cooldownMs?: number;
  /** Rolling window of recent triggers (oldest first, bounded). */
  recentTriggers?: WatchdogTrigger[];
  /** How the interrupted goal should be treated after this interrupt. */
  goalDisposition?: GoalDisposition;
}

export interface WatchdogStartOptions {
  events?: string[];
  intervalMs?: number;
  thresholds?: Record<string, number>;
}

export class Watchdog {
  running = false;
  mode = 'idle';
  prevMode: string | null = null;
  intervalMs = 500;
  lastTrigger: WatchdogTrigger | null = null;
  triggerCount = 0;
  timer: ReturnType<typeof setInterval> | null = null;
  enabledEvents: Set<string> = new Set();
  thresholds: Record<string, number> = {};
  listener: WatchdogListener | null = null;
  /** Timestamp of the last time each event fired (cooldown bookkeeping). */
  lastTriggerAt: Record<string, number> = {};
  /** Per-event cooldown (ms) suppressing re-fires of the same event (0 = off). */
  cooldownMs = 0;
  /** Consecutive ticks each polled event has been true (hysteresis). */
  pendingTickCount: Record<string, number> = {};
  /** Rolling window of recent triggers (bounded, oldest first). */
  recentTriggers: WatchdogTrigger[] = [];
  /** Max entries retained in recentTriggers. */
  maxRecentTriggers = 20;
  /** How the interrupted goal should be treated (resumable by default). */
  goalDisposition: GoalDisposition = 'resumable';
  /** Timestamp until which the current action is committed (min-commitment). */
  commitmentUntil: number | null = null;
  /** Priority of the committed action (min-commitment floor). */
  committedPriority: InterruptPriority | null = null;
  private bot: Bot | null = null;
  /** Bound background chat handler (player -> interrupt). */
  private chatHandler: ((username: string, message: string) => void) | null = null;
  /** Whether the background chat listener is attached. */
  private chatListening = false;
  /** Bound mineflayer event handlers (event -> interrupt). */
  private eventHandler: Record<string, (...args: unknown[]) => void> | null = null;
  /** Whether the event-driven listeners are attached. */
  private eventListening = false;

  setBot(bot: Bot): void {
    // Re-attach listeners that were active on the previous bot.
    const wasListening = this.chatListening;
    const wasEventListening = this.eventListening;
    this.bot = bot;
    if (wasListening) this.attachChatListener();
    if (wasEventListening) this.attachEventListeners();
  }

  /**
   * Start the eternal PRIMAL SAFETY LOOP for the current bot. This is the
   * deepest safety layer: it runs continuously in the background, senses danger
   * from the bot's own sensors, and issues P0 directives that CANCEL any goal /
   * tool / LLM action, then runs low-level safety micro-tasks itself.
   *
   * Deliberately NOT auto-started from setBot()/startWatchdog(): the watchdog
   * remains a pure preemption state machine (its trigger/tick semantics and all
   * existing tests are untouched). The host (main.ts / bot-connection) or a
   * tool calls this to bring the eternal loop online for a real bot. It is a
   * no-op if no bot is set.
   */
  startPrimalLoopForBot(cadenceMs = 500): void {
    if (!this.bot) return;
    startPrimalLoop(this.bot, cadenceMs);
  }

  /** Stop the eternal primal loop (no-op if it is not running). */
  stopPrimalLoop(): void {
    stopPrimalLoop();
  }

  setListener(listener: WatchdogListener | null): void {
    this.listener = listener;
  }

  setIntervalMs(ms: number): void {
    this.intervalMs = ms;
    if (this.timer) this.startTimer();
  }

  setThreshold(key: string, value: number): void {
    this.thresholds[key] = value;
  }

  /**
   * Set the per-event cooldown (ms). While an event is inside its cooldown the
   * SAME event will not fire again. 0 (default) disables the guard.
   */
  setCooldownMs(ms: number): void {
    this.cooldownMs = ms;
  }

  /**
   * Set hysteresis for a polled event: the condition must be true for `ticks`
   * consecutive ticks before it fires. Default 1 = current behavior. When
   * `event` is omitted the value becomes the global default for all polled
   * events (per-event values win).
   */
  setHysteresis(ticks: number, event?: string): void {
    this.thresholds[event ? `hysteresis.${event}` : 'hysteresis'] = ticks;
  }

  /**
   * Record a minimum-commitment window for the current action. While now <
   * `ms` from this call, interrupts of SAME-OR-LOWER priority than
   * `priority` are suppressed (P0/P1 safety/reflex interrupts still preempt).
   * The action's own priority defaults to P2.
   */
  noteCommitment(ms: number, priority: InterruptPriority = InterruptPriority.P2): void {
    this.commitmentUntil = Date.now() + ms;
    this.committedPriority = priority;
  }

  /** Clear any active minimum-commitment window. */
  clearCommitment(): void {
    this.commitmentUntil = null;
    this.committedPriority = null;
  }

  /** How the most recent interrupt wants the goal treated ('resumable' | 'invalid'). */
  getGoalDisposition(): GoalDisposition {
    return this.goalDisposition;
  }

  /** Rolling window of recent triggers (oldest first). */
  getRecentTriggers(): WatchdogTrigger[] {
    return [...this.recentTriggers];
  }

  startWatchdog(opts: WatchdogStartOptions = {}): void {
    this.clearTimer();
    this.enabledEvents = new Set<string>(
      opts.events && opts.events.length > 0 ? opts.events : EVENT_NAMES
    );
    if (opts.thresholds) {
      this.thresholds = { ...this.thresholds, ...opts.thresholds };
    }
    if (typeof opts.intervalMs === 'number' && opts.intervalMs > 0) {
      this.intervalMs = opts.intervalMs;
    }
    this.running = true;
    this.startTimer();
    // The chat listener runs in the background (parallel) and interrupts on
    // player chat; attach it whenever 'chat' is enabled.
    if (this.enabledEvents.has('chat')) this.attachChatListener();
    // The mineflayer event listeners fire instantly and interrupt the moment
    // an event happens; each handler guards on enabledEvents, so attaching
    // them while running is safe even for disabled events.
    this.attachEventListeners();
  }

  stopWatchdog(): void {
    this.clearTimer();
    this.running = false;
    this.detachChatListener();
    this.detachEventListeners();
    // Also halt the eternal primal loop so stopping the watchdog is a clean,
    // complete safety teardown (and test isolation stays clean).
    stopPrimalLoop();
  }

  /**
   * Attach the background chat listener so a player's chat message interrupts
   * the agent instantly (mode -> 'listen'), running in parallel with the
   * polled tick loop. Idempotent. Only reacts to messages from other players
   * (not the bot's own broadcasts).
   */
  attachChatListener(): void {
    const bot = this.bot;
    if (!bot || this.chatListening) return;
    this.chatListening = true;
    this.chatHandler = (username: string, message: string) => {
      if (this.isSelfChat(username)) return;
      if (!this.enabledEvents.has('chat')) return;
      if (!canPreempt(this.priorityFor('chat'))) return;
      this.trigger('chat', `PLAYER COMMAND from ${username}: "${message}" — CANCEL current action; switch to LISTEN mode and respond to the player.`);
    };
    // The bot emits 'chat' with (username, message) for every inbound chat.
    bot.on('chat', this.chatHandler);
  }

  /** Detach the background chat listener (idempotent). */
  detachChatListener(): void {
    const bot = this.bot;
    if (this.chatHandler) {
      try {
        bot?.removeListener('chat', this.chatHandler);
      } catch {
        // best-effort
      }
      this.chatHandler = null;
    }
    this.chatListening = false;
  }

  /**
   * Attach mineflayer event listeners that preempt the agent the INSTANT the
   * event fires — no polling latency. These run in parallel with the polled
   * tick loop (which remains the fallback for events with no listener: lava,
   * fall, void, night, hunger, inventory-full). Idempotent. Each handler:
   *
   *   - no-ops while an equal-or-higher-priority interrupt is already pending
   *     (canPreempt())
   *   - guards on the event being enabled (enabledEvents)
   *   - triggers with an event-specific directive + mode
   */
  attachEventListeners(): void {
    const bot = this.bot;
    if (!bot || this.eventListening) return;
    this.eventListening = true;
    const handlers = (this.eventHandler = {
      death: () => {
        if (!canPreempt(this.priorityFor('death'))) return;
        if (!this.enabledEvents.has('death')) return;
        this.trigger(
          'death',
          'DIED — CANCEL current action; auto-respawning, then resume if possible. Report the death.'
        );
        this.defensiveRespawn();
      },
      health: () => {
        if (!canPreempt(this.priorityFor('low-health'))) return;
        if (!this.enabledEvents.has('low-health')) return;
        const health = this.bot?.health;
        const limit = this.threshold('lowHealth', 6);
        if (typeof health !== 'number' || health >= limit) return;
        this.trigger(
          'low-health',
          `low health (<${limit}) — CANCEL; switch to DEFENSE/HEAL: flee, eat, or retreat.`
        );
      },
      entityHurt: (entity: unknown) => {
        if (!canPreempt(this.priorityFor('low-health'))) return;
        if (!this.enabledEvents.has('low-health')) return;
        const bot = this.bot;
        const selfId = bot?.entity?.id;
        const hurt = entity as { id?: number };
        if (selfId === undefined || !hurt || hurt.id !== selfId) return;
        const health = bot?.health;
        const limit = this.threshold('lowHealth', 6);
        if (typeof health !== 'number' || health >= limit) return;
        this.trigger(
          'low-health',
          `low health (<${limit}) — CANCEL; switch to DEFENSE/HEAL: flee, eat, or retreat.`
        );
      },
      forcedMove: () => {
        if (!canPreempt(this.priorityFor('reorient'))) return;
        if (!this.enabledEvents.has('reorient')) return;
        this.trigger(
          'reorient',
          'FORCED MOVE — position changed; invalidate pathfinding and re-orient.'
        );
      },
      breath: () => {
        if (!canPreempt(this.priorityFor('drowning'))) return;
        if (!this.enabledEvents.has('drowning')) return;
        const oxygen = this.bot?.oxygenLevel;
        if (typeof oxygen !== 'number' || oxygen >= 10) return;
        this.trigger('drowning', 'drowning — CANCEL; swim to surface.');
      }
    });
    bot.on('death', handlers.death);
    bot.on('health', handlers.health);
    bot.on('entityHurt', handlers.entityHurt);
    bot.on('forcedMove', handlers.forcedMove);
    bot.on('breath', handlers.breath);
  }

  /** Detach the mineflayer event listeners (idempotent). */
  detachEventListeners(): void {
    const bot = this.bot;
    if (this.eventHandler) {
      try {
        bot?.removeListener('death', this.eventHandler.death);
        bot?.removeListener('health', this.eventHandler.health);
        bot?.removeListener('entityHurt', this.eventHandler.entityHurt);
        bot?.removeListener('forcedMove', this.eventHandler.forcedMove);
        bot?.removeListener('breath', this.eventHandler.breath);
      } catch {
        // best-effort
      }
      this.eventHandler = null;
    }
    this.eventListening = false;
  }

  /**
   * Defensive manual respawn after a 'death' event. Auto-respawn is on by
   * default, so this is normally a no-op; it only matters if the bot was
   * created with respawn:false. Best-effort (never throws).
   */
  private defensiveRespawn(): void {
    const bot = this.bot;
    if (!bot) return;
    try {
      const respawn = (bot as { respawn?: () => unknown }).respawn;
      if (typeof respawn !== 'function') return;
      const promise = respawn() as Promise<unknown>;
      if (promise && typeof promise.catch === 'function') promise.catch(() => {});
    } catch {
      // best-effort
    }
  }

  private isSelfChat(username: string): boolean {
    const bot = this.bot;
    return Boolean(bot && bot.username && username === bot.username);
  }

  resumeWatchdog(): void {
    clearInterrupt();
    if (this.prevMode !== null) {
      this.mode = this.prevMode;
      this.prevMode = null;
    }
    if (this.running && !this.timer) this.startTimer();
  }

  setMode(mode: string): void {
    this.mode = mode;
  }

  /** Enable a watchdog event. Attaches listeners for event-driven events. */
  enableEvent(event: string): void {
    this.enabledEvents.add(event);
    if (event === 'chat') this.attachChatListener();
    if (event === 'death' || event === 'reorient' || event === 'low-health' || event === 'drowning') {
      this.attachEventListeners();
    }
  }

  /** Disable a watchdog event. Detaches the chat listener if it was the last reason to keep it. */
  disableEvent(event: string): void {
    this.enabledEvents.delete(event);
    if (event === 'chat' && !this.enabledEvents.has('chat')) this.detachChatListener();
  }

  getMode(): string {
    return this.mode;
  }

  getWatchdogStatus(): WatchdogStatus {
    return {
      running: this.running,
      mode: this.mode,
      enabledEvents: Array.from(this.enabledEvents),
      lastTrigger: this.lastTrigger,
      triggerCount: this.triggerCount,
      cooldownMs: this.cooldownMs,
      recentTriggers: [...this.recentTriggers],
      goalDisposition: this.goalDisposition
    };
  }

  /** Reset all state (timer, mode, triggers, bot ref, interrupt) for test isolation. */
  resetForTest(): void {
    this.stopWatchdog();
    this.detachChatListener();
    this.detachEventListeners();
    this.mode = 'idle';
    this.prevMode = null;
    this.intervalMs = 500;
    this.lastTrigger = null;
    this.triggerCount = 0;
    this.enabledEvents = new Set();
    this.thresholds = {};
    this.listener = null;
    this.lastTriggerAt = {};
    this.cooldownMs = 0;
    this.pendingTickCount = {};
    this.recentTriggers = [];
    this.goalDisposition = 'resumable';
    this.commitmentUntil = null;
    this.committedPriority = null;
    this.bot = null;
    clearInterrupt();
  }

  tick(): void {
    if (!this.running) return;
    const bot = this.bot;
    if (!bot || !bot.entity) return;
    for (const event of EVENT_PRIORITY) {
      if (!this.enabledEvents.has(event)) continue;
      // Skip events that a pending interrupt would not allow to preempt
      // (same-or-higher-priority interrupts already pending). Lower-priority
      // pending interrupts (e.g. night) do NOT block higher-priority ones.
      if (!canPreempt(this.priorityFor(event))) continue;
      const result = this.evaluateEvent(event);
      if (result) {
        // HYSTERESIS: the condition must persist for N consecutive ticks.
        const ticks = this.hysteresisFor(event);
        const count = (this.pendingTickCount[event] ?? 0) + 1;
        this.pendingTickCount[event] = count;
        if (count < ticks) continue;
        this.pendingTickCount[event] = 0;
        this.trigger(event, result.directive);
        return;
      } else {
        this.pendingTickCount[event] = 0;
      }
    }
  }

  trigger(event: string, directive: string): void {
    const now = Date.now();
    const priority = this.priorityFor(event);

    // COOLDOWN: suppress re-firing the SAME event until cooldownMs has elapsed.
    const cooldown = this.cooldownFor(event);
    const lastAt = this.lastTriggerAt[event];
    if (cooldown > 0 && lastAt !== undefined && now - lastAt < cooldown) {
      return;
    }

    // MIN-COMMITMENT: same-or-lower-priority interrupts are suppressed while
    // the current action is committed (P0/P1 safety/reflex always preempt).
    if (this.commitmentSuppresses(priority)) {
      return;
    }

    this.triggerCount++;
    this.lastTrigger = { event, at: now, message: directive };
    this.lastTriggerAt[event] = now;
    this.recentTriggers.push(this.lastTrigger);
    if (this.recentTriggers.length > this.maxRecentTriggers) {
      this.recentTriggers.shift();
    }
    this.goalDisposition = DISPOSITION_BY_EVENT[event] ?? 'resumable';
    this.prevMode = this.mode;
    this.mode = EVENT_MODES[event] ?? event;
    setInterrupt(directive, priority);
    if (this.listener) this.listener(directive, event);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private startTimer(): void {
    this.clearTimer();
    if (this.running) {
      this.timer = setInterval(() => this.tick(), this.intervalMs);
    }
  }

  private threshold(key: string, fallback: number): number {
    const value = this.thresholds[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }

  /** Interrupt priority for an event (unknown events default to P1). */
  private priorityFor(event: string): InterruptPriority {
    return PRIORITY_BY_EVENT[event] ?? InterruptPriority.P1;
  }

  /** Effective cooldown for an event (threshold `cooldownMs` wins over field). */
  private cooldownFor(_event: string): number {
    const fromThresholds = this.thresholds['cooldownMs'];
    const value = typeof fromThresholds === 'number' ? fromThresholds : this.cooldownMs;
    return Number.isFinite(value) && value >= 0 ? value : 0;
  }

  /** Hysteresis (consecutive ticks required) for a polled event. Default 1. */
  private hysteresisFor(event: string): number {
    const perEvent = this.thresholds[`hysteresis.${event}`];
    if (typeof perEvent === 'number' && Number.isFinite(perEvent)) return perEvent;
    const global = this.thresholds['hysteresis'];
    if (typeof global === 'number' && Number.isFinite(global)) return global;
    return 1;
  }

  /**
   * True when a minimum-commitment window is active and `priority` is the
   * same-or-lower priority than the committed action (so it is suppressed).
   * P0/P1 safety/reflex interrupts are never suppressed by commitment.
   */
  private commitmentSuppresses(priority: InterruptPriority): boolean {
    if (this.commitmentUntil === null || this.committedPriority === null) return false;
    if (priority <= InterruptPriority.P1) return false;
    if (Date.now() >= this.commitmentUntil) return false;
    return priority >= this.committedPriority;
  }

  private evaluateEvent(event: string): { directive: string } | null {
    const bot = this.bot;
    if (!bot) return null;
    try {
      switch (event) {
        case 'hostile': {
          const found = this.findNearestMob(
            (entity) => isHostileEntity(entity),
            this.threshold('hostileDist', 8)
          );
          if (!found) return null;
          return {
            directive: `hostiles within ${found.distance.toFixed(1)} blocks — CANCEL current action; switch to DEFENSE mode (equip-best-weapon + attack-entity or flee).`
          };
        }
        case 'creeper': {
          const found = this.findNearestMob(
            (entity) => entity.name === 'creeper',
            this.threshold('creeperDist', 5)
          );
          if (!found) return null;
          return {
            directive: `CREEPER within ${found.distance.toFixed(1)} blocks — CANCEL and FLEDGE immediately (flee).`
          };
        }
        case 'fall': {
          const velocity = bot.entity.velocity;
          const falling = Boolean(
            velocity &&
            velocity.y < -this.threshold('fallVelocity', 3) &&
            bot.entity.onGround === false
          );
          if (!falling) return null;
          return { directive: 'falling — CANCEL; prepare for landing / use water.' };
        }
        case 'void': {
          const y = bot.entity.position?.y;
          if (typeof y !== 'number' || y >= this.threshold('voidY', -60)) return null;
          return { directive: 'below y=-60 (void) — CANCEL; get to safe ground immediately.' };
        }
        case 'lava': {
          if (!this.lavaNearby()) return null;
          return { directive: 'lava nearby — CANCEL; route around (find-safe-path).' };
        }
        case 'low-health': {
          const health = bot.health;
          const limit = this.threshold('lowHealth', 6);
          if (typeof health !== 'number' || health >= limit) return null;
          return {
            directive: `low health (<${limit}) — CANCEL; switch to DEFENSE/HEAL: flee, eat, or retreat.`
          };
        }
        case 'hunger': {
          const food = bot.food;
          const limit = this.threshold('lowFood', 4);
          if (typeof food !== 'number' || food >= limit) return null;
          return { directive: `hunger low (<${limit}) — eat food.` };
        }
        case 'on-fire': {
          const entity = bot.entity as unknown as { fireTicks?: number; flameTicks?: number };
          const fire =
            (typeof entity.fireTicks === 'number' ? entity.fireTicks : 0) +
            (typeof entity.flameTicks === 'number' ? entity.flameTicks : 0);
          if (fire <= 0) return null;
          return { directive: 'ON FIRE — CANCEL; douse/retreat.' };
        }
        case 'night': {
          const timeOfDay = bot.time?.timeOfDay;
          if (typeof timeOfDay !== 'number' || timeOfDay < this.threshold('nightTime', 13000)) {
            return null;
          }
          if (bot.isSleeping) return null;
          if (this.isIndoors(bot)) return null;
          return { directive: 'night falling — CANCEL outdoor work; sleep or secure-perimeter.' };
        }
        case 'drowning': {
          const air = (bot.entity as unknown as { air?: number }).air;
          if (typeof air !== 'number' || air >= 10) return null;
          return { directive: 'drowning — CANCEL; swim to surface.' };
        }
        case 'inventory-full': {
          const items = (bot as unknown as { inventory?: { items?: () => unknown[] } })
            .inventory?.items?.() ?? [];
          if (items.length < this.threshold('inventoryFull', 36)) return null;
          return { directive: 'inventory nearly full — deposit-item or drop.' };
        }
        default:
          return null;
      }
    } catch {
      return null;
    }
  }

  private findNearestMob(
    predicate: (entity: NonNullable<Entity>) => boolean,
    maxDistance: number
  ): { entity: NonNullable<Entity>; distance: number } | null {
    const bot = this.bot;
    const origin: Vec3 | undefined = bot?.entity?.position;
    if (!bot || !origin) return null;
    const selfId = bot.entity?.id;
    let nearest: NonNullable<Entity> | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const record of iterateEntities(bot)) {
      const entity = record.entity;
      if (!entity) continue;
      if (selfId !== undefined && entity.id === selfId) continue;
      if (!predicate(entity)) continue;
      if (!entity.position) continue;
      const distance = distanceToEntity(origin, entity);
      if (distance > maxDistance) continue;
      if (distance < nearestDistance) {
        nearest = entity;
        nearestDistance = distance;
      }
    }
    return nearest ? { entity: nearest, distance: nearestDistance } : null;
  }

  private lavaNearby(): boolean {
    const bot = this.bot;
    if (!bot || typeof bot.findBlock !== 'function') return false;
    const block = bot.findBlock({
      matching: (b: { name?: string }) => b.name === 'lava' || b.name === 'flowing_lava',
      maxDistance: this.threshold('lavaDist', 3),
      count: 1
    });
    return Boolean(block);
  }

  private isIndoors(bot: Bot): boolean {
    try {
      const above = bot.blockAt?.(bot.entity.position.offset(0, 2, 0));
      if (!above) return false;
      const skyLight = (above as unknown as { skyLight?: number }).skyLight;
      return typeof skyLight === 'number' && skyLight === 0;
    } catch {
      return false;
    }
  }
}

export const watchdog = new Watchdog();

/** Reset all watchdog state (timer, mode, triggers, bot ref, interrupt) for test isolation. */
export function resetWatchdogForTest(): void {
  watchdog.resetForTest();
}

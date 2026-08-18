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
import { setInterrupt, clearInterrupt, isInterrupted } from './interrupt.js';
import { isHostileEntity, iterateEntities, distanceToEntity } from './tools/entity-tools.js';

export const EVENT_NAMES = [
  'hostile', 'creeper', 'fall', 'void', 'lava', 'low-health', 'hunger',
  'on-fire', 'night', 'drowning', 'inventory-full', 'chat'
] as const;

export type WatchdogEvent = (typeof EVENT_NAMES)[number];

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
  chat: 'listen'
};

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
  private bot: Bot | null = null;
  /** Bound background chat handler (player -> interrupt). */
  private chatHandler: ((username: string, message: string) => void) | null = null;
  /** Whether the background chat listener is attached. */
  private chatListening = false;

  setBot(bot: Bot): void {
    // Re-attach the chat listener if it was active on the previous bot.
    const wasListening = this.chatListening;
    this.bot = bot;
    if (wasListening) this.attachChatListener();
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
  }

  stopWatchdog(): void {
    this.clearTimer();
    this.running = false;
    this.detachChatListener();
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

  /** Enable a watchdog event (e.g. 'chat'). Attaches the chat listener for event-driven events. */
  enableEvent(event: string): void {
    this.enabledEvents.add(event);
    if (event === 'chat') this.attachChatListener();
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
      triggerCount: this.triggerCount
    };
  }

  /** Reset all state (timer, mode, triggers, bot ref, interrupt) for test isolation. */
  resetForTest(): void {
    this.stopWatchdog();
    this.detachChatListener();
    this.mode = 'idle';
    this.prevMode = null;
    this.intervalMs = 500;
    this.lastTrigger = null;
    this.triggerCount = 0;
    this.enabledEvents = new Set();
    this.thresholds = {};
    this.listener = null;
    this.bot = null;
    clearInterrupt();
  }

  tick(): void {
    if (!this.running) return;
    const bot = this.bot;
    if (!bot || !bot.entity) return;
    if (isInterrupted()) return;
    for (const event of EVENT_PRIORITY) {
      if (!this.enabledEvents.has(event)) continue;
      const result = this.evaluateEvent(event);
      if (result) {
        this.trigger(event, result.directive);
        return;
      }
    }
  }

  trigger(event: string, directive: string): void {
    this.triggerCount++;
    this.lastTrigger = { event, at: Date.now(), message: directive };
    this.prevMode = this.mode;
    this.mode = EVENT_MODES[event] ?? event;
    setInterrupt(directive);
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

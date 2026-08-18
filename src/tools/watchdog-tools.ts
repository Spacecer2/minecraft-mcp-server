/**
 * Watchdog MCP tools.
 *
 * These drive the module-scoped watchdog singleton (src/watchdog.ts):
 *
 *   - watchdog-start  — attach the bot, install the directive listener,
 *                       start the background scan loop
 *   - read-interrupt  — the authoritative channel the LLM reads to learn it
 *                       must switch modes (consumes the pending directive but
 *                       NOT the interrupt flag)
 *   - watchdog-status — formatted watchdog state
 *   - watchdog-stop   — halt the scan loop
 *   - watchdog-resume — clear the interrupt + restore the pre-trigger mode
 *   - set-mode / get-mode — manual mode control
 *
 * On a trigger, the listener records the pending directive (read via
 * `read-interrupt`) and ALSO echoes it through `bot.chat('[WATCHDOG] ...')` so
 * a human sees it in-game and it lands in the chat log.
 */

import { z } from 'zod';
import type { Bot } from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';
import { watchdog, EVENT_NAMES } from '../watchdog.js';

let pendingDirective: string | null = null;

/** Reset the tools' module-level pending-directive state for tests. */
export function resetWatchdogToolsForTest(): void {
  pendingDirective = null;
}

/** Read the current pending directive without consuming it (test helper). */
export function getPendingDirectiveForTest(): string | null {
  return pendingDirective;
}

export function registerWatchdogTools(factory: ToolFactory, getBot: () => Bot): void {
  factory.registerTool(
    "watchdog-start",
    "Start the preemption watchdog: a background safety monitor that watches for impending events (hostiles, creepers, falls, void, lava, low health, hunger, fire, night, drowning, full inventory) and CANCELS the current action by injecting an interrupt + mode-switch directive.",
    {
      events: z.array(z.enum(EVENT_NAMES)).optional().describe("Which events to monitor (default: all)"),
      intervalMs: z.coerce.number().int().positive().optional().describe("Scan interval in ms (default: 500)"),
      hostileDist: z.coerce.number().nonnegative().optional().describe("Hostile detection radius in blocks (default: 8)")
    },
    async ({ events, intervalMs, hostileDist }) => {
      const bot = getBot();
      watchdog.setBot(bot);
      watchdog.setListener((directive) => {
        pendingDirective = directive;
        try {
          bot.chat(`[WATCHDOG] ${directive}`);
        } catch {
          // Chat echo is best-effort; the pending directive is authoritative.
        }
      });

      const thresholds: Record<string, number> = {};
      if (typeof hostileDist === 'number') thresholds.hostileDist = hostileDist;

      watchdog.startWatchdog({ events, intervalMs, thresholds });

      const enabled = watchdog.getWatchdogStatus().enabledEvents;
      const list = enabled.length > 0 ? enabled.join(', ') : (events ?? EVENT_NAMES).join(', ');
      return factory.createResponse(`Watchdog started (events: ${list}). Mode: ${watchdog.getMode()}.`);
    }
  );

  factory.registerTool(
    "read-interrupt",
    "Read the current pending watchdog interrupt directive. Consumes it (each directive is returned once) but does NOT clear the interrupt flag — call watchdog-resume once you have switched modes.",
    {},
    async () => {
      if (pendingDirective === null) {
        return factory.createResponse('No interrupt pending.');
      }
      const directive = pendingDirective;
      pendingDirective = null;
      return factory.createResponse(directive);
    }
  );

  factory.registerTool(
    "watchdog-status",
    "Get the watchdog state: running/stopped, current mode, enabled events, and last trigger.",
    {},
    async () => {
      const status = watchdog.getWatchdogStatus();
      const state = status.running ? 'running' : 'stopped';
      const events = status.enabledEvents.length > 0 ? status.enabledEvents.join(', ') : 'none';
      let suffix = '';
      if (status.lastTrigger) {
        suffix = ` Last trigger: ${status.lastTrigger.event} at ${new Date(status.lastTrigger.at).toISOString()}: ${status.lastTrigger.message} (trigger #${status.triggerCount}).`;
      }
      return factory.createResponse(`Watchdog: ${state}. Mode: ${status.mode}. Events: ${events}.${suffix}`);
    }
  );

  factory.registerTool(
    "watchdog-stop",
    "Stop the watchdog. The scan loop halts and no new interrupts will be injected.",
    {},
    async () => {
      watchdog.stopWatchdog();
      return factory.createResponse('Watchdog stopped.');
    }
  );

  factory.registerTool(
    "watchdog-resume",
    "Resume after an interrupt: clears the interrupt flag and restores the mode that was active before the trigger.",
    {},
    async () => {
      watchdog.resumeWatchdog();
      return factory.createResponse(`Watchdog resumed. Mode: ${watchdog.getMode()}.`);
    }
  );

  factory.registerTool(
    "set-mode",
    "Manually set the watchdog mode (e.g. mining, building, defense).",
    {
      mode: z.string().describe("Mode to set")
    },
    async ({ mode }) => {
      watchdog.setMode(mode);
      return factory.createResponse(`Mode set to ${mode}.`);
    }
  );

  factory.registerTool(
    "get-mode",
    "Get the current watchdog mode.",
    {},
    async () => {
      return factory.createResponse(`Mode: ${watchdog.getMode()}.`);
    }
  );
}

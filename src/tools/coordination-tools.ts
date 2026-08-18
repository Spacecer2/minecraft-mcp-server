import { z } from "zod";
import { ToolFactory } from '../tool-factory.js';
import type { BotManager } from '../bot-manager.js';

export function registerCoordinationTools(factory: ToolFactory, manager: BotManager): void {
  factory.registerTool(
    "agent-share",
    "Share a key/value pair on the coordination blackboard so other bots can read it",
    {
      key: z.string().describe("Blackboard key to write"),
      value: z.string().describe("Value to store under the key")
    },
    async ({ key, value }: { key: string; value: string }) => {
      manager.setShared(key, value);
      return factory.createResponse(`Shared ${key} = ${value}`);
    }
  );

  factory.registerTool(
    "agent-recall",
    "Read a value from the coordination blackboard, or list everything that is shared",
    {
      key: z.string().optional().describe("Blackboard key to read (omit to list all)")
    },
    async ({ key }: { key?: string }) => {
      if (key !== undefined) {
        const value = manager.getShared(key);
        return value !== undefined
          ? factory.createResponse(`Shared: ${value}`)
          : factory.createResponse(`No shared value for ${key}`);
      }

      const all = manager.getAllShared();
      const entries = Object.entries(all);
      if (entries.length === 0) {
        return factory.createResponse('Nothing shared');
      }
      return factory.createResponse(entries.map(([k, v]) => `${k} = ${v}`).join('\n'));
    }
  );

  factory.registerTool(
    "agent-forget",
    "Delete a value from the coordination blackboard, or clear all shared values",
    {
      key: z.string().optional().describe("Blackboard key to delete (omit to clear all)")
    },
    async ({ key }: { key?: string }) => {
      if (key !== undefined) {
        manager.deleteShared(key);
        return factory.createResponse(`Forgot shared value for ${key}`);
      }
      for (const existingKey of Object.keys(manager.getAllShared())) {
        manager.deleteShared(existingKey);
      }
      return factory.createResponse('Cleared all shared values');
    }
  );

  factory.registerTool(
    "list-bot-state",
    "List all active bots and their connection state and position",
    {},
    async () => {
      const names = manager.getNames();
      if (names.length === 0) {
        return factory.createResponse("No bots active");
      }
      const lines = names.map((name) => {
        const conn = manager.getConnection(name);
        const bot = conn.getBot();
        let pos = '?';
        try {
          if (bot?.entity?.position) {
            const p = bot.entity.position;
            pos = `(${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})`;
          }
        } catch {
          // position unavailable; keep '?'
        }
        const state = conn.getState();
        const primary = name === manager.getPrimaryName() ? ' (primary)' : '';
        return `${name}${primary}: ${state} @ ${pos}`;
      });
      return factory.createResponse(`Active bots:\n${lines.join('\n')}`);
    }
  );
}

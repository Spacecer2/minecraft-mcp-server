#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { log } from './logger.js';
import { parseConfig } from './config.js';
import { BotManager, generateBotName } from './bot-manager.js';
import { botContext } from './bot-context.js';
import { ToolFactory } from './tool-factory.js';
import { registerPositionTools } from './tools/position-tools.js';
import { registerInventoryTools } from './tools/inventory-tools.js';
import { registerBlockTools } from './tools/block-tools.js';
import { registerEntityTools } from './tools/entity-tools.js';
import { registerChatTools } from './tools/chat-tools.js';
import { registerFlightTools } from './tools/flight-tools.js';
import { registerGameStateTools } from './tools/gamestate-tools.js';
import { registerCraftingTools } from './tools/crafting-tools.js';
import { registerFurnaceTools } from './tools/furnace-tools.js';
import { registerWorldStateTools } from './tools/world-state-tools.js';
import { registerScanTools } from './tools/scan-tools.js';
import { registerMemoryTools } from './tools/memory-tools.js';
import { registerBuildTools } from './tools/build-tools.js';
import { registerNavigationTools } from './tools/navigation-tools.js';
import { registerCoordinationTools } from './tools/coordination-tools.js';
import { registerTemplateTools } from './tools/template-registry.js';
import { registerPlanTools } from './tools/plan-tools.js';
import { registerPerceptionTools } from './tools/perception-tools.js';
import { registerGatherTools } from './tools/gather-tools.js';
import { registerBlueprintTools } from './tools/blueprint-tools.js';
import { registerTaskRunnerTools } from './tools/task-runner-tools.js';
import { registerMapTools } from './tools/map-tools.js';
import { registerContainerTools } from './tools/container-tools.js';
import { registerQATools } from './tools/qa-tools.js';
import { registerRedstoneBuildTools } from './tools/redstone-build.js';
import { registerBlueprintStoreTools } from './tools/blueprint-store.js';
import { registerCombatTools } from './tools/combat-tools.js';
import { registerFarmingTools } from './tools/farming-tools.js';
import { registerMotionTools } from './tools/motion-tools.js';
import { registerVisionTools } from './tools/vision-tools.js';
import { registerWatchdogTools } from './tools/watchdog-tools.js';
import { z } from "zod";
import * as fs from 'node:fs';

process.on('unhandledRejection', (reason) => {
  log('error', `Unhandled rejection: ${reason}`);
});

process.on('uncaughtException', (error) => {
  log('error', `Uncaught exception: ${error}`);
});

function appendChatLog(chatLogPath: string, botName: string, username: string, content: string): void {
  if (!chatLogPath) return;
  try {
    const line = JSON.stringify({ timestamp: Date.now(), bot: botName, username, content }) + '\n';
    fs.appendFileSync(chatLogPath, line);
  } catch (err) {
    log('warn', `Failed to write chat log: ${err}`);
  }
}

async function main() {
  const config = parseConfig();
  const manager = new BotManager({
    host: config.host,
    port: config.port,
    primaryName: config.username,
    onLog: log,
    onChatMessage: (botName, username, content) => {
      appendChatLog(config.chatLog, botName, username, content);
    }
  });

  manager.createPrimaryBot();

  const server = new McpServer({
    name: "minecraft-mcp-server",
    version: "2.0.4"
  });

  const factory = new ToolFactory(server, manager);
  const getBot = () => manager.getBot(botContext.getStore() ?? undefined)!;
  const getStore = () => manager.getStore(botContext.getStore() ?? undefined);

  factory.registerTool(
    "spawn-bot",
    "Spawn an additional Minecraft bot that connects to the server. Give it a unique name or leave empty for a randomized one. Returns the bot's username so you can target it with the 'bot' parameter on other tools.",
    {
      name: z.string().optional().describe("Unique bot name (default: randomized like Bot-a1b2c3)"),
      host: z.string().optional().describe("Server host (default: configured host)"),
      port: z.number().optional().describe("Server port (default: configured port)")
    },
    async ({ name, host, port }) => {
      const botName = name || generateBotName();
      try {
        await manager.spawnBot(botName, host ?? config.host, port ?? config.port);
      } catch (err) {
        return factory.createErrorResponse(
          `Failed to spawn bot "${botName}": ${err instanceof Error ? err.message : String(err)}`
        );
      }
      return factory.createResponse(`Spawned bot "${botName}". Use bot="${botName}" on any tool to control it.`);
    }
  );

  factory.registerTool(
    "list-bots",
    "List all active bot instances and their connection status",
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
        } catch { /* ignore */ }
        const state = conn.getState();
        const primary = name === manager.getPrimaryName() ? ' (primary)' : '';
        return `${name}${primary}: ${state} @ ${pos}`;
      });
      return factory.createResponse(`Active bots:\n${lines.join('\n')}`);
    }
  );

  factory.registerTool(
    "despawn-bot",
    "Disconnect and remove a spawned bot by name",
    {
      name: z.string().describe("Bot name to despawn (cannot remove the primary bot)")
    },
    async ({ name }) => {
      if (name === manager.getPrimaryName()) {
        return factory.createResponse(`Cannot despawn primary bot "${name}"`);
      }
      const removed = manager.despawnBot(name);
      return removed
        ? factory.createResponse(`Despawned bot "${name}"`)
        : factory.createResponse(`No bot named "${name}" found. Active bots: ${manager.getNames().join(', ') || 'none'}`);
    }
  );

  registerPositionTools(factory, getBot);
  registerInventoryTools(factory, getBot);
  registerBlockTools(factory, getBot);
  registerEntityTools(factory, getBot);
  registerChatTools(factory, getBot, getStore);
  registerFlightTools(factory, getBot);
  registerGameStateTools(factory, getBot);
  registerCraftingTools(factory, getBot);
  registerFurnaceTools(factory, getBot);
  registerWorldStateTools(factory, getBot);
  registerScanTools(factory, getBot);
  registerMemoryTools(factory);
  registerBuildTools(factory, getBot);
  registerNavigationTools(factory, getBot);
  registerCoordinationTools(factory, manager);
  registerTemplateTools(factory);
  registerPlanTools(factory, getBot);
  registerPerceptionTools(factory, getBot);
  registerGatherTools(factory, getBot);
  registerBlueprintTools(factory, getBot);
  registerTaskRunnerTools(factory, getBot);
  registerMapTools(factory, getBot);
  registerContainerTools(factory, getBot);
  registerQATools(factory, getBot);
  registerRedstoneBuildTools(factory, getBot);
  registerBlueprintStoreTools(factory);
  registerCombatTools(factory, getBot);
  registerFarmingTools(factory, getBot);
  registerMotionTools(factory, getBot);
  registerVisionTools(factory, getBot);
  registerWatchdogTools(factory, getBot);

  process.stdin.on('end', () => {
    manager.cleanup();
    log('info', 'MCP Client has disconnected. Shutting down...');
    process.exit(0);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  log('error', `Fatal error in main(): ${error}`);
  process.exit(1);
});

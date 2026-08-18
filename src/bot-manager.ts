import { randomBytes } from 'node:crypto';
import { BotConnection } from './bot-connection.js';
import { MessageStore } from './message-store.js';

interface BotManagerConfig {
  host: string;
  port: number;
  primaryName: string;
  onLog: (level: string, message: string) => void;
  onChatMessage: (botName: string, username: string, content: string) => void;
}

export class BotManager {
  private bots = new Map<string, BotConnection>();
  private stores = new Map<string, MessageStore>();
  private host: string;
  private port: number;
  private primaryName: string;
  private onLog: (level: string, message: string) => void;
  private onChatMessage: (botName: string, username: string, content: string) => void;

  constructor(config: BotManagerConfig) {
    this.host = config.host;
    this.port = config.port;
    this.primaryName = config.primaryName;
    this.onLog = config.onLog;
    this.onChatMessage = config.onChatMessage;
  }

  getPrimaryName(): string {
    return this.primaryName;
  }

  addBot(connection: BotConnection, name: string): void {
    this.bots.set(name, connection);
    this.stores.set(name, new MessageStore());
  }

  getNames(): string[] {
    return Array.from(this.bots.keys());
  }

  getStore(name?: string): MessageStore {
    return this.stores.get(name ?? this.primaryName) ?? this.stores.get(this.primaryName)!;
  }

  getConnection(name?: string): BotConnection {
    const target = name ?? this.primaryName;
    const connection = this.bots.get(target);
    if (!connection) {
      throw new Error(`Unknown bot: ${target}. Known bots: ${this.getNames().join(', ') || 'none'}`);
    }
    return connection;
  }

  getBot(name?: string) {
    return this.getConnection(name).getBot();
  }

  private makeCallbacks(botName: string) {
    return {
      onLog: this.onLog,
      onChatMessage: (username: string, content: string) => {
        this.getStore(botName)?.addMessage(username, content);
        this.onChatMessage(botName, username, content);
      }
    };
  }

  createPrimaryBot(): BotConnection {
    const connection = new BotConnection(
      { host: this.host, port: this.port, username: this.primaryName },
      this.makeCallbacks(this.primaryName)
    );
    this.addBot(connection, this.primaryName);
    connection.connect();
    return connection;
  }

  spawnBot(name: string, host?: string, port?: number): BotConnection {
    if (this.bots.has(name)) {
      throw new Error(`A bot named "${name}" already exists.`);
    }
    const connection = new BotConnection(
      { host: host ?? this.host, port: port ?? this.port, username: name },
      this.makeCallbacks(name)
    );
    this.addBot(connection, name);
    connection.connect();
    this.onLog('info', `Spawned bot "${name}" (${host ?? this.host}:${port ?? this.port})`);
    return connection;
  }

  despawnBot(name: string): boolean {
    if (name === this.primaryName) {
      throw new Error(`Cannot despawn the primary bot "${name}".`);
    }
    const connection = this.bots.get(name);
    if (!connection) {
      return false;
    }
    connection.cleanup();
    this.bots.delete(name);
    this.stores.delete(name);
    this.onLog('info', `Despawned bot "${name}"`);
    return true;
  }

  cleanup(): void {
    for (const connection of this.bots.values()) {
      connection.cleanup();
    }
  }
}

export function generateBotName(prefix = 'Bot'): string {
  const suffix = randomBytes(3).toString('hex');
  return `${prefix}-${suffix}`;
}

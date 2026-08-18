import { z } from "zod";
import mineflayer from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';
import { MessageStore } from '../message-store.js';

interface ChatMessage {
  timestamp: number;
  username: string;
  content: string;
}

function matchesChatFilter(
  message: ChatMessage,
  from: string | undefined,
  onlyMentionsMe: boolean | undefined,
  botUsername: string
): boolean {
  if (from) {
    const needle = from.toLowerCase();
    if (!message.username.toLowerCase().includes(needle)) {
      return false;
    }
  }
  if (onlyMentionsMe) {
    const me = botUsername.toLowerCase();
    if (!message.content.toLowerCase().includes(me)) {
      return false;
    }
  }
  return true;
}

function formatChat(header: string, messages: ChatMessage[]): string {
  let output = `${header}\n\n`;
  messages.forEach((msg, index) => {
    const timestamp = new Date(msg.timestamp).toISOString();
    output += `${index + 1}. ${timestamp} - ${msg.username}: ${msg.content}\n`;
  });
  return output;
}

export function registerChatTools(factory: ToolFactory, getBot: () => mineflayer.Bot, getStore: () => MessageStore): void {
  factory.registerTool(
    "send-chat",
    "Send a chat message in-game",
    {
      message: z.string().describe("Message to send in chat")
    },
    async ({ message }) => {
      const bot = getBot();
      bot.chat(message);
      return factory.createResponse(`Sent message: "${message}"`);
    }
  );

  factory.registerTool(
    "read-chat",
    "Get recent chat messages from players",
    {
      count: z.number().optional().describe("Number of recent messages to retrieve (default: 10, max: 100)")
    },
    async ({ count = 10 }) => {
      const messageStore = getStore();
      const maxCount = Math.min(count, messageStore.getMaxMessages());
      const messages = messageStore.getRecentMessages(maxCount);

      if (messages.length === 0) {
        return factory.createResponse("No chat messages found");
      }

      return factory.createResponse(formatChat(`Found ${messages.length} chat message(s):`, messages));
    }
  );

  factory.registerTool(
    "read-new-chat",
    "Get chat messages received since the last read-new-chat / wait-for-chat call. Cursor-based; advances the cursor. Empty when nothing new has arrived.",
    {
      from: z.string().optional().describe("Only return messages from this username (case-insensitive partial)"),
      onlyMentionsMe: z.boolean().optional().describe("Only return messages that mention the bot's username")
    },
    async ({ from, onlyMentionsMe }) => {
      const messageStore = getStore();
      const botUsername = getBot().username;
      const messages = messageStore.getNewMessages().filter((msg) =>
        matchesChatFilter(msg, from, onlyMentionsMe, botUsername)
      );

      if (messages.length === 0) {
        return factory.createResponse("No new chat messages");
      }

      return factory.createResponse(formatChat(`Found ${messages.length} new chat message(s):`, messages));
    }
  );

  factory.registerTool(
    "peek-chat",
    "Check for new chat messages WITHOUT advancing the cursor. Returns any new messages but leaves them for the next read-new-chat / wait-for-chat call.",
    {
      count: z.number().optional().describe("Max messages to return (default: 20)"),
      from: z.string().optional().describe("Only return messages from this username (case-insensitive partial)"),
      onlyMentionsMe: z.boolean().optional().describe("Only return messages that mention the bot's username")
    },
    async ({ count = 20, from, onlyMentionsMe }) => {
      const messageStore = getStore();
      const botUsername = getBot().username;
      const messages = messageStore.peekNewMessages().slice(-count).filter((msg) =>
        matchesChatFilter(msg, from, onlyMentionsMe, botUsername)
      );

      if (messages.length === 0) {
        return factory.createResponse("No new chat messages");
      }

      return factory.createResponse(formatChat(`Found ${messages.length} pending chat message(s):`, messages));
    }
  );

  factory.registerTool(
    "wait-for-chat",
    "Wait for the next chat message to arrive (blocks until a new message or timeout). Advances the cursor with read-new-chat semantics. Use this to continuously listen for in-game instructions.",
    {
      timeoutSeconds: z.number().optional().describe("How long to wait in seconds (default: 60, max: 600)"),
      from: z.string().optional().describe("Only return messages from this username (case-insensitive partial)"),
      onlyMentionsMe: z.boolean().optional().describe("Only return messages that mention the bot's username")
    },
    async ({ timeoutSeconds = 60, from, onlyMentionsMe }) => {
      const messageStore = getStore();
      const maxWait = Math.min(Math.max(timeoutSeconds, 1), 600);
      const bot = getBot();
      const botUsername = bot.username;

      const pending = messageStore.peekNewMessages().filter((msg) =>
        matchesChatFilter(msg, from, onlyMentionsMe, botUsername)
      );
      if (pending.length > 0) {
        const messages = messageStore.getNewMessages().filter((msg) =>
          matchesChatFilter(msg, from, onlyMentionsMe, botUsername)
        );
        return factory.createResponse(formatChat(`Received ${messages.length} new chat message(s):`, messages));
      }

      return new Promise((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout>;

        const settle = (text: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          bot.removeListener('chat', onChat);
          resolve(factory.createResponse(text));
        };

        const onChat = () => {
          const messages = messageStore.getNewMessages().filter((msg) =>
            matchesChatFilter(msg, from, onlyMentionsMe, botUsername)
          );
          if (messages.length > 0) {
            settle(formatChat(`Received ${messages.length} new chat message(s):`, messages));
          }
        };

        timer = setTimeout(() => {
          settle(`Timed out after ${maxWait}s with no new chat messages`);
        }, maxWait * 1000);

        bot.on('chat', onChat);

        const messages = messageStore.getNewMessages().filter((msg) =>
          matchesChatFilter(msg, from, onlyMentionsMe, botUsername)
        );
        if (messages.length > 0) {
          settle(formatChat(`Received ${messages.length} new chat message(s):`, messages));
        }
      });
    }
  );
}

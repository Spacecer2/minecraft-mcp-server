interface StoredMessage {
  timestamp: number;
  username: string;
  content: string;
}

const MAX_STORED_MESSAGES = 100;

export class MessageStore {
  private messages: StoredMessage[] = [];
  private maxMessages = MAX_STORED_MESSAGES;
  private cursor = 0;

  addMessage(username: string, content: string): void {
    const message: StoredMessage = {
      timestamp: Date.now(),
      username,
      content
    };

    this.messages.push(message);

    if (this.messages.length > this.maxMessages) {
      this.messages.shift();
      this.cursor = Math.max(0, this.cursor - 1);
    }
  }

  getRecentMessages(count: number = 10): StoredMessage[] {
    if (count <= 0) {
      return [];
    }
    return this.messages.slice(-count);
  }

  getNewMessages(): StoredMessage[] {
    if (this.cursor >= this.messages.length) {
      return [];
    }
    const newMessages = this.messages.slice(this.cursor);
    this.cursor = this.messages.length;
    return newMessages;
  }

  peekNewMessages(): StoredMessage[] {
    if (this.cursor >= this.messages.length) {
      return [];
    }
    return this.messages.slice(this.cursor);
  }

  getMaxMessages(): number {
    return this.maxMessages;
  }
}

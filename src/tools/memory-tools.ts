import { z } from "zod";
import { ToolFactory } from '../tool-factory.js';

interface MemoryTask {
  description: string;
  status: string;
  notes: string[];
}

const memoryStore = new Map<string, string>();
const taskList: MemoryTask[] = [];

export function resetMemoryStore(): void {
  memoryStore.clear();
  taskList.length = 0;
}

export function registerMemoryTools(factory: ToolFactory): void {
  factory.registerTool(
    "remember",
    "Store a value under a key for later recall. Use to track build stage, spawn coords, or inventory plans across calls (LLM context truncation protection).",
    {
      key: z.string().describe("Key to store under"),
      value: z.string().describe("Value to remember")
    },
    async ({ key, value }: { key: string, value: string }) => {
      memoryStore.set(key, value);
      return factory.createResponse(`Remembered ${key} = ${value}`);
    }
  );

  factory.registerTool(
    "recall",
    "Recall a remembered value, or list all remembered values if no key is given",
    {
      key: z.string().optional().describe("Key to recall (omit to list everything)")
    },
    async ({ key }: { key?: string }) => {
      if (key !== undefined) {
        const value = memoryStore.get(key);
        if (value === undefined) {
          return factory.createResponse(`No value stored for ${key}`);
        }
        return factory.createResponse(`Value: ${value}`);
      }

      if (memoryStore.size === 0) {
        return factory.createResponse('Nothing remembered');
      }

      const lines = [...memoryStore.entries()].map(([k, v]) => `${k} = ${v}`);
      return factory.createResponse(lines.join('\n'));
    }
  );

  factory.registerTool(
    "forget",
    "Delete a remembered value, or clear all remembered values if no key is given",
    {
      key: z.string().optional().describe("Key to forget (omit to clear everything)")
    },
    async ({ key }: { key?: string }) => {
      if (key !== undefined) {
        memoryStore.delete(key);
        return factory.createResponse(`Forgot ${key}`);
      }
      memoryStore.clear();
      return factory.createResponse('Cleared all remembered values');
    }
  );

  factory.registerTool(
    "add-task",
    "Append a task to the in-memory build plan. Returns the task id for later updates.",
    {
      description: z.string().describe("What the task involves"),
      status: z.string().optional().describe("Initial status (default: pending)")
    },
    async ({ description, status = 'pending' }: { description: string, status?: string }) => {
      const id = taskList.length;
      taskList.push({ description, status, notes: [] });
      return factory.createResponse(`Added task ${id}: ${description} [${status}]`);
    }
  );

  factory.registerTool(
    "list-tasks",
    "List all build tasks, optionally filtered by status",
    {
      status: z.string().optional().describe("Only show tasks with this status")
    },
    async ({ status }: { status?: string }) => {
      const filtered = taskList
        .map((task, index) => ({ task, index }))
        .filter(({ task }) => status === undefined || task.status === status);

      if (filtered.length === 0) {
        return factory.createResponse('No tasks');
      }

      const lines = filtered.map(({ task, index }) => {
        let line = `${index + 1}. [${task.status}] ${task.description}`;
        if (task.notes.length > 0) {
          line += ` (note: ${task.notes.join('; ')})`;
        }
        return line;
      });
      return factory.createResponse(lines.join('\n'));
    }
  );

  factory.registerTool(
    "update-task",
    "Update a task's status and optionally append a note",
    {
      id: z.coerce.number().int().describe("Task id to update"),
      status: z.string().describe("New status (e.g. pending, in-progress, done, blocked)"),
      note: z.string().optional().describe("Optional note to append to the task")
    },
    async ({ id, status, note }: { id: number, status: string, note?: string }) => {
      const task = taskList[id];
      if (!task) {
        return factory.createErrorResponse(`Task ${id} not found`);
      }
      task.status = status;
      if (note !== undefined) {
        task.notes.push(note);
      }
      return factory.createResponse(`Updated task ${id} status to ${status}`);
    }
  );
}

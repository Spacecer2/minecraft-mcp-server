import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, ZodError, ZodRawShape, ZodType } from "zod";
import type { BotConnection } from './bot-connection.js';
import { botContext } from './bot-context.js';

type McpResponse = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
};

export interface BotManagerLike {
  getPrimaryName(): string;
  getConnection(name?: string): BotConnection;
}

/**
 * TOOL VISIBILITY
 *
 * Each registered tool is either:
 *   - 'major'  (default) — LLM-facing: surfaced via `server.tool(...)` so the
 *     LLM sees and can call it through the MCP tool list.
 *   - 'primal' (hidden)  — internal/back-brain only: the executor is stored on
 *     the factory (retrievable via `callPrimal` / `isPrimalTool`) but
 *     `server.tool(...)` is NOT called, so the LLM never sees it. These are the
 *     granular micro-tools (dig-block, place-block, move-to-position, etc.)
 *     that the LLM must NOT hand-drive — the major functions (run-goal) and
 *     the primal brain call the bot directly instead.
 *
 * A tool is marked 'primal' in ONE of two ways (both feed the same logic):
 *   1. Explicitly, via the optional `options.visibility` on registerTool.
 *   2. By name, via `setPrimalToolNames(names)` — a per-registration allowlist
 *      checked at the single chokepoint (registerTool). This lets the host
 *      hide a whole family of micro-tools without touching the individual
 *      src/tools/*.ts registration files (which call registerTool with 4 args).
 *
 * DECISION: `registerTool` remains fully backward-compatible — the new
 * options/visibility parameter and the name-set are BOTH optional. Existing
 * callers (and tests that grab the executor from `server.tool`'s 4th arg)
 * behave exactly as before for 'major' tools.
 */
export type ToolVisibility = 'major' | 'primal';

export interface RegisterToolOptions {
  visibility?: ToolVisibility;
}

export class ToolFactory {
  constructor(
    private server: McpServer,
    private manager: BotManagerLike
  ) {}

  /** Executors of 'primal' (hidden) tools, keyed by tool name. */
  private primalExecutors = new Map<string, (args: unknown) => Promise<McpResponse>>();
  /** Name allowlist of tools to hide from the LLM (checked at registerTool). */
  private primalToolNames = new Set<string>();

  /**
   * Mark a set of tool names as 'primal' (hidden from the LLM). Registration of
   * any tool whose name is in this set will store its executor internally but
   * skip `server.tool(...)`. Safe to call before or after registering tools.
   */
  setPrimalToolNames(names: string[]): void {
    for (const name of names) {
      if (name) this.primalToolNames.add(name);
    }
  }

  /**
   * Resolve the visibility for a tool being registered: an explicit
   * `options.visibility` wins; otherwise fall back to the name allowlist;
   * otherwise default to 'major'.
   */
  private resolveVisibility(name: string, options?: RegisterToolOptions): ToolVisibility {
    if (options?.visibility) return options.visibility;
    return this.primalToolNames.has(name) ? 'primal' : 'major';
  }

  /**
   * Call a 'primal' (hidden) tool's executor directly. Mostly for tests and
   * completeness — the primal brain calls the bot directly, not through tools.
   * Returns an error response for unknown/unregistered names.
   */
  callPrimal(name: string, args: unknown): Promise<McpResponse> {
    const executor = this.primalExecutors.get(name);
    if (!executor) {
      return Promise.resolve(this.createErrorResponse(`Unknown primal tool: ${name}`));
    }
    try {
      return Promise.resolve(executor(args));
    } catch (error) {
      return Promise.resolve(this.createErrorResponse(error as Error));
    }
  }

  /** True when a tool was registered as 'primal' (hidden from the LLM). */
  isPrimalTool(name: string): boolean {
    return this.primalExecutors.has(name);
  }

  registerTool(
    name: string,
    description: string,
    schema: Record<string, unknown>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executor: (args: any) => Promise<McpResponse>,
    options?: RegisterToolOptions
  ): void {
    // PRIMAL (hidden): store the executor but do NOT surface to the LLM.
    if (this.resolveVisibility(name, options) === 'primal') {
      this.primalExecutors.set(name, executor);
      return;
    }

    const fullSchema = {
      ...schema,
      bot: z.string().optional().describe("Bot name to control (defaults to primary bot)")
    };

    this.server.tool(name, description, fullSchema, async (args: unknown): Promise<McpResponse> => {
      const parsed = this.shouldValidateSchema(fullSchema)
        ? this.parseArgs(fullSchema as ZodRawShape, args)
        : (args ?? {});
      const parsedArgs = parsed as Record<string, unknown>;

      const botName = parsedArgs.bot as string | undefined;
      const targetName = botName ?? this.manager.getPrimaryName();

      const connection = this.manager.getConnection(targetName);
      const connectionCheck = await connection.checkConnectionAndReconnect();

      if (!connectionCheck.connected) {
        return {
          content: [{ type: "text", text: connectionCheck.message! }],
          isError: true
        };
      }

      try {
        return await botContext.run(targetName, () => executor(parsedArgs));
      } catch (error) {
        return this.createErrorResponse(error as Error);
      }
    });
  }

  createResponse(text: string): McpResponse {
    return {
      content: [{ type: "text", text }]
    };
  }

  createErrorResponse(error: Error | string): McpResponse {
    const errorMessage = error instanceof Error ? error.message : error;
    return {
      content: [{ type: "text", text: `Failed: ${errorMessage}` }],
      isError: true
    };
  }

  private shouldValidateSchema(schema: Record<string, unknown>): boolean {
    const values = Object.values(schema);
    if (values.length === 0) {
      return true;
    }

    return values.every((value) => value instanceof ZodType);
  }

  private parseArgs(schema: ZodRawShape, args: unknown): unknown {
    try {
      return z.object(schema).passthrough().parse(args ?? {});
    } catch (error) {
      if (error instanceof ZodError) {
        throw new Error(this.formatZodError(error));
      }
      throw error;
    }
  }

  private formatZodError(error: ZodError): string {
    const details = error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
        return `${path}${issue.message}`;
      })
      .join('; ');

    return `Invalid tool arguments: ${details}`;
  }
}

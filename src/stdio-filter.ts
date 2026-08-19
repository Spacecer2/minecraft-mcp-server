// Filters bot console output that would otherwise pollute the MCP stdio
// channel.
//
// mineflayer and other bot libraries log chatty diagnostics through the
// console (console.log / console.info / console.debug). Those writes go to
// stdout and corrupt the JSON-RPC protocol framed on it by the MCP SDK. The
// MCP transport writes its protocol frames directly via process.stdout.write,
// so we never replace that stream — doing so risks mangling framed messages.
// Instead we neutralize the console.* channels bot noise uses, re-routing
// their output to stderr so diagnostics stay visible without touching stdout.
// console.error is left untouched (stderr, not the protocol channel).

const INSTALLED_MARKER = Symbol.for('minecraft-mcp-server.stdio-filter-installed');

function isMarked(fn: unknown): boolean {
  if (typeof fn !== 'function') return false;
  return (fn as unknown as { [key: symbol]: boolean })[INSTALLED_MARKER] === true;
}

function mark(fn: unknown): void {
  (fn as unknown as { [key: symbol]: boolean })[INSTALLED_MARKER] = true;
}

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

export function setupStdioFiltering(): void {
  // Defensive: never throw from startup wiring and never mutate anything when
  // there is no usable environment to install into.
  if (
    typeof process === 'undefined' ||
    typeof process.stdout === 'undefined' ||
    typeof process.stderr === 'undefined' ||
    typeof console === 'undefined'
  ) {
    return;
  }

  // Idempotent: if the filter is already installed, do nothing (no double-wrap).
  if (isMarked(console.log) && isMarked(console.info) && isMarked(console.debug)) {
    return;
  }

  try {
    const write = process.stderr.write.bind(process.stderr);

    const reroute = (): typeof console.log => {
      const wrapped = function (...args: unknown[]): void {
        for (const arg of args) {
          write(`${formatArg(arg)}\n`);
        }
      };
      mark(wrapped);
      return wrapped as typeof console.log;
    };

    console.log = reroute();
    console.info = reroute();
    console.debug = reroute();
  } catch {
    // Best-effort: a failure to install must never crash server startup.
  }
}

/**
 * Cooperative preemption channel.
 *
 * A shared in-process interrupt flag that the watchdog sets to preempt the
 * agent's current action. Long-running, cooperative tools (movement, build
 * loops, plan execution) call `checkInterrupt()` between steps and bail with
 * an `[INTERRUPTED]` response when the flag is set. The watchdog clears it via
 * `clearInterrupt()` once the mode switch has been injected.
 *
 * The design deliberately keeps cancellation *cooperative* (tools check the
 * flag) because MCP tool calls are async and cannot be forcibly aborted from
 * outside without risking a torn response. The watchdog also performs a hard
 * cancel (`bot.pathfinder.stop()`, clear control states) which stops physics,
 * while `checkInterrupt()` makes the current logical step return cleanly.
 */

let interruptFlag: string | null = null;
let reason: string | null = null;

/** Set the interrupt flag. Returns true if it was already set (no-op). */
export function setInterrupt(r: string): boolean {
  if (interruptFlag !== null) return true;
  interruptFlag = 'interrupted';
  reason = r;
  return false;
}

/** True when an interrupt is pending. */
export function isInterrupted(): boolean {
  return interruptFlag !== null;
}

/**
 * If an interrupt is pending, throw an Error whose message starts with
 * `[INTERRUPTED]`. Cooperative tools call this between steps and let the error
 * propagate up to their try/catch, which surfaces the interrupt message.
 */
export function checkInterrupt(): void {
  if (interruptFlag !== null) {
    throw new Error(`[INTERRUPTED] ${reason ?? 'Action cancelled by watchdog'}`);
  }
}

/** The pending interrupt reason, or null. */
export function getInterruptReason(): string | null {
  return reason;
}

/** Clear the interrupt flag (called by the watchdog after injecting the mode switch). */
export function clearInterrupt(): void {
  interruptFlag = null;
  reason = null;
}

/** Convenience: does a thrown error represent an interrupt? */
export function isInterruptError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('[INTERRUPTED]');
}

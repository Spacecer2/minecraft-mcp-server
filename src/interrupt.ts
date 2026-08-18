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
 *
 * Since the watchdog cooperatively interrupts, the channel carries a PRIORITY
 * so that a more important preemption can overwrite a lesser pending one,
 * while same-or-lower priority interrupts are suppressed to avoid
 * interrupt->recover->interrupt thrashing.
 */

/** Precedence of an interrupt. Lower numeric value = higher precedence. */
export enum InterruptPriority {
  /** Safety invariants — hard fatal / unrecoverable state (highest). */
  P0 = 0,
  /** Reflexes / survival — hostiles, lava, fire, drowning, death, chat. */
  P1 = 1,
  /** The currently committed action (min-commitment floor). */
  P2 = 2,
  /** Goal policy — night, inventory-full. */
  P3 = 3,
  /** Background planning / lowest-value preemption. */
  P4 = 4
}

let interruptFlag: string | null = null;
let reason: string | null = null;
let priority: InterruptPriority = InterruptPriority.P1;

/**
 * Set the interrupt flag, subject to priority.
 *
 * - No interrupt pending → always sets.
 * - Pending + STRICTLY HIGHER-priority interrupt → overwrites (upgrades) the
 *   reason and priority.
 * - Pending + SAME-OR-LOWER priority → suppressed (no-op, reason untouched).
 *
 * Returns true if the flag was already set (this call did NOT newly set it —
 * it was suppressed or merely upgraded an existing interrupt), false if this
 * call set it.
 */
export function setInterrupt(r: string, prio: InterruptPriority = InterruptPriority.P1): boolean {
  if (interruptFlag !== null) {
    if (prio < priority) {
      reason = r;
      priority = prio;
    }
    return true;
  }
  interruptFlag = 'interrupted';
  reason = r;
  priority = prio;
  return false;
}

/** True when an interrupt is pending. */
export function isInterrupted(): boolean {
  return interruptFlag !== null;
}

/**
 * True when a pending interrupt already exists and `prio` would NOT preempt it
 * (same or lower priority). Interrupt producers use this to decide whether to
 * bother firing at all.
 */
export function interruptSuppressed(prio: InterruptPriority): boolean {
  return interruptFlag !== null && prio >= priority;
}

/**
 * True when `prio` may preempt the current state: either no interrupt is
 * pending, or the pending one is strictly lower priority.
 */
export function canPreempt(prio: InterruptPriority): boolean {
  return interruptFlag === null || prio < priority;
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

/** The priority of the pending interrupt, or null when none is pending. */
export function getInterruptPriority(): InterruptPriority | null {
  return interruptFlag !== null ? priority : null;
}

/** Clear the interrupt flag (called by the watchdog after injecting the mode switch). */
export function clearInterrupt(): void {
  interruptFlag = null;
  reason = null;
  priority = InterruptPriority.P1;
}

/** Convenience: does a thrown error represent an interrupt? */
export function isInterruptError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('[INTERRUPTED]');
}

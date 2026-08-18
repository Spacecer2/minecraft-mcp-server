# Action Machine — Architecture Specification

Formal specification of the layered agent that controls the Minecraft bot in this
server. This document converts the previously informal "hierarchy of
intelligence" into a rigorous **hierarchy of control authority, interruption
semantics, state ownership, and latency guarantees**. It is the target contract
for implementation; where the current code falls short, the gap is stated
explicitly.

All claims reference the actual implementation:

| Module | Role |
| --- | --- |
| `src/watchdog.ts` | Event-driven preemption watchdog (`EVENT_NAMES`, `EVENT_DRIVEN_EVENT_NAMES`, `EVENT_PRIORITY`, `EVENT_MODES`, `attachEventListeners`, `tick`, `trigger`) |
| `src/interrupt.ts` | Cooperative preemption channel (`setInterrupt`, `isInterrupted`, `checkInterrupt`, `clearInterrupt`, `getInterruptReason`, `isInterruptError`) |
| `src/goal-core.ts` | Generic goal engine (`executeGoal`, `GoalStepResult.intensity`, `needDecision` at intensity >= 3, `WeightedFallback`, `pickBestFallback`) |
| `src/goal-orchestrator.ts` | Parent orchestrator (`orchestrateGoal`, `isDeathInterrupt`, `resumed-after-death`, `watchdog-paused`) |
| `src/utility.ts` | Deterministic utility weighting (`utility`, `bestOption`, `estimateDistance`, `estimateRiskNearby`) |
| `src/tools/task-runner-tools.ts` | Goal planning and the curated catalog (`planGoal`, build/collect/harvest/makeFood/barricade/trade/chest/deliver steps) |

---

## 1. Layer model

The agent is a five-layer stack. Layers are numbered bottom-up: primal instincts
at the bottom, the reasoning cortex at the top. Each layer is characterized by
two axes: **reasoning effort** (cost per decision) and **hardcoding** (the
fraction of behavior that is fixed rather than computed).

### Layer 0 — Actions / Primitives

Mineflayer verbs: move, dig, place, trade, barricade, attack, craft, toss,
equip, pathfinding. Implemented directly against the bot (`bot.pathfinder.goto`,
`bot.dig`, `bot.placeBlock`, `bot.openVillager`, `bot.craft`, `bot.toss`,
`bot.attack`).

- 100% hardcoded. No decision-making; each verb is a leaf capability.
- Reasoning effort: 0. Invoked by name from higher layers.
- Every primitive is required to be interruptible (see Section 7).

### Layer 1 — Watchdog / Reflex

Event-driven preemption. `src/watchdog.ts` scans for impending events (hostile,
creeper, fall, void, lava, low-health, hunger, on-fire, night, drowning,
inventory-full) and reacts to event-driven events (death, reorient, chat) via
mineflayer listeners (`attachEventListeners`).

- Behavior is a hardcoded event-to-cancel mapping: `EVENT_PRIORITY` defines a
  static per-tick ordering; `EVENT_MODES` defines the mode each event switches
  to (`hostile -> defense`, `creeper -> flee`, `void -> escape`, `death ->
  dead`, `chat -> listen`, ...).
- Reasoning effort: ~0. A fired event yields an already-decided directive
  ("CANCEL; switch to DEFENSE/HEAL") — no computation, no weighing.
- When an event fires, `trigger()` increments `triggerCount`, records
  `lastTrigger`, saves `prevMode`, sets the cooperative interrupt via
  `setInterrupt`, and notifies a listener so the directive can be injected into
  the LLM message channel.

### Layer 2 — Goal Engine

The deterministic decision tree. `src/goal-core.ts` runs any `GoalSpec` as an
ordered list of `GoalStep`s (`executeGoal`), and `planGoal` in
`src/tools/task-runner-tools.ts` expands a free-text goal into a curated,
ordered `GoalSpec` (crops -> bread -> deliver resolves dependencies).

- Each step does deterministic fallback internally. Blocked results carry an
  `intensity`:
  - intensity 1–2: recoverable — skip to the next step, or let the step's own
    bounded fallback handle it (e.g. `deliverItemStep` returns `blocked` with
    intensity 2 when the item is missing so the plan can escalate).
  - intensity >= 3: deterministic options exhausted — the engine returns
    `blocked` with a structured `needDecision` (goal, step, reason, context).
- Fallback selection is still arithmetic: `pickBestFallback` chooses the
  highest-utility `WeightedFallback` via `bestOption`.
- Reasoning effort: low. Deterministic control flow, bounded fallback counts
  (`slice(0, 2)` in `makeFoodStep`), a single escalation point at intensity 3.

### Layer 3 — Back Brain / Orchestrator

The parent layer. `src/goal-orchestrator.ts` (`orchestrateGoal`) wraps goal
execution with watchdog awareness: it consults the watchdog before starting,
runs the child plan, and re-checks after each step. It owns the recovery policy:

- standing interrupt before start -> `watchdog-paused` (unless the interrupt is
  a death);
- mid-goal death -> `resumed-after-death` ("report then resume", the bot has
  already auto-respawned);
- any other mid-goal interrupt -> `watchdog-paused`;
- `blocked` with `needDecision` is surfaced upward as an escalation.

Utility weighting lives here. `src/utility.ts` scores options deterministically:

```
utility = (value * importance) / (1 + distanceCost + timeCost + riskCost)
```

with `distanceCost = distanceWeight * (distanceBlocks / 100)`,
`timeCost = timeWeight * (timeSeconds / 120)`,
`riskCost = riskWeight * clamp01(risk)`, and
`DEFAULT_WEIGHTS = { distance: 1, time: 1, risk: 1.5, importanceFloor: 0.1 }`.
`estimateDistance` and `estimateRiskNearby` supply the inputs. This is the
"dopamine" system: cost/benefit among constraint-compliant alternatives, computed
with plain arithmetic.

- Reasoning effort: medium. Deterministic orchestration plus scalar weighting.
  No LLM.

### Layer 4 — Front Brain

The LLM reasoner (the agent model). Free reasoning over the full message
channel. The watchdog listener can inject directives into its channel; the
orchestrator surfaces `needDecision` / `BLOCKED` reports to it; player chat is
routed to it via the `chat` event.

- Reasoning effort: max. Unbounded, generative, expensive.
- Invoked only on escalation: an explicit `needDecision` (intensity >= 3), a
  player command, or a `blocked` plan. It is not in the per-tick hot path.

### Effort / hardcoding balance

| Layer | Hardcoding | Reasoning effort | Cost class |
| --- | --- | --- | --- |
| 0 Primitives | 100% | 0 | free (verbs) |
| 1 Watchdog | ~100% | ~0 | free (event->cancel) |
| 2 Goal Engine | high (catalog + decision tree) | low | bounded fallback, cheap |
| 3 Orchestrator | high (deterministic + utility) | medium | arithmetic only |
| 4 Front Brain | none | max | full LLM reasoning |

Effort stays ~0 at the bottom because instincts are hardcoded. It ramps through
a cheap arithmetic middle (utility weighting is a handful of multiplications).
Only genuinely unresolvable cases buy full reasoning at the top. This is the
core economic property: **intelligence is spent, not assumed.**

---

## 2. The two delegation models

The system supports two control flows, which are distinct in direction, cost, and
timing.

### Model 1 — Goal delegation (top-down: reason -> instinct)

1. Front brain forms a plan (chooses a goal, passes parameters).
2. Back brain orchestrates (`orchestrateGoal`), consulting the watchdog.
3. Goal engine expands the curated catalog (`planGoal` -> ordered `GoalSpec`).
4. Watchdog arms (events enabled; listeners attached).
5. Primitives execute, checking `checkInterrupt` between iterations.

Effort is front-loaded: the expensive decision happens once at the top, then
delegates downward to progressively cheaper, more mechanical machinery.

### Model 2 — Event delegation (bottom-up: instinct -> reason)

1. A primitive/mineflayer event fires (damage, drowning, death, chat).
2. The watchdog reflex cancels the current action instantly (`trigger` ->
   `setInterrupt`, `EVENT_MODES` mode switch).
3. The goal engine marks the goal interrupted (`executeGoal` catches
   `[INTERRUPTED]` and returns `status: 'interrupted'`).
4. The orchestrator resumes: report-then-resume on death (`resumed-after-death`),
   otherwise `watchdog-paused`.
5. The front brain is consulted ONLY if the plan is blocked with no fallback, or
   if the player chats.

Effort is back-loaded: cheap reflexes always fire first; reasoning is deferred
until the deterministic machinery demonstrably cannot proceed.

### Not a pure hierarchy

This is **not** a strictly bottom-up or top-down hierarchy. It is an
**interrupt-driven arbitration system over shared state**. Information flows up
(events, blocked reports, needDecision) and control authority flows in multiple
directions simultaneously: the front brain delegates goals down, the watchdog
preempts everything up from the bottom, and the orchestrator mediates in the
middle. Layers are not a call chain; they are a precedence ladder (Section 3).

---

## 3. Control authority / precedence

The central model. Every actor in the system has a fixed precedence class.
Higher classes win disputes. This is what makes the layered design coherent
instead of just layered.

| Class | Owner | Nature | Example |
| --- | --- | --- | --- |
| **P0** | Safety invariants | Hard constraints (veto, not weighted objectives) | never drown, never die in lava, never void-fall |
| **P1** | Active reflexes | Watchdog interrupts — already-decided responses | creeper flee, on-fire douse, low-health retreat |
| **P2** | Current committed action | Minimum commitment duration before non-P0 preemption | a running build / gather / deliver goal |
| **P3** | Goal policy | Back brain utility selection among constraint-compliant goals | harvest vs. trade vs. chest (weighted) |
| **P4** | Long-term planning | Front brain, only via explicit escalation | which compound goal to pursue |

P0 is qualitatively different from the rest. It is not a weighted objective that
can be traded off against task progress; it is a veto. P0 filters goals **at
selection time**, not only cancels them at runtime: a plan that requires walking
into lava or crossing a void is excluded before it is chosen, and the reflex
(`void`, `lava` in `EVENT_PRIORITY`) remains as a last-line runtime cancel.

P1 are reflexes: the watchdog events that have already been decided
(`EVENT_MODES`). They preempt without consulting any higher layer.

P2 is the current committed action. It is protected by a minimum commitment
duration so that the system does not abandon work at the first mild disturbance.

P3 is policy: the back brain selects among P0-compliant goals by utility. It
never overrides P0.

P4 is planning: the front brain. It cannot inject actions directly; it must go
through delegation (Model 1) and can only be reached by explicit escalation
(Section 5).

### Arbitration rule

> Higher priority wins. P0 may preempt anything, including during the P2
> minimum-commitment window. The minimum commitment protects P2 against
> same- or lower-priority interrupts only.

This single rule prevents layer oscillation. A P2 build in progress cannot be
cancelled by a P3 re-selection (the goal engine does not second-guess a running
commitment); a P1 reflex can cancel a P2 commitment, but only within the
committed window that is deliberately shorter than a P3/P4 deliberation;
P0 trumps everything, always.

---

## 4. Interruption semantics (anti-thrash)

The failure mode this section prevents is **thrash**: interrupt -> recover ->
re-interrupt from the same or similar stimulus, repeatedly, so the agent
oscillates and makes no progress. Six mechanisms form the contract.

| Mechanism | What it does | Why it is needed |
| --- | --- | --- |
| Interrupt priorities | Fixed ordering of event evaluation (`EVENT_PRIORITY`); first fired wins the tick | Resolves same-tick conflicts deterministically; no double-trigger |
| Hysteresis (dead-band / persist >= N ticks) | An event must persist for a minimum number of consecutive ticks before it may trigger | A transient blip (one tick of `fall` velocity, a mob that passes within range) must not cancel a commitment |
| Cooldowns | After a trigger, suppress the same event type for a window | Prevents the same danger from re-interrupting immediately after recovery |
| Minimum commitment durations | P2 actions are protected for a fixed duration against non-P0 preemption | Prevents reflexes from cancelling work that is about to complete |
| Event aggregation | Same-type directives are batched into one directive instead of N | Player spam or multiple hostiles produce one interrupt, not a flood |
| Invalidation vs. resume | A `blocked` goal with no fallback is invalidated (needs `needDecision`); an `interrupted` goal with a live plan is resumable (report-then-resume on death) | Recovery policy is explicit per status, not implicit |

### Current state vs. target contract

Today the code has exactly one of these: a static per-tick `EVENT_PRIORITY`
order. There is **no hysteresis, no cooldown, no minimum commitment duration,
and no aggregation**. `tick()` evaluates events in priority order and the first
that fires triggers immediately; the same condition can re-trigger on the next
tick after recovery. This spec is the target contract those mechanisms are being
added to satisfy. Until then, the system relies on the cooperative interrupt
being cleared and re-armed, which is correct but not thrash-proof.

The cooperative channel itself (`src/interrupt.ts`) is already well-shaped for
this contract: `setInterrupt` is idempotent (returns true if already set),
`checkInterrupt` throws `[INTERRUPTED]` between steps, `clearInterrupt` resets
after mode injection, and `isInterruptError` identifies propagated interrupts.

---

## 5. Escalation rules

Escalation to the front brain is a formal event, not a judgment call. The
current trigger is structural: in `src/goal-core.ts`, a step returning
`blocked` with `intensity >= 3` causes `executeGoal` to emit a structured
`needDecision` (`{ goal, step, reason, context }`); `run-goal` surfaces it as a
`BLOCKED` response. These ad-hoc reasons become the formal criteria below.

| Criterion | Meaning |
| --- | --- |
| `no_applicable_goal` | `planGoal` returns `ok: false` — the goal sentence names nothing in the curated catalog |
| `conflicting_goals` | Two constraint-compliant goals are incomparable by utility (tie or mutually exclusive) |
| `confidence_below_threshold` | Top utility option is below a minimum confidence floor |
| `repeated_execution_failure` | The same step has failed N consecutive times at intensity >= 3 |
| `unexpected_state_transition` | The world state diverged from the layer's model (e.g. pathing invalidated, `reorient`) |
| `excessive_interruptions` | Interrupt frequency exceeds a bound — reflexes are firing faster than recovery |
| `constraint_violation` | A P0 invariant was nearly or actually violated despite the veto (e.g. death) |

When the escalation is emitted, the `needDecision` reason is set to a structured
enum value plus the existing free-form `context` — so the front brain receives a
typed request, not prose. The front brain may also be entered directly by the
`chat` event, which is a standing P1 reflex, not an escalation criterion.

---

## 6. State ownership

All layers currently read live mineflayer state independently:

- `goal-core.ts` reads only the shared interrupt flag.
- `goal-orchestrator.ts` reads only `isInterrupted()` /
  `getInterruptReason()`.
- `utility.ts` reads `bot.entity.position`, `bot.entities`, and inventory live.
- The goal steps read inventory, blocks, and entities live (`bot.inventory`,
  `bot.blockAt`, `bot.findBlock`, `bot.nearestEntity`).
- `watchdog.ts` reads entity positions, health, food, velocity, blocks live.

This is the **stale-state risk**: independent interpretations of reality can
disagree (utility believes the bot is at X while a step believes it is at Y;
the watchdog's threat assessment races a step's inventory check), and each read
carries its own latency and failure mode.

### The contract

- **One authoritative world-state snapshot**, owned by the control core (the
  watchdog layer), updated every tick. All layers read from it; none maintain an
  independent model of reality.
- Each layer keeps a **layer-specific working memory** layered on top of the
  snapshot: the watchdog's `mode`/`prevMode`/`lastTrigger`/`triggerCount`; the
  goal engine's `GoalContext.report` list and per-step `context`; the
  orchestrator's status transitions; `taskRuns` in task-runner-tools.
- Working memory is derived state, never a second reality. A layer may cache
  facts for its own window but must reconcile against the authoritative snapshot
  before acting on them.
- The interrupt flag is shared state with a single writer (`setInterrupt`) and
  a single clearing path (`clearInterrupt`), keeping the arbitration channel
  free of torn updates.

---

## 7. Latency budgets

These are **budgets, not benchmarks** — stated targets the implementation must
stay inside. They are monotone non-decreasing with altitude: higher layers are
allowed to think longer because they think less often.

| Layer | Response budget | Bound type |
| --- | --- | --- |
| 0 Primitives | <= 1 tick | soft |
| 1 Watchdog | <= 1–2 ticks | **hard** |
| 2 Goal Engine | <= 10 ticks | soft |
| 3 Back Brain | <= 1 s | soft (arithmetic, no LLM) |
| 4 Front Brain | <= 5 s | soft (escalated only) |

### Guarantees

- **Safety-critical paths (P0/P1) are hard-bounded to 1–2 ticks.** The
  event-driven listeners in `attachEventListeners` (`death`, `health`,
  `entityHurt`, `forcedMove`, `breath`) fire the instant the mineflayer event
  fires — no polling latency. The polled `tick()` loop (default `intervalMs =
  500`) is the fallback for events with no listener (`lava`, `fall`, `void`,
  `night`, `hunger`, `inventory-full`). "Hard bound" means the watchdog must
  never wait on a higher layer's deliberation.
- **Interruptibility contract:** every executable primitive must be interruptible
  within N ticks (N small, ~1–2). This is enforced cooperatively:
  `checkInterrupt()` is a checkpoint at each iteration/step (`executeGoal` before
  and after each step; `run-task-step` before each block placement), plus hard
  movement stops via `bot.pathfinder.stop()` / clearing control states — the
  comment in `src/interrupt.ts` explicitly distinguishes the cooperative stop
  (clean logical return) from the hard stop (physics halt).
- The cooperative design exists because MCP tool calls are async and cannot be
  forcibly aborted without risking a torn response. The budget applies to the
  *decision to interrupt*, not to a torn in-flight call: primitives expose
  checkpoints so the logical step returns cleanly within the budget.

### Interruptibility contract (formal)

> Every primitive is annotated with an interruptibility bound N (ticks): the
> maximum time between a pending interrupt being set and the primitive either
> returning an `[INTERRUPTED]` result or halting physics. The watchdog relies on
> this bound to meet its hard 1–2 tick guarantee. A primitive that cannot bound
> its interruption must not run inside the P2 committed window.

---

## 8. Back Brain vs. Goal Engine boundary

These are **not redundant**. They are three roles split across two modules plus
the catalog:

| Role | Owner | Responsibility |
| --- | --- | --- |
| Selection / escalation (parent) | `goal-orchestrator.ts` | Chooses whether to run a goal (watchdog guard), runs it, maps outcomes (`watchdog-paused`, `resumed-after-death`, `blocked`), and decides what reaches the front brain |
| Engine / execution | `goal-core.ts` | Executes an ordered `GoalSpec` deterministically: per-step run, bounded fallback, intensity bookkeeping, single escalation point (`needDecision` at intensity >= 3) |
| Catalog expansion | `planGoal` in `task-runner-tools.ts` | Converts a free-text goal sentence into a curated, ordered `GoalSpec`; owns the known step repertoire (build, collect, harvest, makeFood, barricade, trade, chest, deliver) |

- `orchestrateGoal` **owns** the watchdog interface and the recovery policy. It
  is the only caller of `executeGoal` from the tool layer (`run-goal`).
- `executeGoal` **owns** execution semantics but knows nothing about the
  watchdog beyond the interrupt flag it already consumes.
- `planGoal` **owns** what goals exist; `executeGoal` is agnostic to catalog
  content (any `GoalSpec` works).
- **Escalation authority:** the goal engine may emit `needDecision`; the
  orchestrator decides whether to surface it (mapping `blocked` up, converting
  death-interrupts to `resumed-after-death`, non-death interrupts to
  `watchdog-paused`). The front brain is never reached by the engine directly.

Why the split matters: the engine stays small and testable (a pure executor),
the orchestrator stays the single place where watchdog-awareness and recovery
policy live, and the catalog stays the single place where new goals are added.

---

## 9. Testing / verification expectations

The architecture is an empirical claim: a layered interrupt-driven agent
outperforms both a monolithic LLM agent and a hierarchical agent without
interruption. It must be proven, not asserted.

### Experimental comparison

| Arm | Configuration |
| --- | --- |
| A | Monolithic LLM agent — the model drives every primitive directly, no watchdog, no goal engine |
| B | Hierarchical without interrupts — layers exist but the watchdog is disabled; goals run to completion or failure |
| C | Full Action Machine — this architecture as specified |

### Metrics

| Metric | What it measures |
| --- | --- |
| Reaction latency | Time from a P0/P1 stimulus to the interrupt taking effect (tick count) |
| Survival rate | Fraction of episodes without death (P0 compliance) |
| Task completion | Fraction of delegated goals that reach `done` |
| Long-horizon success | Compound goals (e.g. crops -> bread -> deliver) completing end-to-end |
| LLM calls / min | Cost proxy; must be near zero under nominal conditions |
| Tokens | Per-episode reasoning spend; must concentrate at escalation points |
| Recovery time | Time from interrupt to a resumed goal (`watchdog-paused` -> `resumed-after-death`) |
| Goal thrash count | Number of abort/re-plan cycles per episode (Section 4 anti-thrash) |
| Behavior under high event frequency | A stress episode (hostiles + low health + night + chat) where reflexes dominate |

### Expected result and honest caveat

C must dominate A on reaction latency, survival, thrash count, and LLM cost, and
dominate B on survival and long-horizon success. A may still win raw task
completion on trivially benign episodes (no interruptions) because it can
improvise where the catalog is rigid.

The architecture can fail under exactly the chaotic conditions it is designed
for: if event frequency exceeds the hysteresis/cooldown recovery rates, or if
the catalog is too small to cover the goals the front brain delegates, the
agent degrades to perpetual interrupt/recover cycling. The stress metric above
exists to detect precisely this. A passing evaluation must therefore include a
high-frequency event stress episode and report thrash count and recovery time,
not just average survival.

---

## Appendix A — Key invariants

1. P0 filters goals at selection time and vetoes at runtime; it is never a
   weighted objective.
2. Arbitration is strict: higher priority wins; only P0 preempts during the
   minimum-commitment window.
3. The front brain is reachable only by explicit escalation, player chat, or a
   surfaced `needDecision` — never by the per-tick path.
4. There is exactly one authoritative world-state snapshot; layers derive
   working memory, never an independent reality.
5. P0/P1 response is hard-bounded to 1–2 ticks; every primitive carries an
   interruptibility bound the watchdog may rely on.
6. A `needDecision` is a typed escalation reason plus context, not prose.
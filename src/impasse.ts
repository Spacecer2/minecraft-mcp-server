/**
 * impasse.ts — SOAR-style impasse handler (L4).
 *
 * When a goal blocks (BLOCKED at intensity >= 3 / needDecision), the handler
 * restates the problem: diagnose WHY it blocked, create a subgoal that ONLY
 * removes the blockage, and on success CHUNK (context->fix) into a cached
 * lesson. If the subgoal also fails, escalate: mark the goal blocked, suggest
 * a backup goal, and log the lesson.
 *
 * Pure so it is unit-testable without a bot; chunked lessons are fed back
 * into postmortem.lessonStore by the caller.
 */

import type { Lesson } from './postmortem.js';

export interface BlockedInfo {
  goal: string;
  step?: string;
  reason: string;
  context?: Record<string, unknown>;
}

export type DiagnosisKind =
  | 'missing_prerequisite'
  | 'path_invalidated'
  | 'resource_absent'
  | 'constraint_violation';

export interface Diagnosis {
  kind: DiagnosisKind;
  goal: string;
  reason: string;
  /** Human-readable explanation of why the goal blocked. */
  detail?: string;
}

export interface Subgoal {
  goal: string;
  /** The subgoal text that ONLY removes the blockage. */
  action: string;
  diagnosis: Diagnosis;
}

export interface Escalation {
  goal: string;
  blocked: true;
  /** Suggested backup goal after the subgoal also failed. */
  backupGoal: string;
  lesson: Lesson;
}

/**
 * Diagnose WHY a goal blocked, based on the blocked info + world state.
 * Matches the blocked reason / context to a DiagnosisKind.
 */
export function diagnoseImpasse(blocked: BlockedInfo, _worldState?: Record<string, unknown>): Diagnosis {
  const reason = (blocked.reason ?? '').toLowerCase();
  const ctx = blocked.context ?? {};
  const goal = blocked.goal;

  if (reason.includes('constraint') || reason.includes('safety') || reason.includes('violation') || ctx.violated) {
    return {
      kind: 'constraint_violation',
      goal,
      reason: blocked.reason,
      detail: 'A safety invariant is violated; the goal cannot safely proceed.'
    };
  }
  if (reason.includes('prerequisite') || reason.includes('require') || reason.includes('craft') || reason.includes('unlock') || reason.includes('need')) {
    return {
      kind: 'missing_prerequisite',
      goal,
      reason: blocked.reason,
      detail: 'A required prerequisite is missing before this step can run.'
    };
  }
  if (reason.includes('path') || reason.includes('unreachable') || reason.includes('blocked') || reason.includes('wall') || reason.includes('no route')) {
    return {
      kind: 'path_invalidated',
      goal,
      reason: blocked.reason,
      detail: 'The path to the objective has been invalidated.'
    };
  }
  return {
    kind: 'resource_absent',
    goal,
    reason: blocked.reason,
    detail: 'A required resource is absent or depleted in the world.'
  };
}

/**
 * Create a subgoal that ONLY removes the blockage described by the diagnosis.
 * It must not re-achieve the whole goal — just unblock the failing step.
 */
export function makeSubgoal(goal: string, diagnosis: Diagnosis): Subgoal {
  const detail = diagnosis.detail ?? diagnosis.reason;
  switch (diagnosis.kind) {
    case 'missing_prerequisite':
      return {
        goal,
        action: `obtain the missing prerequisite (${detail})`,
        diagnosis
      };
    case 'path_invalidated':
      return {
        goal,
        action: `find or build an alternative path (${detail})`,
        diagnosis
      };
    case 'constraint_violation':
      return {
        goal,
        action: `resolve the violated safety invariant (${detail})`,
        diagnosis
      };
    case 'resource_absent':
    default:
      return {
        goal,
        action: `gather the absent resource (${detail})`,
        diagnosis
      };
  }
}

/**
 * On subgoal success, CHUNK (context->fix) into a cached rule and return a
 * Lesson to feed postmortem.lessonStore. Returns null when the subgoal did
 * not succeed (nothing to chunk).
 */
export function chunkLesson(
  goal: string,
  diagnosis: Diagnosis,
  subgoal: Subgoal,
  success: boolean
): Lesson | null {
  if (!success) return null;
  const ifState = `IF goal=${goal} AND blocked_by=${diagnosis.kind}`;
  return {
    id: `chunk_${goal}_${diagnosis.kind}`,
    goal,
    ifState,
    thenMitigation: subgoal.action,
    sourceEpisodeId: goal,
    provisional: true,
    confidence: 0.6,
    cause: diagnosis.kind
  };
}

/**
 * On subgoal failure, escalate: mark the goal blocked, suggest a backup goal,
 * and log a lesson so the failure is recorded as tuition.
 */
export function escalate(goal: string, diagnosis: Diagnosis, backupGoal?: string): Escalation {
  const lesson: Lesson = {
    id: `escalate_${goal}_${diagnosis.kind}`,
    goal,
    ifState: `IF goal=${goal} AND blocked_by=${diagnosis.kind}`,
    thenMitigation: `fall back to ${backupGoal ?? 'passive survival'}`,
    sourceEpisodeId: goal,
    provisional: true,
    confidence: 0.4,
    cause: diagnosis.kind
  };
  return {
    goal,
    blocked: true,
    backupGoal: backupGoal ?? 'passive survival',
    lesson
  };
}

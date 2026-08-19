import test from 'ava';
import {
  diagnoseImpasse,
  makeSubgoal,
  chunkLesson,
  escalate,
  BlockedInfo
} from '../src/impasse.js';

function blocked(overrides: Partial<BlockedInfo> = {}): BlockedInfo {
  return {
    goal: 'mine_iron',
    step: 'dig',
    reason: 'no_wheat_available',
    context: { missing: 'wheat' },
    ...overrides
  };
}

test('diagnoseImpasse: missing prerequisite', (t) => {
  const d = diagnoseImpasse(blocked({ reason: 'requires a stone pickaxe first' }));
  t.is(d.kind, 'missing_prerequisite');
});

test('diagnoseImpasse: path invalidated', (t) => {
  const d = diagnoseImpasse(blocked({ reason: 'path blocked by lava' }));
  t.is(d.kind, 'path_invalidated');
});

test('diagnoseImpasse: constraint violation', (t) => {
  const d = diagnoseImpasse(blocked({ reason: 'constraint_violation', context: { violated: ['low-health'] } }));
  t.is(d.kind, 'constraint_violation');
});

test('diagnoseImpasse: resource absent by default', (t) => {
  const d = diagnoseImpasse(blocked({ reason: 'no iron ore nearby' }));
  t.is(d.kind, 'resource_absent');
});

test('makeSubgoal: only removes the blockage', (t) => {
  const d = diagnoseImpasse(blocked({ reason: 'requires a stone pickaxe first' }));
  const sub = makeSubgoal('mine_iron', d);
  t.is(sub.goal, 'mine_iron');
  t.true(sub.action.includes('prerequisite'));
  t.false(sub.action.includes('mine_iron'));
});

test('makeSubgoal: gathers absent resource', (t) => {
  const d = diagnoseImpasse(blocked({ reason: 'no iron ore nearby' }));
  const sub = makeSubgoal('mine_iron', d);
  t.true(sub.action.includes('gather'));
});

test('chunkLesson: produces a cached rule on success', (t) => {
  const d = diagnoseImpasse(blocked({ reason: 'requires a stone pickaxe first' }));
  const sub = makeSubgoal('mine_iron', d);
  const lesson = chunkLesson('mine_iron', d, sub, true);
  t.truthy(lesson);
  t.is(lesson!.goal, 'mine_iron');
  t.true(lesson!.ifState.includes('blocked_by=missing_prerequisite'));
  t.is(lesson!.thenMitigation, sub.action);
});

test('chunkLesson: returns null when subgoal failed', (t) => {
  const d = diagnoseImpasse(blocked());
  const sub = makeSubgoal('mine_iron', d);
  t.is(chunkLesson('mine_iron', d, sub, false), null);
});

test('escalate: marks goal blocked and logs a lesson', (t) => {
  const d = diagnoseImpasse(blocked());
  const esc = escalate('mine_iron', d, 'go_home');
  t.is(esc.goal, 'mine_iron');
  t.true(esc.blocked);
  t.is(esc.backupGoal, 'go_home');
  t.truthy(esc.lesson);
  t.true(esc.lesson.thenMitigation.includes('go_home'));
});

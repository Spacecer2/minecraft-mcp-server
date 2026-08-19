import test from 'ava';
import {
  classifyFailure,
  attributeCause,
  generateLesson,
  injectGuards,
  lessonStore,
  FailureEpisode,
  GuardRule
} from '../src/postmortem.js';

function episode(overrides: Partial<FailureEpisode> = {}): FailureEpisode {
  return {
    goal: 'mine_iron',
    plan: 'mine_iron_v1',
    stateSnapshot: { health: 4 },
    outcome: 'death',
    observedCause: 'cave_without_light',
    isRandom: false,
    candidateGuards: ['torch_in_cave'],
    ...overrides
  };
}

test('classifyFailure: random death yields random (no lesson)', (t) => {
  const e = episode({ observedCause: 'random unlucky creeper spawn', isRandom: true });
  t.is(classifyFailure(e), 'random');
});

test('classifyFailure: rng marker yields random even without flag', (t) => {
  const e = episode({ observedCause: 'probabilistic mob spawn noise' });
  t.is(classifyFailure(e), 'random');
});

test('classifyFailure: preventable cause yields preventable', (t) => {
  const e = episode({ observedCause: 'fell into void with no guard' });
  t.is(classifyFailure(e), 'preventable');
});

test('classifyFailure: unknown cause defaults to mitigable', (t) => {
  const e = episode({ observedCause: 'resource ran out mid-mine' });
  t.is(classifyFailure(e), 'mitigable');
});

test('attributeCause: picks the cheapest matching guard', (t) => {
  const e = episode({ observedCause: 'fell into a ravine' });
  const rules: GuardRule[] = [
    { id: 'bridge_ravine', cause: 'ravine', cost: 6, generality: 2 },
    { id: 'carry_bridge_material', cause: 'ravine', cost: 1, generality: 2 }
  ];
  t.is(attributeCause(e, rules), 'carry_bridge_material');
});

test('attributeCause: prefers world-mechanics over agent-specific', (t) => {
  const e = episode({ observedCause: 'durability break mid-cave' });
  const rules: GuardRule[] = [
    { id: 'agent_dont_overextend', cause: 'durability', cost: 1, generality: 1, agentSpecific: true },
    { id: 'swap_tool_before_break', cause: 'durability', cost: 2, generality: 3 }
  ];
  t.is(attributeCause(e, rules), 'swap_tool_before_break');
});

test('attributeCause: prefers the most general rule', (t) => {
  const e = episode({ observedCause: 'no torch in cave' });
  const rules: GuardRule[] = [
    { id: 'torch_this_cave', cause: 'cave', cost: 1, generality: 1 },
    { id: 'torch_any_cave', cause: 'cave', cost: 1, generality: 5 }
  ];
  t.is(attributeCause(e, rules), 'torch_any_cave');
});

test('attributeCause: returns null when no rule matches', (t) => {
  const e = episode({ observedCause: 'fell into a ravine' });
  const rules: GuardRule[] = [{ id: 'torch_any_cave', cause: 'cave', cost: 1, generality: 1 }];
  t.is(attributeCause(e, rules), null);
});

test('generateLesson: produces a provisional lesson', (t) => {
  const e = episode();
  const lesson = generateLesson(e, 'place torches before entering', 'torch_in_cave');
  t.true(lesson.provisional);
  t.is(lesson.thenMitigation, 'place torches before entering');
  t.is(lesson.sourceEpisodeId, 'mine_iron_v1');
  t.true(lesson.ifState.includes('IF goal=mine_iron'));
  t.is(lesson.confidence, 0.5);
});

test('lessonStore: recordLesson + getLessonCount', (t) => {
  lessonStore.resetPostmortemForTest();
  lessonStore.recordLesson(generateLesson(episode(), 'place torch'));
  t.is(lessonStore.getLessonCount(), 1);
});

test('lessonStore: promoteLesson flips provisional on replication', (t) => {
  lessonStore.resetPostmortemForTest();
  const lesson = generateLesson(episode(), 'place torch');
  lessonStore.recordLesson(lesson);
  lessonStore.replicateLesson(lesson.id);
  lessonStore.replicateLesson(lesson.id);
  const stored = lessonStore.lessonsFor('mine_iron').find((l) => l.id === lesson.id)!;
  t.false(stored.provisional);
});

test('lessonStore: lessonsFor filters by goal', (t) => {
  lessonStore.resetPostmortemForTest();
  lessonStore.recordLesson(generateLesson(episode(), 'a'));
  lessonStore.recordLesson(generateLesson(episode({ goal: 'build_house' }), 'b'));
  t.is(lessonStore.lessonsFor('mine_iron').length, 1);
});

test('injectGuards: adds learned guards for matching goal', (t) => {
  const a = generateLesson(episode(), 'place torch');
  a.provisional = false;
  const b = generateLesson(episode({ goal: 'build_house' }), 'unrelated');
  const guards = injectGuards('mine_iron', [a, b]);
  t.is(guards.length, 1);
  t.is(guards[0].thenMitigation, 'place torch');
  t.is(guards[0].lessonId, a.id);
});

test('injectGuards: returns empty when no lessons match', (t) => {
  const b = generateLesson(episode({ goal: 'build_house' }), 'unrelated');
  t.deepEqual(injectGuards('mine_iron', [b]), []);
});

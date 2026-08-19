import test from 'ava';
import {
  estimatePDeath,
  evaluateRisk,
  stateDependentParams,
  withinDeathBudget,
  ucbBonus,
  acceptableDeathEnvelope
} from '../src/risk-evaluator.js';

test('estimatePDeath: lower HP -> higher pDeath (monotonic)', (t) => {
  const low = estimatePDeath({ health: 2 });
  const mid = estimatePDeath({ health: 10 });
  const full = estimatePDeath({ health: 20 });
  t.true(low > mid);
  t.true(mid > full);
  t.true(full < 0.3);
});

test('estimatePDeath: safe+healthy is low', (t) => {
  const p = estimatePDeath({
    health: 20,
    nearestHostileDist: 50,
    night: false,
    exposed: false,
    armor: 0.8
  });
  t.true(p < 0.2);
});

test('estimatePDeath: starving/low-health + exposed is high', (t) => {
  const p = estimatePDeath({ health: 1, night: true, exposed: true, armor: 0 });
  t.true(p > 0.5);
});

test('estimatePDeath: lethal dangers dominate to 1', (t) => {
  t.is(estimatePDeath({ health: 20, inVoid: true }), 1);
  t.is(estimatePDeath({ health: 20, onFire: true }), 1);
  t.is(estimatePDeath({ health: 20, lavaNearby: true }), 1);
  t.is(estimatePDeath({ health: 20, drowning: true }), 1);
});

test('evaluateRisk: healthy bot refuses a risky high-anchor option (loss aversion)', (t) => {
  // Same risky option, high λ/κ: the risk + uncertainty terms crush the score.
  const score = evaluateRisk({
    gain: 0.9,
    pDeath: 0.2,
    deathCost: 0.2,
    risk: 0.9,
    uncertainty: 0.3,
    lambda: 2,
    kappa: 1.5,
    ucbBonus: 0
  });
  t.true(score < 0);
});

test('evaluateRisk: starving bot accepts the same option (risk-seeking)', (t) => {
  // Identical inputs, only λ/κ flipped (state-dependent): low λ lets the
  // expected gain dominate -> positive score.
  const score = evaluateRisk({
    gain: 0.9,
    pDeath: 0.2,
    deathCost: 0.2,
    risk: 0.9,
    uncertainty: 0.3,
    lambda: 0.4,
    kappa: 0.5,
    ucbBonus: 0
  });
  t.true(score > 0);
});

test('evaluateRisk: safe option scores high, ucbBonus adds on top', (t) => {
  const base = evaluateRisk({
    gain: 1,
    pDeath: 0.05,
    deathCost: 1,
    risk: 0.1,
    uncertainty: 0.1,
    lambda: 2,
    kappa: 1.5,
    ucbBonus: 0
  });
  const withUcb = evaluateRisk({
    gain: 1,
    pDeath: 0.05,
    deathCost: 1,
    risk: 0.1,
    uncertainty: 0.1,
    lambda: 2,
    kappa: 1.5,
    ucbBonus: 0.5
  });
  t.true(base > 0);
  t.true(withUcb > base);
});

test('stateDependentParams: safe+healthy is risk-averse (high lambda)', (t) => {
  const p = stateDependentParams({ health: 18, food: 18, safetyCapital: 0.8 });
  t.true(p.lambda > 1);
});

test('stateDependentParams: starving flips to risk-seeking (low lambda)', (t) => {
  const p = stateDependentParams({ health: 16, food: 2, safetyCapital: 0.8 });
  t.true(p.lambda < 1);
});

test('stateDependentParams: death budget scales with safety capital', (t) => {
  const poor = stateDependentParams({ health: 10, food: 10, safetyCapital: 0.2 });
  const rich = stateDependentParams({ health: 10, food: 10, safetyCapital: 0.9 });
  t.true(rich.deathBudget >= poor.deathBudget);
});

test('withinDeathBudget: clamps and respects threshold', (t) => {
  t.true(withinDeathBudget(0.1, 0.3));
  t.false(withinDeathBudget(0.5, 0.3));
  t.true(withinDeathBudget(1, 1));
  t.false(withinDeathBudget(0.9, 0.5));
});

test('ucbBonus: decays with visits, grows with total plays and constant', (t) => {
  const visited = ucbBonus(10, 50, 2);
  const fresh = ucbBonus(0, 50, 2);
  t.true(visited < fresh); // exploring a well-visited arm pays less

  const morePlays = ucbBonus(0, 1000, 2);
  t.true(morePlays > fresh); // more total plays -> more room to explore

  const higherC = ucbBonus(0, 50, 4);
  t.true(higherC > fresh); // higher exploration constant -> bigger bonus
});

test('acceptableDeathEnvelope: gear widens the envelope', (t) => {
  const geared = acceptableDeathEnvelope({ health: 20, armor: 0.8, tools: 0.9 });
  const naked = acceptableDeathEnvelope({ health: 20, armor: 0, tools: 0.2 });
  t.true(geared.acceptablePDeath > naked.acceptablePDeath);
});

test('acceptableDeathEnvelope: low health marks guarded and risk-seeking', (t) => {
  const e = acceptableDeathEnvelope({ health: 3, armor: 0, tools: 0.2 });
  t.true(e.guarded);
  t.is(e.riskAttitude, 'risk-seeking');
});

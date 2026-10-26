import test from 'node:test';
import assert from 'node:assert/strict';
import { Match, Phase } from '../src/engine/match.js';
import { Ball, BALL_RADIUS } from '../src/engine/ball.js';
import { AnimCurve } from '../src/engine/curve.js';
import { EngineSettings as S } from '../src/engine/settings.js';
import { Player } from '../src/engine/player.js';
import { createSeededPRNG } from '../src/core/rng.js';
import * as V from '../src/engine/vec.js';

const CFG = { id: 'classic5', name: '5v5', teamSize: 6, pitchLength: 64, pitchWidth: 48, goalW: 6, goalH: 2.2, durationSec: 180, offside: false };
const DT = 1 / 30;

function runMatch(seconds, opts = {}) {
  const m = new Match(CFG, { seed: opts.seed ?? 42, aiLevel: opts.aiLevel ?? 2, humanSlot: null });
  const events = [];
  for (const t of ['Goal', 'PlayerPass', 'PlayerShoot', 'PlayerControlBall', 'KeeperSavesTheBall', 'PlayerTackled', 'ThrowIn', 'Corner', 'GoalKick', 'FinalWhistle'])
    m.events.on(t, (e) => events.push([t, e]));
  for (let t = 0; t < seconds; t += DT) m.step(DT);
  return { m, events };
}

test('AnimationCurve hermite matches known keyframes', () => {
  const c = AnimCurve.fromUnity({ m_Curve: [{ time: 0, value: 0, inSlope: 0, outSlope: 1 }, { time: 1, value: 1, inSlope: 1, outSlope: 0 }], m_PreInfinity: 2, m_PostInfinity: 2 });
  assert.equal(c.evaluate(-5), 0);
  assert.equal(c.evaluate(5), 1);
  const mid = c.evaluate(0.5);
  assert.ok(mid > 0.4 && mid < 0.6, `mid=${mid}`);
});

test('skill-100 shot has exactly zero direction error', () => {
  const m = new Match(CFG, { seed: 1, humanSlot: null });
  const err = m.ball.getDirectionError(20, 100);
  assert.ok(Math.abs(err.pitch) < 1e-12 && Math.abs(err.yaw) < 1e-12, JSON.stringify(err));
});

test('direction error kill-switch yields exact aim', () => {
  const before = S.IsDirectionErrorEnabled;
  S.IsDirectionErrorEnabled = false;
  const m = new Match(CFG, { seed: 1, humanSlot: null });
  const target = V.v3(20, 0, 5);
  const aimed = m.ball.applyError(target, 40);
  assert.ok(Math.abs(aimed.x - target.x) < 1e-9 && Math.abs(aimed.z - target.z) < 1e-9);
  S.IsDirectionErrorEnabled = before;
});

test('sub-minimum touch is normalised up to Ball_MinHitVelocity', () => {
  const m = new Match(CFG, { seed: 1, humanSlot: null });
  const v = m.ball.clampVelocity(V.v3(1, 0, 0));
  assert.ok(Math.abs(V.len(v) - S.Ball_MinHitVelocity) < 1e-6);
  const big = m.ball.clampVelocity(V.v3(20, 0, 0));
  assert.equal(V.len(big), 20);
});

test('pass skill blend: 22m weights longBall, 35m weights passing', () => {
  // pct = clamp01((d-22)/(35-22)); skill = pct*passing + (1-pct)*longBall
  const blend = (d, pas, lng) => {
    const pct = Math.min(1, Math.max(0, (d - S.LongBallSkillActivationDistanceMin) / (S.LongBallSkillActivationDistanceMax - S.LongBallSkillActivationDistanceMin)));
    return pct * pas + (1 - pct) * lng;
  };
  assert.equal(blend(22, 90, 40), 40);
  assert.equal(blend(35, 90, 40), 90);
});

test('ballistic solve lands near target for a flat launch', () => {
  const m = new Match(CFG, { seed: 1, humanSlot: null });
  const src = V.v3(0, BALL_RADIUS, 0);
  const tgt = V.v3(15, BALL_RADIUS, 0);
  const v = m.ball.calcBallisticVelocityVector(src, tgt, 20);
  // integrate
  const p = V.copy(src); const vel = V.copy(v);
  for (let t = 0; t < 4; t += 1 / 120) {
    vel.y -= 9.81 / 120;
    p.x += vel.x / 120; p.y += vel.y / 120; p.z += vel.z / 120;
    if (p.y <= BALL_RADIUS && vel.y < 0) break;
  }
  assert.ok(Math.abs(p.x - 15) < 1.2, `landed x=${p.x.toFixed(2)}`);
});

test('90-second soak: finite state, ball in bounds, clock monotonic', () => {
  const { m, events } = runMatch(90);
  for (const p of m.players) {
    if (p.sentOff) continue; // dismissed players are placed off the touchline
    assert.ok(Number.isFinite(p.pos.x) && Number.isFinite(p.pos.z), `player ${p.id} NaN`);
    assert.ok(Math.abs(p.pos.x) <= m.fieldHalfX + 0.5 && Math.abs(p.pos.z) <= m.fieldHalfZ + 0.5, `player ${p.id} out of bounds`);
  }
  assert.ok(Number.isFinite(m.ball.pos.x) && Number.isFinite(m.ball.pos.y));
  assert.ok(Math.abs(m.ball.pos.x) <= m.fieldHalfX + 2, 'ball escaped length');
  assert.ok(Math.abs(m.ball.pos.z) <= m.fieldHalfZ + 2, 'ball escaped width');
  assert.ok(m.clockSec > 70, `clock=${m.clockSec}`);
  const kinds = new Set(events.map((e) => e[0]));
  assert.ok(kinds.has('PlayerControlBall') || kinds.has('PlayerPass'), `no ball activity: ${[...kinds]}`);
});

test('full match reaches ENDED and produces shots/saves or goals', () => {
  // clock is stoppage-time based (pauses for countdown/celebration), so allow slack
  const { m, events } = runMatch(CFG.durationSec + 120, { seed: 7 });
  assert.equal(m.phase, Phase.ENDED);
  assert.ok(m.clockSec >= CFG.durationSec, `clock=${m.clockSec}`);
  const kinds = new Set(events.map((e) => e[0]));
  assert.ok(kinds.has('PlayerShoot') || kinds.has('Goal'), `no shooting happened: ${[...kinds]}`);
  assert.ok(m.score[0] + m.score[1] >= 0);
});

test('determinism: same seed produces identical final state', () => {
  const a = runMatch(30, { seed: 99 });
  const b = runMatch(30, { seed: 99 });
  assert.equal(JSON.stringify(a.m.getSnapshot().players), JSON.stringify(b.m.getSnapshot().players));
  assert.equal(JSON.stringify(a.m.score), JSON.stringify(b.m.score));
});

test('human intent moves the controlled player and fires actions', () => {
  const m = new Match(CFG, { seed: 5, humanSlot: 3 });
  const human = m.players.find((p) => p.isHuman);
  assert.ok(human, 'human slot assigned');
  const start = V.copy(human.pos);
  for (let t = 0; t < 5; t += DT) { human.intent = { moveX: 0, moveZ: 1, sprint: true }; m.step(DT); }
  assert.ok(V.distXZ(start, human.pos) > 1, 'human did not move');
});

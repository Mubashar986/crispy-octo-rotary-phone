import test from 'node:test';
import assert from 'node:assert/strict';
import { Match, Phase } from '../src/engine/match.js';
import { MODE_CONFIGS } from '../src/config/modes.js';
import { MoveMode } from '../src/engine/player.js';
import * as V from '../src/engine/vec.js';

function makeMatch() {
  const m = new Match(MODE_CONFIGS.classic5, { seed: 21, humanSlot: null, aiLevel: 0 });
  m.phase = Phase.LIVE;
  m.time = 10;
  m.freezeUntil = 0;
  m.setPiece = null;
  const p = m.players.find((q) => !q.isGoalKeeper && q.team === 0);
  p.setInstantPosition(0, 0, 0);
  p.facing = 0;
  return { m, p };
}

function dribble(mode, speed, seconds = 2) {
  const { m, p } = makeMatch();
  p.moveMode = mode;
  p.vx = speed; p.vz = 0; p.speed = speed; p.facing = 0;
  m.ball.reset({ x: 0.4, y: 0.11, z: 0 });
  m.ball.hold(p);
  let touches = 0, maxDist = 0, minDist = Infinity;
  m.events.on('PlayerDribbleTouch', () => touches++);
  const dt = 1 / 30;
  for (let i = 0; i < seconds * 30; i++) {
    p.pos.x += speed * dt;
    p.vx = speed; p.vz = 0; p.speed = speed;
    m.time += dt;
    m.ball.step(dt);
    const d = V.distXZ(m.ball.pos, p.pos);
    maxDist = Math.max(maxDist, d);
    minDist = Math.min(minDist, d);
  }
  return { m, p, touches, maxDist, minDist, holder: m.ball.holder === p };
}

test('possessed dribbling is a sequence of touches, not a magnetic lead point', () => {
  const r = dribble(MoveMode.Normal, 4, 3);
  assert.ok(r.holder, 'possession should be retained at normal pace');
  assert.ok(r.touches >= 5, `expected several touches, got ${r.touches}`);
  assert.ok(r.maxDist > 0.3 && r.maxDist < 1.8, `ball separation max=${r.maxDist.toFixed(2)}`);
  assert.ok(r.maxDist - r.minDist > 0.15, 'the ball separation should vary between touches');
});

test('close control keeps the ball closer than sprint knock-ons', () => {
  const close = dribble(MoveMode.Close, 4, 2);
  const sprint = dribble(MoveMode.Sprint, 7, 2);
  assert.ok(close.maxDist < sprint.maxDist, `close=${close.maxDist.toFixed(2)} sprint=${sprint.maxDist.toFixed(2)}`);
  assert.ok(sprint.maxDist > 0.55, 'sprint touches should push the ball further ahead');
});

test('a stationary carrier does not nudge a settled ball', () => {
  const { m, p } = makeMatch();
  m.ball.reset({ x: 0.4, y: 0.11, z: 0 });
  m.ball.hold(p);
  let touches = 0;
  m.events.on('PlayerDribbleTouch', () => touches++);
  for (let i = 0; i < 30; i++) { m.time += 1 / 30; m.ball.step(1 / 30); }
  assert.equal(touches, 0);
  assert.ok(m.ball.holder === p);
});

test('losing the ball beyond the control radius releases possession', () => {
  const { m, p } = makeMatch();
  m.ball.reset({ x: 0.4, y: 0.11, z: 0 });
  m.ball.hold(p);
  m.ball.pos.x = 8;
  m.time += 0.5;
  let lost = false;
  m.events.on('PossessionLost', () => { lost = true; });
  m.ball.step(1 / 30);
  assert.equal(lost, true);
  assert.equal(m.ball.holder, null);
});

test('first touch settles a slow ball with a live roll instead of freezing it', () => {
  const { m, p } = makeMatch();
  p.ballContactReadyAt = 0;
  m.ball.release();
  m.ball.pos = V.v3(0.5, 0.11, 0);
  m.ball.vel = V.v3(0, 0, 0);
  m.handleTouches(0);
  assert.equal(m.ball.holder, p);
  assert.ok(p.receptionQuality > 0.5);
  assert.ok(m.ball.speed > 0.01, 'the cushion touch should leave a rolling ball');
  const start = V.copy(m.ball.pos);
  for (let i = 0; i < 10; i++) { m.time += 1 / 30; m.ball.step(1 / 30); }
  assert.ok(V.distXZ(m.ball.pos, p.pos) < 0.9, 'the first touch should settle within control range');
  assert.ok(V.distXZ(m.ball.pos, start) > 0.001, 'the ball should roll to the cushion point');
});

test('a pressured first touch is directed away from the nearest opponent', () => {
  const { m, p } = makeMatch();
  const opponent = m.players.find((q) => q.team === 1 && !q.isGoalKeeper);
  opponent.setInstantPosition(0, 0.9);
  p.ballContactReadyAt = 0;
  opponent.ballContactReadyAt = 0;
  m.ball.release();
  m.ball.pos = V.v3(0.5, 0.11, 0);
  m.ball.vel = V.v3(0, 0, 0);
  m.handleTouches(0);
  assert.equal(m.ball.holder, p);
  const away = V.normalizeXZ(V.sub(p.pos, opponent.pos));
  assert.ok(V.dotXZ(m.ball.vel, away) > 0, 'the touch should protect the ball away from the opponent');
});

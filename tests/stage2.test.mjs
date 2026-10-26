import test from 'node:test';
import assert from 'node:assert/strict';
import { Match, Phase } from '../src/engine/match.js';
import { MovementType } from '../src/engine/player.js';
import { BALL_RADIUS } from '../src/engine/ball.js';
import * as V from '../src/engine/vec.js';

const CFG = { id: 'classic5', name: '5v5', teamSize: 6, pitchLength: 64, pitchWidth: 48, goalW: 6, goalH: 2.2, durationSec: 300, offside: false };
const make = (humanSlot = null) => {
  const m = new Match(CFG, { seed: 123, aiLevel: 2, humanSlot });
  m.phase = Phase.LIVE;
  return m;
};
const sweep = (m, from, to) => {
  m.ball.release();
  m.ball.prevPos = V.copy(from);
  m.ball.pos = V.copy(to);
  m.checkGoal();
};

test('swept goal detection works even when the ball skips the whole goal plane in one tick', () => {
  const m = make();
  const gx = m.goalNets[1].x;
  sweep(m, V.v3(gx - 2, 1, 0), V.v3(gx + 2, 1, 0));
  assert.equal(m.score[0], 1);
  assert.equal(m.phase, Phase.GOAL_CELEB);
});

test('post collision registers woodwork instead of tunneling into a goal kick', () => {
  const m = make();
  const gx = m.goalNets[1].x;
  m.ball.vel = V.v3(32, 0, 0);
  let woodwork = null;
  m.events.on('BallHitWoodwork', (e) => { woodwork = e; });
  sweep(m, V.v3(gx - 0.5, 1, CFG.goalW / 2), V.v3(gx + 0.5, 1, CFG.goalW / 2));
  assert.equal(woodwork?.part, 'POST');
  assert.equal(m.score[0] + m.score[1], 0);
  assert.ok(m.ball.vel.x < 0);
});

test('crossbar collision reflects downward instead of becoming a goal', () => {
  const m = make();
  const gx = m.goalNets[1].x;
  m.ball.vel = V.v3(28, 2, 0);
  let woodwork = null;
  m.events.on('BallHitWoodwork', (e) => { woodwork = e; });
  sweep(m, V.v3(gx - 0.5, CFG.goalH - 0.12, 0), V.v3(gx + 0.5, CFG.goalH - 0.12, 0));
  assert.equal(woodwork?.part, 'CROSSBAR');
  assert.equal(m.score[0] + m.score[1], 0);
  assert.ok(m.ball.vel.y < 0);
});

test('first touch holds a controllable ball with a high-control player', () => {
  const m = make();
  const p = m.players.find((q) => q.team === 0 && !q.isGoalKeeper);
  p.setInstantPosition(0, 0, 0);
  p.skills.ballControl = 100;
  p.facing = 0;
  m.ball.reset(V.v3(0.5, BALL_RADIUS, 0));
  m.ball.vel = V.v3(-6, 0, 0);
  m.handleTouches(1 / 30);
  assert.equal(m.ball.holder?.id, p.id);
});

test('bad first touch deflects instead of magically sticking', () => {
  const m = make();
  const p = m.players.find((q) => q.team === 0 && !q.isGoalKeeper);
  p.setInstantPosition(0, 0, 0);
  p.skills.ballControl = 20;
  m.ball.reset(V.v3(0.5, BALL_RADIUS, 0));
  m.ball.vel = V.v3(-30, 0, 0);
  m.rng = () => 0.99;
  m.handleTouches(1 / 30);
  assert.notEqual(m.ball.holder, p);
  assert.equal(m.ball.lastTouch?.id, p.id);
});

test('one-touch shot does not require prior possession', () => {
  const m = make(3);
  const p = m.players.find((q) => q.isHuman);
  m.ball.reset(V.addScaled(p.pos, V.fromHeading(p.facing), 0.5));
  m.ball.pos.y = 0.7;
  p.intent = { shoot: true, shootPower: 0.8 };
  m.processBehaviours(p, 1 / 30);
  assert.equal(m.ball.lastTouch?.id, p.id);
  assert.ok(m.ball.speed > 5);
});

test('charged through becomes a lob while a tap stays a ground through pass', () => {
  const m = make(3);
  const p = m.players.find((q) => q.isHuman);
  m.ball.hold(p);
  p.intent = { through: true, throughPower: 0.9 };
  m.processBehaviours(p, 1 / 30);
  assert.equal(p.pendingStrike?.lob, true);
  assert.equal(m.ball.holder?.id, p.id);
  m.time = p.pendingStrike.contactAt;
  m.resolvePendingStrikes();
  assert.equal(m.ball.inCrossMode, true);
  m.ball.hold(p);
  p.actionLockUntil = 0;
  p.intent = { through: true, throughPower: 0.2 };
  m.processBehaviours(p, 1 / 30);
  assert.equal(p.pendingStrike?.lob, false);
  m.time = p.pendingStrike.contactAt;
  m.resolvePendingStrikes();
  assert.equal(m.ball.inCrossMode, false);
});

test('feint moves the carrier and grants a short tackle-immunity window', () => {
  const m = make(3);
  const p = m.players.find((q) => q.isHuman);
  const tackler = m.players.find((q) => q.team === 1 && !q.isGoalKeeper);
  m.ball.hold(p);
  const before = V.copy(p.pos);
  assert.equal(m.performFeint(p, { moveX: 1, moveZ: 0 }), true);
  m.updateSpecialActions(0.1);
  assert.ok(V.distXZ(before, p.pos) > 0.2);
  tackler.setInstantPosition(p.pos.x + 0.5, p.pos.z);
  m.attemptTackle(tackler, false);
  assert.equal(m.ball.holder?.id, p.id);
  assert.ok(tackler.stunnedUntil > m.time);
});

test('sprint drains once per tick and exhaustion lasts until recovery', () => {
  const m = make();
  const p = m.players.find((q) => q.team === 0 && !q.isGoalKeeper);
  p.speed = p.topSpeed;
  p.stamina = 5.1;
  p.moveTo(0.1, V.addScaled(p.pos, V.fromHeading(p.facing), 20));
  p.updateStamina(0.1);
  assert.ok(Math.abs(p.stamina - 4.3) < 1e-9);
  assert.equal(p.sprintExhausted, true);
  const before = V.copy(p.pos);
  p.moveTo(0.1, V.addScaled(p.pos, V.fromHeading(p.facing), 20));
  assert.ok(V.distXZ(before, p.pos) < p.topSpeed * 0.1);
  assert.equal(p.sprinting, false);
  for (let i = 0; i < 15; i++) { p.stop(0.1); p.updateStamina(0.1); }
  assert.equal(p.sprintExhausted, false);
  assert.ok(p.stamina >= 20);
});

test('GK dive moves toward the ball and a soft shot is caught cleanly', () => {
  const m = make();
  const gk = m.players.find((q) => q.team === 0 && q.isGoalKeeper);
  m.ball.reset(V.addScaled(gk.pos, V.fromHeading(gk.facing), 1));
  m.ball.vel = V.v3(8, 0, 0);
  const before = V.copy(gk.pos);
  assert.equal(m.startGKDive(gk), true);
  m.updateSpecialActions(0.1);
  assert.ok(V.distXZ(before, gk.pos) > 0.1);
  m.gkContact(gk);
  assert.equal(m.ball.holder?.id, gk.id);
  assert.equal(gk.diveTimer, 0);
});

test('hard shot can be parried without sticking to the keeper', () => {
  const m = make();
  const gk = m.players.find((q) => q.team === 0 && q.isGoalKeeper);
  m.ball.reset(V.addScaled(gk.pos, V.fromHeading(gk.facing), 0.6));
  m.ball.vel = V.v3(-30, 0, 0);
  m.rng = () => 0.99;
  m.gkContact(gk);
  assert.notEqual(m.ball.holder, gk);
  assert.equal(m.ball.lastTouch?.id, gk.id);
});

test('high ball can be headed rather than ignored', () => {
  const m = make();
  const p = m.players.find((q) => q.team === 0 && !q.isGoalKeeper);
  const goal = m.teams[0].attackGoal;
  p.setInstantPosition(goal.x - 10, 0, 0);
  m.ball.reset(V.v3(p.pos.x + 0.4, 1.8, p.pos.z));
  m.ball.vel = V.v3(0, -2, 0);
  m.rng = Object.assign(() => 0.1, m.rng);
  m.handleTouches(1 / 30);
  assert.equal(m.ball.lastTouch?.id, p.id);
  assert.equal(p.animMode, 'HEADER');
});

for (const net of [0, 1]) {
  test(`goal ${net} requires the whole ball beyond the line and scores once`, () => {
    const m = make();
    const sign = net === 0 ? -1 : 1;
    const gx = m.goalNets[net].x;
    sweep(m, V.v3(gx - sign, 1, 0), V.v3(gx + sign * BALL_RADIUS * 0.5, 1, 0));
    assert.deepEqual(m.score, [0, 0]);
    sweep(m, V.copy(m.ball.pos), V.v3(gx + sign * BALL_RADIUS * 1.5, 1, 0));
    assert.equal(m.score[1 - net], 1);
    m.checkGoal();
    assert.equal(m.score[1 - net], 1);
  });
}

test('a sideways strike collides with the post without crossing the goal plane', () => {
  const m = make();
  const gx = m.goalNets[1].x;
  m.ball.vel = V.v3(0, 0, -30);
  let hits = 0;
  m.events.on('BallHitWoodwork', () => hits++);
  sweep(m, V.v3(gx - 0.08, 1, 4), V.v3(gx - 0.08, 1, 2));
  assert.equal(hits, 1);
  assert.ok(m.ball.vel.z > 0);
  assert.deepEqual(m.score, [0, 0]);
});

test('a separating post rebound does not generate a second collision', () => {
  const m = make();
  const gx = m.goalNets[1].x;
  let hits = 0;
  m.events.on('BallHitWoodwork', () => hits++);
  m.ball.vel = V.v3(32, 0, 0);
  sweep(m, V.v3(gx - 1, 1, 3), V.v3(gx + 1, 1, 3));
  m.ball.step(1 / 120);
  m.checkGoal();
  assert.equal(hits, 1);
});

test('a parry cannot immediately become a catch in the same tick', () => {
  const m = make();
  const gk = m.teams[0].players[0];
  m.ball.reset(V.addScaled(gk.pos, V.fromHeading(gk.facing), 0.6));
  m.ball.vel = V.v3(-30, 0, 0);
  m.rng = Object.assign(() => 0.99, m.rng);
  let parries = 0;
  m.events.on('KeeperParry', () => parries++);
  assert.equal(m.gkContact(gk), true);
  assert.ok(m.ball.vel.x > 0, 'parry should send the ball away, not boost it toward goal');
  m.rng = Object.assign(() => 0, m.rng);
  assert.equal(m.gkContact(gk), false);
  m.handleTouches(0);
  assert.equal(m.ball.holder, null);
  assert.equal(parries, 1);
});

test('GK catch preserves incoming pace, stops a dive, and holds the ball at hand height', () => {
  const m = make();
  const gk = m.teams[0].players[0];
  m.ball.reset(V.addScaled(gk.pos, V.fromHeading(gk.facing), 0.6));
  m.ball.vel = V.v3(-8, 0, 0);
  m.startGKDive(gk);
  let speed;
  m.events.on('KeeperSavesTheBall', (ev) => { speed = ev.speed; });
  m.gkContact(gk);
  m.ball.step(1 / 30);
  assert.equal(speed, 8);
  assert.equal(gk.diveTimer, 0);
  assert.equal(gk.speed, 0);
  assert.equal(m.ball.heldInHands, true);
  assert.equal(m.ball.pos.y, 1.08);
  assert.equal(gk.animMode, 'GK_HOLD');
});

test('keepers cannot handle the ball outside their own penalty area', () => {
  const m = make();
  const gk = m.teams[0].players[0];
  gk.setInstantPosition(0, 0);
  m.ball.reset(V.v3(0.5, BALL_RADIUS, 0));
  assert.equal(m.gkContact(gk), false);
  assert.equal(m.ball.heldInHands, false);
});

test('human keeper can distribute possession and cannot hold indefinitely', () => {
  const m = make(0);
  const gk = m.teams[0].players[0];
  m.ball.hold(gk, true);
  gk.intent = { pass: true, passPower: 0.7 };
  m.processBehaviours(gk, 1 / 30);
  assert.equal(m.ball.holder?.id, gk.id, 'the ball is held during the distribution wind-up');
  for (let i = 0; i < 20; i++) m.step(1 / 30);
  assert.equal(m.ball.holder, null);
  assert.equal(m.ball.lastTouch?.id, gk.id);
  m.ball.hold(gk, true);
  gk.ballHoldTime = 5.8;
  m.processBehaviours(gk, 1 / 30);
  assert.equal(m.ball.holder?.id, gk.id, 'the six-second limit does not teleport the ball out');
  for (let i = 0; i < 20; i++) m.step(1 / 30);
  assert.equal(m.ball.holder, null);
});

test('first-touch cooldown prevents repeated failed-control rolls in one tick', () => {
  const m = make();
  const p = m.teams[0].players[1];
  p.setInstantPosition(0, 8);
  p.skills.ballControl = 20;
  m.ball.reset(V.v3(0.5, BALL_RADIUS, 8));
  m.ball.vel = V.v3(-30, 0, 0);
  m.rng = Object.assign(() => 0.99, m.rng);
  let mistakes = 0;
  m.events.on('PlayerTouchTheBall', () => mistakes++);
  for (let i = 0; i < 4; i++) m.handleTouches(0);
  assert.equal(mistakes, 1);
  assert.equal(m.ball.holder, null);
});

test('a dive persists across ticks without normal running being added', () => {
  const m = make(0);
  const gk = m.teams[0].players[0];
  m.ball.reset(V.v3(0, BALL_RADIUS, 0));
  m.startGKDive(gk, { moveX: 1, moveZ: 0 });
  const x = gk.pos.x;
  for (let i = 0; i < 3; i++) {
    gk.intent = { moveX: 0, moveZ: 1 };
    m.step(1 / 30);
    assert.equal(gk.animMode, 'DIVE');
    assert.ok(Math.abs(gk.pos.x - x) < 1e-8);
  }
});

test('restart stops play once, positions the taker, and keeps the match clock running', () => {
  const m = make(3);
  const spot = V.v3(m.fieldHalfX - 6, BALL_RADIUS, m.fieldHalfZ - 2);
  m.restart(0, spot, 'THROWIN');
  const taker = m.ball.holder;
  assert.equal(taker.pos.x, spot.x);
  assert.equal(taker.pos.z, m.fieldHalfZ + 0.45, 'thrower stands outside the touchline');
  assert.ok(m.ball.pos.z >= spot.z && m.ball.pos.z <= m.fieldHalfZ + 0.45, 'ball is held at the line');
  const before = V.copy(m.ball.pos);
  m.step(1 / 30);
  assert.deepEqual(m.ball.pos, before);
  assert.ok(m.clockSec > 0);
});

test('ten seeded matches remain finite through contacts and restarts and finish', () => {
  for (let seed = 0; seed < 10; seed++) {
    const m = new Match({ ...CFG, durationSec: 40 }, { seed, humanSlot: null });
    let previousClock = 0;
    for (let tick = 0; tick < 30 * 120 && m.phase !== Phase.ENDED; tick++) {
      m.step(1 / 30);
      assert.ok(m.clockSec >= previousClock, `clock reversed: seed ${seed}`);
      previousClock = m.clockSec;
      const b = m.ball;
      assert.ok(Number.isFinite(b.pos.x + b.pos.y + b.pos.z + b.speed), `ball invalid: seed ${seed}`);
      for (const p of m.players) {
        assert.ok(Number.isFinite(p.pos.x + p.pos.z + p.speed), p.id);
        assert.ok(p.stamina >= 0 && p.stamina <= 100, p.id);
      }
    }
    assert.equal(m.phase, Phase.ENDED, `stuck match: seed ${seed}`);
  }
});

test('possessed strike waits for foot contact while the ball stays at the feet', () => {
  const m = make(3);
  const p = m.players.find((q) => q.isHuman);
  m.ball.hold(p);
  p.intent = { shoot: true, shootPower: 0.8 };
  m.processBehaviours(p, 1 / 30);
  assert.equal(p.pendingStrike?.type, 'shoot');
  assert.equal(m.ball.holder?.id, p.id);
  assert.ok(p.kickTimer > 0.2);
  m.time = p.pendingStrike.contactAt;
  m.resolvePendingStrikes();
  assert.equal(m.ball.lastTouch?.id, p.id);
  assert.equal(m.ball.holder?.id, undefined);
  assert.equal(p.animMode, 'KICK');
  assert.ok(p.kickTimer > 0, 'wind-up is preserved through contact');
});

test('losing the ball or feinting cancels a pending strike without a phantom touch', () => {
  const m = make(3);
  const p = m.players.find((q) => q.isHuman);
  m.ball.hold(p);
  const lastTouchId = m.ball.lastTouch.id;
  assert.equal(m.scheduleStrike(p, { type: 'shoot', power: 0.8 }), true);
  m.ball.release();
  m.resolvePendingStrikes();
  assert.equal(p.pendingStrike, null);
  assert.equal(m.ball.lastTouch?.id, lastTouchId);
  m.ball.hold(p);
  assert.equal(m.scheduleStrike(p, { type: 'pass', point: V.v3(5, 0, 0), speed: 1 }), true);
  m.performFeint(p, { moveX: 0, moveZ: 0 });
  assert.equal(p.pendingStrike, null);
});

for (const frameHz of [30, 60, 144]) {
  test(`${frameHz} Hz presentation: contact phase matches ball release`, () => {
    const m = make(3);
    const p = m.players.find((q) => q.isHuman);
    m.ball.hold(p);
    p.intent = { shoot: true, shootPower: 0.9 };
    m.processBehaviours(p, 1 / 30);
    const contactAt = p.pendingStrike.contactAt;
    let steps = 0;
    while (m.time < contactAt && steps < 500) {
      const dt = 1 / frameHz;
      p.kickTimer = Math.max(0, p.kickTimer - dt);
      m.time += dt;
      m.resolvePendingStrikes();
      steps++;
    }
    assert.equal(m.ball.holder?.id, undefined);
    const phase = 1 - p.kickTimer / 0.32;
    assert.ok(phase > 0.3 && phase < 0.72, `contact phase=${phase.toFixed(3)} at ${frameHz} Hz`);
  });
}

test('ball must fully cross the goal line and scores once', () => {
  const m = make();
  const gx = m.goalNets[1].x;
  sweep(m, V.v3(gx - 1, 1, 0), V.v3(gx + BALL_RADIUS * 0.5, 1, 0));
  assert.deepEqual(m.score, [0, 0]);
  sweep(m, V.copy(m.ball.pos), V.v3(gx + BALL_RADIUS * 1.5, 1, 0));
  assert.equal(m.score[0], 1);
  m.checkGoal();
  assert.equal(m.score[0], 1);
});

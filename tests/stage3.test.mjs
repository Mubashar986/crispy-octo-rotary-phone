import test from 'node:test';
import assert from 'node:assert/strict';
import { Match, Phase } from '../src/engine/match.js';
import { MODE_CONFIGS } from '../src/config/modes.js';
import { BALL_RADIUS } from '../src/engine/ball.js';
import * as V from '../src/engine/vec.js';

const live = (cfg) => { const m = new Match(cfg, { seed: 7 }); m.phase = Phase.LIVE; return m; };

test('11v11 uses full IFAB dimensions and every mode has fitting markings', () => {
  const full = MODE_CONFIGS.full11;
  assert.equal(full.pitchLength, 105);
  assert.equal(full.pitchWidth, 68);
  assert.equal(full.goalW, 7.32);
  assert.equal(full.goalH, 2.44);
  assert.deepEqual(
    { d: full.markings.boxDepth, w: full.markings.boxWidth, gd: full.markings.goalAreaDepth, gw: full.markings.goalAreaWidth },
    { d: 16.5, w: 40.32, gd: 5.5, gw: 18.32 }
  );
  for (const cfg of Object.values(MODE_CONFIGS)) {
    assert.ok(cfg.markings.boxWidth < cfg.pitchWidth, cfg.id);
    assert.ok(cfg.markings.boxDepth < cfg.pitchLength / 2, cfg.id);
    assert.ok(cfg.markings.goalAreaWidth < cfg.markings.boxWidth, cfg.id);
    assert.ok(cfg.markings.goalAreaDepth < cfg.markings.boxDepth, cfg.id);
    assert.ok(cfg.goalW < cfg.markings.goalAreaWidth, cfg.id);
  }
});

test('every mode shares the same full IFAB ground, goals and markings', () => {
  for (const cfg of Object.values(MODE_CONFIGS)) {
    assert.equal(cfg.pitchLength, 105, cfg.id);
    assert.equal(cfg.pitchWidth, 68, cfg.id);
    assert.equal(cfg.goalW, 7.32, cfg.id);
    assert.equal(cfg.goalH, 2.44, cfg.id);
    assert.deepEqual(cfg.markings, MODE_CONFIGS.full11.markings, cfg.id);
  }
});

test('11v11 creates 11-a-side rosters with the selected roles', () => {
  const m = live(MODE_CONFIGS.full11);
  assert.equal(m.players.length, 22);
  assert.equal(m.teams[0].players.length, 11);
  assert.deepEqual(m.teams[0].players.map(p => p.role), MODE_CONFIGS.full11.roles);
  assert.equal(m.teams[0].players.filter(p => p.isGoalKeeper).length, 1);
});

test('throw-in places the ball on the line, thrower outside, and opponents 2m away', () => {
  const m = live(MODE_CONFIGS.full11);
  const side = 1;
  const spot = V.v3(12, BALL_RADIUS, m.fieldHalfZ * side);
  for (const p of m.players) p.setInstantPosition(12, 0);
  m.restart(0, spot, 'THROWIN');
  const thrower = m.ball.holder;
  assert.equal(thrower.isThrowHolder, true);
  assert.equal(m.ball.heldInHands, true);
  assert.ok(thrower.pos.z > m.fieldHalfZ, 'thrower is off the field of play');
  assert.ok(m.ball.pos.z > m.fieldHalfZ, 'ball is behind the line in the thrower hands');
  assert.ok(Math.abs(m.ball.pos.y - 2.02) < 1e-9);
  for (const opp of m.teams[1].players) {
    assert.ok(V.distXZ(opp.pos, thrower.pos) >= 2, `${opp.id} is inside 2m`);
  }
});

test('throw-in release is a legal throw: no offside, no direct goal', () => {
  const m = live(MODE_CONFIGS.club7);
  const spot = V.v3(10, BALL_RADIUS, m.fieldHalfZ);
  m.restart(0, spot, 'THROWIN');
  const thrower = m.ball.holder;
  let thrown = null;
  m.events.on('PlayerThrowIn', ev => { thrown = ev; });
  m.executeSetPiece();
  assert.ok(thrown);
  assert.equal(m.ball.lastTouch?.id, thrower.id);
  assert.equal(thrower.isThrowHolder, false);
  assert.ok(m.teams[0].players.every(p => !p.isInOffside), 'throw-in cannot create offside');
  m.restrictedGoalBy = thrower.id;
  const gx = m.goalNets[1].x;
  m.ball.release();
  m.ball.prevPos = V.v3(gx - 1, 1, 0);
  m.ball.pos = V.v3(gx + 1, 1, 0);
  m.ball.lastTouch = thrower;
  m.checkGoal();
  assert.equal(m.score[0] + m.score[1], 0, 'direct throw-in goal is disallowed');
});

test('corner places the ball on the arc and arranges both boxes from decoded tables', () => {
  const m = live(MODE_CONFIGS.full11);
  const gx = m.goalNets[1].x;
  const spot = V.v3(gx, BALL_RADIUS, m.fieldHalfZ);
  m.restart(0, spot, 'CORNER');
  const taker = m.ball.holder;
  assert.equal(taker.isCornerHolder, true);
  assert.ok(taker.pos.x > gx, 'taker is beyond the goal line');
  assert.ok(taker.pos.z > m.fieldHalfZ, 'taker is beyond the touchline');
  assert.deepEqual(m.ball.pos, V.v3(gx, BALL_RADIUS, m.fieldHalfZ));
  const attackersInBox = m.teams[0].players.filter(p => p.pos.x > m.fieldHalfX - 20).length;
  const defendersBack = m.teams[1].players.filter(p => p.pos.x > m.fieldHalfX - 20).length;
  assert.ok(attackersInBox >= 5, `attackers boxed: ${attackersInBox}`);
  assert.ok(defendersBack >= 6, `defenders boxed: ${defendersBack}`);
  const restCb = m.teams[0].players.find((p) => p.role === 'CB' && p.pos.x < 0);
  assert.ok(restCb, 'one centre-back stays in the attacking rest defence');
  const outlet = m.teams[1].players.find((p) => Math.abs(p.pos.x) < m.fieldHalfX * 0.25);
  assert.ok(outlet, 'the defending team leaves a counter outlet');
});

test('corner delivery after the side switch still targets the attacking goal', () => {
  const m = live(MODE_CONFIGS.full11);
  m.phase = Phase.HALF_TIME;
  m.startSecondHalf();
  const gx = m.goalNets[0].x;
  m.restart(0, V.v3(gx, BALL_RADIUS, m.fieldHalfZ), 'CORNER');
  let taken = null;
  m.events.on('CornerTaken', (ev) => { taken = ev; });
  m.executeSetPiece();
  assert.ok(taken);
  assert.ok(taken.target.x < 0, `corner should cross toward the team's attacking goal, got x=${taken.target.x}`);
});

test('corner delivery can target both the near and far post runner', () => {
  const m = live(MODE_CONFIGS.full11);
  const gx = m.goalNets[1].x;
  const base = m.rng;
  const targets = [];
  for (const value of [0.2, 0.9]) {
    m.rng = Object.assign(() => value, { range: base.range, sign: base.sign });
    m.restart(0, V.v3(gx, BALL_RADIUS, m.fieldHalfZ), 'CORNER');
    let taken = null;
    m.events.removeAll?.('CornerTaken');
    m.events.on('CornerTaken', (ev) => { taken = ev; });
    m.executeSetPiece();
    assert.ok(taken);
    targets.push(taken);
  }
  m.rng = base;
  assert.equal(targets[0].post, 'near');
  assert.equal(targets[1].post, 'far');
  assert.ok(targets[0].target.z * targets[1].target.z < 0, 'near and far target opposite sides of the goal');
  assert.ok(targets.every((t) => t.runnerId), 'every cross targets a runner');
});

test('corner delivery is exempt from offside and targets the box', () => {
  const m = live(MODE_CONFIGS.club7);
  const gx = m.goalNets[1].x;
  m.restart(0, V.v3(gx, BALL_RADIUS, m.fieldHalfZ), 'CORNER');
  const taker = m.ball.holder;
  let delivered = null;
  m.events.on('CornerTaken', ev => { delivered = ev; });
  m.executeSetPiece();
  assert.ok(delivered);
  assert.equal(m.ball.lastTouch?.id, taker.id);
  assert.ok(m.teams[0].players.every(p => !p.isInOffside), 'corner cannot create offside');
  assert.ok(delivered.short || Math.abs(delivered.target.z) < m.cfg.goalW / 2);
});

test('full11 never places players outside the pitch during open play', () => {
  for (let seed = 0; seed < 4; seed++) {
    const m = live({ ...MODE_CONFIGS.full11, durationSec: 120 });
    for (let i = 0; i < 30 * 60; i++) {
      m.step(1 / 30);
      if (m.setPiece === 'THROWIN' || m.setPiece === 'CORNER') continue;
      for (const p of m.players) {
        if (p.sentOff) continue; // dismissed players are placed off the touchline
        assert.ok(Math.abs(p.pos.x) <= m.fieldHalfX + 0.001, `seed ${seed} ${p.id} x=${p.pos.x}`);
        assert.ok(Math.abs(p.pos.z) <= m.fieldHalfZ + 0.001, `seed ${seed} ${p.id} z=${p.pos.z}`);
      }
    }
  }
});

test('thrower cannot be tackled and the restart phase freezes normal play', () => {
  const m = live(MODE_CONFIGS.full11);
  m.restart(0, V.v3(8, BALL_RADIUS, m.fieldHalfZ), 'THROWIN');
  const thrower = m.ball.holder;
  const before = V.copy(thrower.pos);
  m.step(1 / 30);
  assert.deepEqual(thrower.pos, before);
  assert.equal(m.setPiece, 'THROWIN');
  assert.ok(m.clockSec > 0);
});

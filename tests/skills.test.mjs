import test from 'node:test';
import assert from 'node:assert/strict';
import { Match, Phase } from '../src/engine/match.js';
import { MODE_CONFIGS } from '../src/config/modes.js';
import { MoveMode } from '../src/engine/player.js';
import { CONTROL_SCHEMES } from '../src/config/controls.js';
import * as V from '../src/engine/vec.js';

function makeMatch() {
  const m = new Match(MODE_CONFIGS.classic5, { seed: 31, humanSlot: null, aiLevel: 0 });
  m.phase = Phase.LIVE;
  m.time = 10;
  m.freezeUntil = 0;
  m.setPiece = null;
  const p = m.players.find((q) => q.team === 0 && !q.isGoalKeeper);
  m.players.filter((q) => q !== p).forEach((q, i) => q.setInstantPosition(30 + i * 1.5, 30, 0));
  p.setInstantPosition(0, 0, 0);
  p.facing = 0;
  m.ball.reset({ x: 0.4, y: 0.11, z: 0 });
  m.ball.hold(p);
  return { m, p };
}

test('close-control skill rolls the ball to the side and keeps possession', () => {
  const { m, p } = makeMatch();
  const before = V.copy(p.pos);
  const startZ = m.ball.pos.z;
  let rolled = null;
  m.events.on('PlayerBallRoll', (ev) => { rolled = ev; });
  assert.equal(m.performSkill(p, { closeControl: true }), true);
  assert.equal(p.skillKind, 'roll');
  assert.ok(rolled, 'a ball roll event should fire');
  assert.equal(m.ball.holder, p, 'the roll keeps logical possession');
  assert.ok(m.ball.vel.z > 1, `ball should be knocked to the side, vz=${m.ball.vel.z.toFixed(2)}`);
  assert.ok(m.ball.dribblePulse > 0.9, 'the touch feedback pulse should fire');
  for (let i = 0; i < 8; i++) {
    m.time += 1 / 30;
    m.updateSpecialActions(1 / 30);
    m.ball.step(1 / 30);
  }
  assert.ok(p.pos.z > before.z + 0.3, `the carrier should step past the ball, z=${p.pos.z.toFixed(2)}`);
  assert.ok(m.ball.pos.z > startZ, 'the ball should travel laterally');
});

test('a plain skill press is a feint in the input direction', () => {
  const { m, p } = makeMatch();
  let feinted = null;
  m.events.on('PlayerFeint', (ev) => { feinted = ev; });
  assert.equal(m.performSkill(p, { worldX: 1, worldZ: 0 }), true);
  assert.equal(p.skillKind, 'feint');
  assert.ok(feinted);
  assert.ok(p.feintVelocity.x > 4, `feint burst=${p.feintVelocity.x.toFixed(2)}`);
  assert.equal(m.ball.vel.z, 0, 'a feint does not nudge the ball sideways');
});

test('skill moves share a cooldown and refuse without the ball', () => {
  const { m, p } = makeMatch();
  assert.equal(m.performSkill(p, {}), true);
  assert.equal(m.performSkill(p, { closeControl: true }), false);
  m.ball.release();
  assert.equal(m.performSkill(p, {}), false);
});

test('a ball roll grants the same brief tackle immunity as a feint', () => {
  const { m, p } = makeMatch();
  const tackler = m.players.find((q) => q.team === 1 && !q.isGoalKeeper);
  tackler.setInstantPosition(-0.8, 0, 0);
  assert.equal(m.performSkill(p, { closeControl: true }), true);
  m.attemptTackle(tackler, false);
  assert.equal(m.ball.holder, p, 'the carrier keeps the ball during the roll');
  assert.ok(tackler.stunned, 'the committed tackle is punished');
});

test('snapshot carry modes distinguish normal, close, face-up, shield and sprint', () => {
  const { m, p } = makeMatch();
  const mode = () => m.getSnapshot().players.find((q) => q.id === p.id).carryMode;
  p.moveMode = MoveMode.Normal;
  m.updateDuelContext();
  assert.equal(mode(), 'NORMAL');
  p.moveMode = MoveMode.Close;
  m.updateDuelContext();
  assert.equal(mode(), 'CLOSE');
  p.faceUp = true;
  assert.equal(mode(), 'FACE-UP');
  p.faceUp = false;
  const opponent = m.players.find((q) => q.team === 1 && !q.isGoalKeeper);
  opponent.setInstantPosition(-0.8, 0, 0);
  p.moveMode = MoveMode.Shield;
  m.ball.pos = V.v3(0.4, 0.11, 0);
  m.updateDuelContext();
  assert.equal(p.shieldActive, true);
  assert.equal(mode(), 'SHIELD');
  p.moveMode = MoveMode.Sprint;
  p.shieldActive = false;
  assert.equal(mode(), 'SPRINT');
  m.ball.release();
  assert.equal(mode(), null);
});

test('close control is bound to M so it does not collide with the subs key', () => {
  for (const scheme of Object.values(CONTROL_SCHEMES)) {
    assert.ok(scheme.keys.closeControl.includes('m'), `${scheme.id} close control`);
    assert.ok(!scheme.keys.closeControl.includes('b'), `${scheme.id} still steals subs`);
    assert.equal(scheme.labels.closeControl, 'M');
  }
});

test('ball nudge refuses when the player is not the holder', () => {
  const { m, p } = makeMatch();
  m.ball.release();
  assert.equal(m.ball.nudge(p, 0, 1, 3), false);
});

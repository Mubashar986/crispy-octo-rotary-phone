import test from 'node:test';
import assert from 'node:assert/strict';
import { Match, Phase } from '../src/engine/match.js';
import { MODE_CONFIGS } from '../src/config/modes.js';
import { Player, MovementType, MoveMode, LocoState } from '../src/engine/player.js';

const SKILLS = {
  topSpeed: 75, acceleration: 75, agility: 75, strength: 70, dribbleSpeed: 75,
  ballControl: 75, passing: 75, longBall: 70, shooting: 75, shootPower: 75,
  tackling: 60, positioning: 70, reaction: 70, jump: 65
};

function player(opts = {}) {
  return new Player({
    id: opts.id ?? 'p', team: 0, role: 'ST', x: 0, z: 0, facing: 0,
    skills: { ...SKILLS, ...(opts.skills ?? {}) }
  });
}

test('acceleration walks through IDLE, START, WALK, RUN and SPRINT', () => {
  const p = player();
  const seen = [];
  for (let i = 0; i < 90; i++) {
    p.move(1 / 30, 1, 0, MovementType.BestHeCanDo);
    if (seen.at(-1) !== p.locoState) seen.push(p.locoState);
  }
  assert.deepEqual(seen, [LocoState.Start, LocoState.Walk, LocoState.Run, LocoState.Sprint]);
  assert.ok(p.locoPhase >= 0 && p.locoPhase < 1);
});

test('deceleration reports STOP before settling to IDLE', () => {
  const p = player();
  for (let i = 0; i < 90; i++) p.move(1 / 30, 1, 0, MovementType.BestHeCanDo);
  const seen = [];
  for (let i = 0; i < 45; i++) {
    p.stop(1 / 30);
    if (seen.at(-1) !== p.locoState) seen.push(p.locoState);
  }
  assert.equal(seen[0], LocoState.Stop);
  assert.equal(seen.at(-1), LocoState.Idle);
  assert.equal(p.locoPhase, 0);
  assert.equal(p.locoContact, false);
});

test('gait thresholds use hysteresis instead of flickering', () => {
  const p = player();
  p.speed = 2.3;
  p.locoState = LocoState.Walk;
  p.updateLocomotion(1 / 30, 2.3);
  assert.equal(p.locoState, LocoState.Walk);
  p.locoState = LocoState.Run;
  p.updateLocomotion(1 / 30, 2.3);
  assert.equal(p.locoState, LocoState.Run);

  p.speed = 5.5;
  p.locoState = LocoState.Run;
  p.updateLocomotion(1 / 30, 5.5);
  assert.equal(p.locoState, LocoState.Run);
  p.speed = 5.75;
  p.updateLocomotion(1 / 30, 5.75);
  assert.equal(p.locoState, LocoState.Sprint);
  p.speed = 5.4;
  p.updateLocomotion(1 / 30, 5.4);
  assert.equal(p.locoState, LocoState.Sprint);
  p.speed = 5.1;
  p.updateLocomotion(1 / 30, 5.1);
  assert.equal(p.locoState, LocoState.Run);
});

test('phase advances by distance travelled over the gait stride', () => {
  const p = player();
  p.locoState = LocoState.Run;
  p.speed = 4;
  p.strafeSign = 0;
  p.turnInPlace = false;
  p.updateLocomotion(0.2, 4);
  assert.equal(p.locoState, LocoState.Run);
  const expected = (4 * 0.2) / 4.8;
  assert.ok(Math.abs(p.locoPhase - expected) < 1e-9, `phase=${p.locoPhase} expected=${expected}`);
  assert.equal(p.locoFoot, 'L');
  assert.equal(p.locoContact, true, 'phase 0.17 is inside the left contact window');
});

test('contact windows alternate feet around phase 0 and 0.5', () => {
  const p = player();
  p.locoPhase = 0.05;
  p.syncLocoContact(true);
  assert.equal(p.locoFoot, 'L');
  assert.equal(p.locoContact, true);
  p.locoPhase = 0.3;
  p.syncLocoContact(true);
  assert.equal(p.locoFoot, 'L');
  assert.equal(p.locoContact, false, 'mid-swing is not a contact frame');
  p.locoPhase = 0.55;
  p.syncLocoContact(true);
  assert.equal(p.locoFoot, 'R');
  assert.equal(p.locoContact, true);
  p.locoPhase = 0.8;
  p.syncLocoContact(true);
  assert.equal(p.locoFoot, 'R');
  assert.equal(p.locoContact, false);
});

test('starting from rest begins the gait at the authored contact phase', () => {
  const p = player();
  p.locoState = LocoState.Idle;
  p.locoPhase = 0.73;
  p.speed = 0.8;
  p.updateLocomotion(1 / 30, 1);
  assert.equal(p.locoState, LocoState.Start);
  assert.ok(p.locoPhase < 0.05, `phase=${p.locoPhase}`);
});

test('instant repositioning clears locomotion state and phase', () => {
  const p = player();
  for (let i = 0; i < 60; i++) p.move(1 / 30, 1, 0, MovementType.BestHeCanDo);
  p.setInstantPosition(10, 10, 0);
  assert.equal(p.locoState, LocoState.Idle);
  assert.equal(p.locoPhase, 0);
  assert.equal(p.locoFoot, null);
  assert.equal(p.locoContact, false);
});

test('shield and close carry modes shorten the gait stride', () => {
  const normal = player();
  normal.locoState = LocoState.Walk; normal.speed = 1.5;
  normal.updateLocomotion(1 / 30, 1.5);
  const close = player();
  close.locoState = LocoState.Walk; close.speed = 1.5; close.moveMode = MoveMode.Close;
  close.updateLocomotion(1 / 30, 1.5);
  const shield = player();
  shield.locoState = LocoState.Walk; shield.speed = 1.5; shield.moveMode = MoveMode.Shield;
  shield.updateLocomotion(1 / 30, 1.5);
  assert.ok(shield.locoStride < close.locoStride, `${shield.locoStride} !< ${close.locoStride}`);
  assert.ok(close.locoStride < normal.locoStride, `${close.locoStride} !< ${normal.locoStride}`);
});

test('snapshot exposes locomotion state, phase and contact foot', () => {
  const m = new Match(MODE_CONFIGS.classic5, { seed: 5, humanSlot: null });
  m.phase = Phase.LIVE;
  m.time = 10;
  m.freezeUntil = 0;
  const p = m.players.find((q) => !q.isGoalKeeper);
  for (let i = 0; i < 40; i++) p.move(1 / 30, 1, 0, MovementType.BestHeCanDo);
  const snap = m.getSnapshot().players.find((q) => q.id === p.id);
  assert.ok(Object.values(LocoState).includes(snap.locoState));
  assert.ok(snap.locoPhase >= 0 && snap.locoPhase < 1);
  assert.ok(snap.locoFoot === 'L' || snap.locoFoot === 'R');
  assert.equal(typeof snap.locoContact, 'boolean');
  assert.ok(snap.locoStride > 0);
});

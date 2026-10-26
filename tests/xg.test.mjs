import test from 'node:test';
import assert from 'node:assert/strict';
import { Match, Phase } from '../src/engine/match.js';
import { MODE_CONFIGS } from '../src/config/modes.js';
import { shotGeometry, shotXG, passRetention } from '../src/engine/analytics/xg.js';
import * as V from '../src/engine/vec.js';

const live = () => {
  const m = new Match(MODE_CONFIGS.full11, { seed: 9, humanSlot: null, aiLevel: 0 });
  m.phase = Phase.LIVE;
  m.time = 10;
  m.freezeUntil = 0;
  m.setPiece = null;
  return m;
};

test('shot xG rises with closeness and centrality and falls with blockers', () => {
  const goal = { x: 52.5, z: 0 };
  const near = shotGeometry({ x: 40, z: 0 }, goal, 7.32);
  const far = shotGeometry({ x: 20, z: 0 }, goal, 7.32);
  const wide = shotGeometry({ x: 40, z: 18 }, goal, 7.32);
  const xgNear = shotXG({ ...near, blockers: 0, orientation: 1, reception: 0.8 });
  const xgFar = shotXG({ ...far, blockers: 0, orientation: 1, reception: 0.8 });
  const xgWide = shotXG({ ...wide, blockers: 0, orientation: 1, reception: 0.8 });
  const xgBlocked = shotXG({ ...near, blockers: 2, orientation: 1, reception: 0.8 });
  const xgOneOnOne = shotXG({ ...near, blockers: 0, oneOnOne: true, orientation: 1, reception: 0.8 });
  assert.ok(xgNear > xgFar);
  assert.ok(xgNear > xgWide);
  assert.ok(xgNear > xgBlocked);
  assert.ok(xgOneOnOne > xgNear);
});

test('pass retention rises with lane room, receiver space and control', () => {
  const base = { laneClearance: 1, receiverOpenness: 2, receiverControl: 0.6, distance: 20, passerSkill: 0.7 };
  assert.ok(passRetention({ ...base, laneClearance: 3 }) > passRetention(base));
  assert.ok(passRetention({ ...base, receiverOpenness: 6 }) > passRetention(base));
  assert.ok(passRetention({ ...base, receiverControl: 0.9 }) > passRetention(base));
  assert.ok(passRetention({ ...base, distance: 8 }) > passRetention(base));
});

test('the decision shoots a clear chance and passes when a better option exists', () => {
  const m = live();
  const carrier = m.teams[0].players[9];
  for (const p of m.players) p.setInstantPosition(40, 30);
  carrier.setInstantPosition(35, 0, 0);
  m.ball.pos = V.v3(35, 0.11, 0);
  m.ball.hold(carrier);
  const chance = m.attackDecision(carrier);
  assert.equal(chance.action, 'shoot');
  assert.ok(chance.xg > 0.06);

  const m2 = live();
  const passer = m2.teams[0].players[5];
  const target = m2.teams[0].players[9];
  for (const p of m2.players) p.setInstantPosition(40, 30);
  passer.setInstantPosition(0, 0, 0);
  target.setInstantPosition(15, 0, 0);
  m2.teams[1].players.forEach((p) => p.setInstantPosition(60, 30));
  m2.ball.pos = V.v3(0, 0.11, 0);
  m2.ball.hold(passer);
  const option = m2.attackDecision(passer);
  assert.equal(option.action, 'pass');
  assert.equal(option.target?.id, target.id);
});

test('a shot event carries the xG used by the decision', () => {
  const m = live();
  const shooter = m.teams[0].players[9];
  shooter.setInstantPosition(30, 0, 0);
  m.ball.pos = V.v3(30, 0.11, 0);
  shooter.lastShotXG = 0.12;
  let event = null;
  m.events.on('PlayerShoot', (ev) => { event = ev; });
  m.shootAtGoal(shooter, 0.8, false);
  assert.ok(event);
  assert.equal(event.xg, 0.12);
  assert.ok(event.power <= 30.01);
  assert.equal(shooter.lastShotXG, null);
});

test('the intended receiver chases a pass instead of holding shape', () => {
  const m = live();
  const receiver = m.teams[0].players[9];
  const other = m.teams[0].players[8];
  for (const p of m.players) p.setInstantPosition(40, 30);
  receiver.setInstantPosition(0, 0);
  other.setInstantPosition(10, 0);
  m.ball.reset(V.v3(-5, 0.11, 0));
  m.ball.vel = V.v3(4, 0, 0);
  m.teams[0].phase = 'LOOSE';
  m.teams[0].chaser = other;
  m.ball.intendedReceiverId = receiver.id;
  m.ball.intendedReceiverUntil = m.time + 2;
  m.processBehaviours(receiver, 1 / 30);
  assert.equal(receiver.aiBehaviour, 'PassReceptionBehaviour');
});

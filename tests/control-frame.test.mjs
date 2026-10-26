import test from 'node:test';
import assert from 'node:assert/strict';
import { Match, Phase } from '../src/engine/match.js';
import { MODE_CONFIGS } from '../src/config/modes.js';
import * as V from '../src/engine/vec.js';

const live = () => {
  const m = new Match(MODE_CONFIGS.full11, { seed: 1, humanSlot: 3, aiLevel: 0 });
  m.phase = Phase.LIVE;
  m.time = 10;
  m.freezeUntil = 0;
  m.setPiece = null;
  return m;
};

const move = (m, p, intent, ticks = 60) => {
  const start = V.copy(p.pos);
  for (let i = 0; i < ticks; i++) {
    p.intent = { ...intent };
    m.applyHumanControl(p, 1 / 30);
  }
  return { dx: p.pos.x - start.x, dz: p.pos.z - start.z };
};

test('screen-space world input moves the player without a camera-dependent flip', () => {
  const m = live();
  const home = m.players.find((p) => p.isHuman);
  const away = m.teams[1].players[5];
  home.setInstantPosition(0, 0, 0);
  away.setInstantPosition(0, 0, Math.PI);

  const up = move(m, home, { worldX: 1, worldZ: 0 });
  assert.ok(up.dx > 0.2, `up dx=${up.dx}`);
  assert.ok(Math.abs(up.dz) < 0.2, `up dz=${up.dz}`);

  home.setInstantPosition(0, 0, Math.PI / 2);
  const right = move(m, home, { worldX: 0, worldZ: 1 });
  assert.ok(right.dz > 0.2, `right dz=${right.dz}`);
  assert.ok(Math.abs(right.dx) < 0.2, `right dx=${right.dx}`);

  away.setInstantPosition(0, 0, Math.PI);
  const awayUp = move(m, away, { worldX: -1, worldZ: 0 });
  assert.ok(awayUp.dx < -0.2, `away up dx=${awayUp.dx}`);
});

test('legacy attack-relative axes mirror both forward and lateral for the away team', () => {
  const m = live();
  const home = m.players.find((p) => p.isHuman);
  const away = m.teams[1].players[5];

  home.setInstantPosition(0, 0, 0);
  const hForward = move(m, home, { moveX: 0, moveZ: 1 });
  assert.ok(hForward.dx > 0.2 && Math.abs(hForward.dz) < 0.2);

  home.setInstantPosition(0, 0, Math.PI / 2);
  const hRight = move(m, home, { moveX: 1, moveZ: 0 });
  assert.ok(hRight.dz > 0.2 && Math.abs(hRight.dx) < 0.2);

  away.setInstantPosition(0, 0, Math.PI);
  const aForward = move(m, away, { moveX: 0, moveZ: 1 });
  assert.ok(aForward.dx < -0.2, `away forward dx=${aForward.dx}`);

  away.setInstantPosition(0, 0, -Math.PI / 2);
  const aRight = move(m, away, { moveX: 1, moveZ: 0 });
  assert.ok(aRight.dz < -0.2, `away right dz=${aRight.dz}`);
});

test('world aim chooses the receiver on the screen side for both teams', () => {
  const m = live();
  const home = m.players.find((p) => p.isHuman);
  const away = m.teams[1].players[5];
  const hA = m.teams[0].players[5];
  const hB = m.teams[0].players[6];
  const aA = m.teams[1].players[6];
  const aB = m.teams[1].players[7];
  home.setInstantPosition(0, 0, 0);
  hA.setInstantPosition(10, 10);
  hB.setInstantPosition(10, -10);
  m.teams[0].players.filter((p) => ![home, hA, hB].includes(p)).forEach((p) => p.setInstantPosition(-40, 20));
  m.teams[1].players.forEach((p) => p.setInstantPosition(-60, 0));

  assert.equal(m.bestPassTarget(home, { aimX: 0, aimZ: 1 }), hA);
  assert.equal(m.bestPassTarget(home, { moveX: 1, moveZ: 0 }), hA);

  away.setInstantPosition(0, 0, Math.PI);
  aA.setInstantPosition(-10, 10);
  aB.setInstantPosition(-10, -10);
  m.teams[1].players.filter((p) => ![away, aA, aB].includes(p)).forEach((p) => p.setInstantPosition(40, 20));
  m.teams[0].players.forEach((p) => p.setInstantPosition(60, 0));

  assert.equal(m.bestPassTarget(away, { aimX: 0, aimZ: -1 }), aB);
  assert.equal(m.bestPassTarget(away, { moveX: 1, moveZ: 0 }), aB);
});

test('a screen-space feint bursts in the pressed direction', () => {
  const m = live();
  const carrier = m.players.find((p) => p.isHuman);
  carrier.setInstantPosition(0, 0, 0);
  m.ball.hold(carrier);
  carrier.feintReadyAt = 0;
  assert.equal(m.performFeint(carrier, { worldX: 0, worldZ: 1 }), true);
  assert.ok(carrier.feintVelocity.z > 1);
  assert.ok(Math.abs(carrier.feintVelocity.x) < 1e-6);
});

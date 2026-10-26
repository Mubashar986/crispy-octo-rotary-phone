import test from 'node:test';
import assert from 'node:assert/strict';
import { Match, Phase } from '../src/engine/match.js';
import { LocalMatchHost } from '../src/net/loopback.js';
import { MODE_CONFIGS } from '../src/config/modes.js';
import * as V from '../src/engine/vec.js';

const CFG = MODE_CONFIGS.full11;

const match = (opts = {}) => {
  const m = new Match(CFG, { seed: 4, humanSlot: 9, aiLevel: 0, ...opts });
  m.phase = Phase.LIVE;
  m.time = 10;
  m.freezeUntil = 0;
  m.setPiece = null;
  return m;
};

test('shots are capped at a realistic speed and lose power with distance', () => {
  const m = match();
  const shooter = m.players.find((p) => p.isHuman);
  shooter.setInstantPosition(20, 0, 0);
  m.ball.pos = V.v3(20, 0.11, 0);
  m.shootAtGoal(shooter, 1, false);
  assert.ok(V.len(m.ball.vel) <= 30.01, `full shot ${V.len(m.ball.vel)}`);

  shooter.setInstantPosition(20, 0, 0);
  m.ball.pos = V.v3(20, 0.11, 0);
  m.shootAtGoal(shooter, 0.2, false);
  assert.ok(V.len(m.ball.vel) <= 20.5, `tap shot ${V.len(m.ball.vel)}`);

  shooter.setInstantPosition(0, 0, 0);
  m.ball.pos = V.v3(0, 0.11, 0);
  m.shootAtGoal(shooter, 1, false);
  assert.ok(V.len(m.ball.vel) <= 26, `long shot ${V.len(m.ball.vel)}`);
});

test('calling for a pass makes an open human the preferred target without forcing a bad pass', () => {
  const m = match();
  const human = m.players.find((p) => p.isHuman);
  const passer = m.teams[0].players[5];
  const rival = m.teams[0].players[8];
  for (const p of m.teams[0].players) p.setInstantPosition(-40, 30);
  passer.setInstantPosition(0, 0, 0);
  human.setInstantPosition(12, 0, 0);
  rival.setInstantPosition(22, 0, 0);
  for (const p of m.teams[1].players) p.setInstantPosition(60, 30);
  m.teams[1].players[1].setInstantPosition(12, 5);
  m.teams[1].players[2].setInstantPosition(22, 5);

  assert.equal(m.bestPassTarget(passer), rival);
  assert.equal(m.callForPass(human), true);
  assert.equal(m.bestPassTarget(passer), human);
  assert.equal(m.callForPass(human), false, 'call cooldown');

  m.teams[1].players[1].setInstantPosition(12, 0.4);
  assert.notEqual(m.bestPassTarget(passer), human, 'a marked caller is not forced');
});

test('the human can be a pass target from up to 40m, while AI targets stay at 35m', () => {
  const m = match();
  const human = m.players.find((p) => p.isHuman);
  const passer = m.teams[0].players[5];
  for (const p of m.teams[0].players) p.setInstantPosition(-45, 30);
  passer.setInstantPosition(0, 0, 0);
  human.setInstantPosition(38, 0, 0);
  m.teams[1].players.forEach((p) => p.setInstantPosition(60, 30));
  assert.equal(m.bestPassTarget(passer), human);
});

test('an AI carrier answers a viable call for pass', () => {
  const m = match();
  const human = m.players.find((p) => p.isHuman);
  const carrier = m.teams[0].players[5];
  for (const p of m.teams[0].players) p.setInstantPosition(-40, 30);
  carrier.setInstantPosition(0, 0, 0);
  human.setInstantPosition(12, 0, 0);
  m.teams[1].players.forEach((p) => p.setInstantPosition(60, 30));
  m.ball.hold(carrier);
  m.ball.pos = V.v3(0, 0.11, 0);
  m.teams[0].phase = 'IN_POSSESSION';
  m.teams[0].ballProgress = 0.45;
  m.teams[0].transitionUntil = 0;
  m.callForPass(human);
  m.processBehaviours(carrier, 1 / 30);
  assert.equal(carrier.aiBehaviour, 'AnswerCallBehaviour');
  assert.equal(carrier.passingTarget?.id, human.id);
  assert.equal(m.ball.lastTouch?.id, carrier.id);
});

test('team mode auto-switches to the ball-side defender while player mode stays locked', () => {
  const team = new LocalMatchHost(CFG, { seed: 2, humanSlot: 9, controlMode: 'team' });
  const m = team.match;
  m.phase = Phase.LIVE;
  m.time = 10;
  m.freezeUntil = 0;
  const human = m.players.find((p) => p.isHuman);
  const defender = m.teams[0].players[1];
  for (const p of m.players) p.setInstantPosition(35, 25);
  human.setInstantPosition(20, 0);
  defender.setInstantPosition(0, 0);
  m.ball.hold(m.teams[1].players[5]);
  m.teams[1].players[5].setInstantPosition(0, 0);
  assert.equal(team.autoSwitch(), true);
  assert.equal(team.humanId, defender.id);
  assert.equal(defender.isHuman, true);
  assert.equal(human.isHuman, false);
  team.dispose();

  const player = new LocalMatchHost(CFG, { seed: 2, humanSlot: 9, controlMode: 'player' });
  const pm = player.match;
  pm.phase = Phase.LIVE;
  pm.time = 10;
  const ph = pm.players.find((p) => p.isHuman);
  const pd = pm.teams[0].players[1];
  for (const p of pm.players) p.setInstantPosition(35, 25);
  ph.setInstantPosition(20, 0);
  pd.setInstantPosition(0, 0);
  pm.ball.hold(pm.teams[1].players[5]);
  pm.teams[1].players[5].setInstantPosition(0, 0);
  assert.equal(player.autoSwitch(), false);
  assert.equal(player.humanId, ph.id);
  player.dispose();
});

test('manual switch cycles to the nearest teammate and call has a cooldown', () => {
  const host = new LocalMatchHost(CFG, { seed: 3, humanSlot: 9, controlMode: 'team' });
  const m = host.match;
  m.phase = Phase.LIVE;
  m.time = 10;
  const human = m.players.find((p) => p.isHuman);
  const near = m.teams[0].players[1];
  for (const p of m.players) p.setInstantPosition(40, 20);
  human.setInstantPosition(45, 0);
  near.setInstantPosition(2, 0);
  m.ball.pos = V.v3(0, 0.11, 0);
  assert.equal(host.requestSwitch(), true);
  assert.equal(host.humanId, near.id);
  assert.equal(host.requestCall(), true);
  assert.ok(host.human.calledForPassUntil > m.time);
  assert.equal(host.requestCall(), false);
  host.dispose();
});

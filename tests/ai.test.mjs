import test from 'node:test';
import assert from 'node:assert/strict';
import { Match, Phase } from '../src/engine/match.js';
import { MODE_CONFIGS } from '../src/config/modes.js';
import { TACTIC_PRESETS } from '../src/engine/team.js';
import * as V from '../src/engine/vec.js';

const live = (seed = 7) => {
  const m = new Match(MODE_CONFIGS.full11, { seed });
  m.phase = Phase.LIVE;
  m.time = 10;
  return m;
};

test('balanced team presses with exactly its chase quota and assigns cover', () => {
  const m = live();
  for (const p of m.players) p.setInstantPosition(0, 20);
  m.ball.reset(V.v3(0, 0.11, 0));
  const opponent = m.teams[1].players[5];
  m.ball.hold(opponent);
  m.teams[0].updateProgress();
  assert.equal(m.teams[0].pressers.length, TACTIC_PRESETS.Balanced.chase);
  assert.equal(m.teams[0].pressers[0], m.teams[0].chaser);
});

test('marking assignments are unique and cover every outfield defender', () => {
  const m = live(11);
  for (const [i, p] of m.players.entries()) p.setInstantPosition(-30 + i * 3, -20 + i * 4);
  m.teams[0].updateProgress();
  const targets = m.teams[0].fielders.map((p) => p.markingTarget).filter(Boolean);
  assert.equal(targets.length, m.teams[0].fielders.length);
  assert.equal(new Set(targets.map((p) => p.id)).size, targets.length);
});

test('pass selection penalises a blocked lane and chooses the open teammate', () => {
  const m = live(3);
  const passer = m.teams[0].players[5];
  const blocked = m.teams[0].players[6];
  const open = m.teams[0].players[7];
  passer.setInstantPosition(0, 0);
  blocked.setInstantPosition(20, 0);
  open.setInstantPosition(20, 8);
  m.teams[1].players.forEach((p, i) => p.setInstantPosition(40, -30 + i * 6));
  m.teams[1].players[1].setInstantPosition(10, 0);
  for (const p of m.teams[0].players) {
    if (![passer, blocked, open].includes(p)) p.setInstantPosition(-40, 20);
  }
  assert.equal(m.bestPassTarget(passer), open);
});

test('shot blockers are counted only between shooter and goal', () => {
  const m = live(4);
  const shooter = m.teams[0].players[9];
  shooter.setInstantPosition(20, 0);
  const goal = m.teams[0].attackGoal;
  m.teams[1].players.forEach((p) => p.setInstantPosition(0, 30));
  m.teams[1].players[3].setInstantPosition(36, 0);
  assert.equal(m.shootBlockers(shooter, goal), 1);
  m.teams[1].players[3].setInstantPosition(36, 15);
  assert.equal(m.shootBlockers(shooter, goal), 0);
});

test('a striker runs behind the defensive line when the team is in possession', () => {
  const m = live(5);
  const striker = m.teams[0].players[9];
  const holder = m.teams[0].players[5];
  striker.anchor.band = 'ST';
  striker.setInstantPosition(15, 0);
  holder.setInstantPosition(5, 0);
  m.ball.hold(holder);
  m.teams[0].phase = 'IN_POSSESSION';
  m.teams[0].ballProgress = 0.7;
  m.teams[0].offsideLine = 32;
  m.processBehaviours(striker, 1 / 30);
  assert.equal(striker.aiBehaviour, 'RunBehindDefenseLineBehaviour');
});

test('a midfielder offers a lateral support option instead of crowding the carrier', () => {
  const m = live(6);
  const mid = m.teams[0].players[7];
  const holder = m.teams[0].players[6];
  mid.setInstantPosition(8, 2);
  holder.setInstantPosition(0, 0);
  m.ball.hold(holder);
  m.teams[0].phase = 'IN_POSSESSION';
  m.teams[0].ballProgress = 0.6;
  m.processBehaviours(mid, 1 / 30);
  assert.equal(mid.aiBehaviour, 'SupportPlayBehaviour');
});

test('a pressured carrier with no pass clears the ball to safe space', () => {
  const m = live(8);
  const carrier = m.teams[0].players[6];
  carrier.setInstantPosition(0, 0);
  m.ball.hold(carrier);
  for (const p of m.teams[0].players) {
    if (p !== carrier) p.setInstantPosition(-40, 20);
  }
  m.teams[1].players.forEach((p, i) => p.setInstantPosition(1.6, 0.2 + i * 0.1));
  m.teams[0].phase = 'IN_POSSESSION';
  m.teams[0].ballProgress = 0.5;
  m.processBehaviours(carrier, 1 / 30);
  assert.equal(carrier.aiBehaviour, 'SendBallToSafe');
  assert.equal(m.ball.holder?.id, undefined);
});

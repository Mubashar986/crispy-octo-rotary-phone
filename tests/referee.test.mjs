import test from 'node:test';
import assert from 'node:assert/strict';
import { Match, Phase } from '../src/engine/match.js';
import { LocalMatchHost } from '../src/net/loopback.js';
import { MODE_CONFIGS } from '../src/config/modes.js';
import * as V from '../src/engine/vec.js';

const live = (cfg = MODE_CONFIGS.full11) => {
  const m = new Match(cfg, { seed: 17, humanSlot: null, aiLevel: 0 });
  m.phase = Phase.LIVE;
  m.time = 10;
  m.freezeUntil = 0;
  m.setPiece = null;
  m.clockSec = 0;
  return m;
};

const stoppage = (m) => {
  m.setPiece = 'THROWIN';
  m.freezeUntil = m.time + 100;
};

const firstOutfield = (team) => team.players.find((p) => !p.isGoalKeeper && !p.sentOff && !p.subbedOut);

test('substitutions enforce 5 changes, 3 windows and permanent departures', () => {
  const m = new Match(MODE_CONFIGS.full11, { seed: 21, humanSlot: 5, aiLevel: 0 });
  m.phase = Phase.LIVE;
  m.time = 10;
  const team = m.teams[0];
  const startingBench = team.bench.length;
  assert.equal(startingBench, MODE_CONFIGS.full11.benchSize);
  stoppage(m);

  const out1 = firstOutfield(team);
  const in1 = team.bench[0];
  let result = m.substitute(0, out1.id, in1.id);
  assert.equal(result.ok, true);
  assert.equal(team.subsUsed, 1);
  assert.equal(team.subWindowsUsed, 1);
  assert.equal(team.bench.length, startingBench - 1);
  assert.equal(team.players.includes(in1), true);
  assert.equal(team.players.includes(out1), false);
  assert.equal(team.bench.includes(in1), false);
  assert.equal(team.bench.includes(out1), false);
  assert.equal(m.players.includes(out1), false);

  const out2 = firstOutfield(team);
  const in2 = team.bench[0];
  result = m.substitute(0, out2.id, in2.id);
  assert.equal(result.ok, true);
  assert.equal(team.subsUsed, 2);
  assert.equal(team.subWindowsUsed, 1, 'same stoppage must reuse the window');

  team.subWindowOpen = false;
  stoppage(m);
  result = m.substitute(0, firstOutfield(team).id, team.bench[0].id);
  assert.equal(result.ok, true);
  assert.equal(team.subWindowsUsed, 2);

  team.subWindowOpen = false;
  stoppage(m);
  result = m.substitute(0, firstOutfield(team).id, team.bench[0].id);
  assert.equal(result.ok, true);
  assert.equal(team.subsUsed, 4);
  assert.equal(team.subWindowsUsed, 3);

  team.subWindowOpen = false;
  stoppage(m);
  result = m.substitute(0, firstOutfield(team).id, team.bench[0].id);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'NO_WINDOWS');

  m.phase = Phase.HALF_TIME;
  result = m.substitute(0, firstOutfield(team).id, team.bench[0].id, true);
  assert.equal(result.ok, true, 'half-time change must be allowed after three windows');
  assert.equal(team.subsUsed, 5);
  assert.equal(team.subWindowsUsed, 3, 'half-time must not consume a window');
  assert.equal(team.bench.length, startingBench - 5);

  m.phase = Phase.LIVE;
  stoppage(m);
  result = m.substitute(0, firstOutfield(team).id, team.bench[0].id);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'NO_SUBSTITUTIONS');
});

test('host follows the substituted human and pauses the match', () => {
  const host = new LocalMatchHost(MODE_CONFIGS.full11, { seed: 22, humanSlot: 5, aiLevel: 0 });
  const m = host.match;
  m.phase = Phase.LIVE;
  m.time = 10;
  stoppage(m);
  const human = m.players.find((p) => p.isHuman);
  const incoming = m.teams[0].bench.find((p) => !p.isGoalKeeper);
  const result = host.requestSubstitution(human.id, incoming.id);
  assert.equal(result.ok, true);
  assert.equal(host.humanId, incoming.id);
  assert.equal(incoming.isHuman, true);

  host.setPaused(true);
  const before = host.latestSnapshot.clockSec;
  const after = host.tick(0.5).clockSec;
  assert.equal(after, before);
  host.setPaused(false);
  host.dispose();
});

test('human goalkeeper gets the full six-second holding limit with a warning', () => {
  const host = new LocalMatchHost(MODE_CONFIGS.full11, { seed: 23, humanSlot: 0, aiLevel: 0 });
  const m = host.match;
  m.phase = Phase.LIVE;
  m.time = 10;
  m.freezeUntil = 0;
  m.setPiece = null;
  const gk = m.players.find((p) => p.isHuman);
  m.ball.hold(gk, true);
  gk.ballHoldTime = 4.6;
  let warned = false;
  m.events.on('KeeperHoldWarning', () => { warned = true; });
  m.processBehaviours(gk, 1 / 30);
  assert.equal(warned, true);
  assert.equal(m.ball.heldInHands, true);
  gk.ballHoldTime = 5.85;
  m.processBehaviours(gk, 1 / 30);
  assert.equal(m.ball.heldInHands, true, 'the ball must stay in the hands through the wind-up');
  assert.ok(gk.pendingDistribution, 'the six-second limit schedules a distribution');
  for (let i = 0; i < 20; i++) m.step(1 / 30);
  assert.equal(m.ball.heldInHands, false);
  host.dispose();
});

test('a goalkeeper cannot handle a deliberate backpass', () => {
  const m = live();
  const gk = m.teams[0].players.find((p) => p.isGoalKeeper);
  const mate = m.teams[0].players[5];
  const ownGoal = m.goalNets[0];
  gk.setInstantPosition(ownGoal.x + m.dirFor(0) * 2, 0, 0);
  m.ball.release();
  m.ball.pos = V.v3(gk.pos.x, 0.11, 0.5);
  m.ball.vel = V.v3(0, 0, 0);
  m.ball.lastKickBy = mate;
  m.ball.lastKickAt = m.time;
  m.ball.lastKickKind = 'kick';
  assert.equal(m.isBackpass(gk), true);
  assert.equal(m.canHandleBall(gk), false);
  let warned = false;
  m.events.on('Backpass', () => { warned = true; });
  m.handleTouches(0);
  assert.equal(warned, true);
  assert.equal(m.ball.heldInHands, false);
  m.ball.lastKickKind = 'header';
  assert.equal(m.canHandleBall(gk), true);
});

test('offside position only exists in the opponent half', () => {
  const m = live();
  m.ball.release();
  m.ball.pos = V.v3(-25, 0.11, 0);
  const hitter = m.teams[0].players[5];
  hitter.setInstantPosition(-30, 0, 0);
  m.teams[0].offsideLine = -20;
  const attacker = m.teams[0].players[9];
  attacker.setInstantPosition(-10, 0, 0);
  m.assignOffsides(hitter, false);
  assert.equal(attacker.isInOffside, false, 'own half cannot be offside');
  attacker.setInstantPosition(10, 0, 0);
  m.assignOffsides(hitter, false);
  assert.equal(attacker.isInOffside, true);
});

test('goal kicks move opponents out of the penalty area', () => {
  const m = live();
  const opp = m.teams[1].players[5];
  opp.setInstantPosition(-48, 0, 0);
  assert.equal(m.insidePenaltyArea(0, opp.pos), true);
  m.restart(0, V.v3(-48, 0.11, 0), 'GOALKICK');
  assert.equal(m.insidePenaltyArea(0, opp.pos), false);
  assert.equal(m.ball.holder, m.teams[0].players.find((p) => p.isGoalKeeper));
  assert.equal(m.stats.goalKicks[0], 1);
});

test('match stats track possession, shots, passes and saves', () => {
  const m = live();
  const p = m.teams[0].players[5];
  const q = m.teams[0].players[7];
  p.setInstantPosition(0, 0, 0);
  q.setInstantPosition(5, 0, 0);
  m.ball.hold(p);
  m.ball.pos = V.v3(0, 0.11, 0);
  m.step(0.1);
  assert.ok(m.stats.possession[0] > 0);

  const passesBefore = m.stats.passes[0];
  m.ball.pass(q.pos, p, 1);
  assert.equal(m.stats.passes[0], passesBefore + 1);
  m.onBallControlled(q);
  assert.equal(m.stats.passesCompleted[0], 1);
  assert.equal(m.playerStats.get(p.id).passesCompleted, 1);

  m.shootAtGoal(q, 0.7, false);
  assert.equal(m.stats.shots[0], 1);
  assert.ok(m.stats.xg[0] > 0);
  assert.equal(m.playerStats.get(q.id).shots, 1);

  const keeper = m.teams[1].players.find((x) => x.isGoalKeeper);
  const ownGoal = m.goalNets[1];
  keeper.setInstantPosition(ownGoal.x + m.dirFor(1) * 0.5, 0, 0);
  m.ball.release();
  m.ball.pos = V.v3(keeper.pos.x - m.dirFor(1) * 0.3, 0.11, 0);
  m.ball.vel = V.v3(0, 0, 0);
  m.ball.lastShot = { team: 0, playerId: q.id, at: m.time };
  m.ball.lastKickBy = q;
  m.ball.lastKickAt = m.time;
  m.ball.lastKickKind = 'kick';
  assert.equal(m.gkContact(keeper), true);
  assert.equal(m.stats.saves[1], 1);
  assert.equal(m.stats.onTarget[0], 1);
  assert.equal(m.playerStats.get(keeper.id).saves, 1);

  const snap = m.getSnapshot();
  assert.equal(snap.stats.possession[0] + snap.stats.possession[1], 100);
  assert.equal(snap.stats.shots[0], 1);
  assert.ok(snap.substitutions[0].remaining >= 0);
  assert.ok(Array.isArray(snap.bench[0]));
});

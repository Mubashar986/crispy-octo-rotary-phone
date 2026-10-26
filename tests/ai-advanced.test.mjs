import test from 'node:test';
import assert from 'node:assert/strict';
import { Match, Phase } from '../src/engine/match.js';
import { MODE_CONFIGS } from '../src/config/modes.js';
import { BALL_RADIUS } from '../src/engine/ball.js';
import { AICrossingBehaviour } from '../src/engine/behaviours/index.js';
import * as V from '../src/engine/vec.js';

const live = (seed = 7) => {
  const m = new Match(MODE_CONFIGS.full11, { seed, aiLevel: 0 });
  m.phase = Phase.LIVE;
  m.time = 10;
  return m;
};

const park = (m, teamId, x = 45, z = -30) => {
  for (const p of m.teams[teamId].players) p.setInstantPosition(x, z);
};

const giveBall = (m, p, facing = p.facing) => {
  p.setInstantPosition(p.pos.x, p.pos.z, facing);
  m.ball.hold(p);
  m.ball.pos = V.v3(p.pos.x, BALL_RADIUS, p.pos.z);
};

test('rosters carry the role bands used by run-behind, overlap and box overload', () => {
  const m = live();
  const bands = new Set(m.teams[0].fielders.map((p) => p.anchor.band));
  assert.deepEqual([...bands].sort(), ['CB', 'CM', 'ST']);
  assert.equal(m.teams[0].players.find((p) => p.isGoalKeeper).anchor.band, 'GK');
});

test('a pressured carrier plays a one-two and the partner returns the pass', () => {
  const m = live(10);
  const carrier = m.teams[0].players[5];
  const partner = m.teams[0].players[6];
  park(m, 0);
  park(m, 1, 40, -25);
  carrier.setInstantPosition(-5, 0, 0.4);
  partner.setInstantPosition(4, 3, 0);
  m.teams[1].players[1].setInstantPosition(-5, 2);
  giveBall(m, carrier, 0.4);
  m.teams[0].phase = 'IN_POSSESSION';
  m.teams[0].ballProgress = 0.45;

  m.processBehaviours(carrier, 1 / 30);
  assert.equal(carrier.aiBehaviour, 'OneTwoBehaviour');
  assert.ok(carrier.oneTwoUntil > m.time);
  assert.equal(m.teams[0].oneTwo?.partnerId, partner.id);

  m.time += 0.4;
  giveBall(m, partner);
  partner.ballHoldTime = 0.2;
  m.teams[0].phase = 'IN_POSSESSION';
  m.processBehaviours(partner, 1 / 30);

  assert.equal(partner.aiBehaviour, 'OneTwoReturnBehaviour');
  assert.equal(m.teams[0].oneTwo, null);
  assert.equal(m.ball.holder, null);
  assert.equal(m.ball.lastTouch?.id, partner.id);
});

test('after a one-two the passer runs forward while the return travels', () => {
  const m = live(11);
  const passer = m.teams[0].players[5];
  const ball = m.ball;
  park(m, 0);
  park(m, 1, 40, -25);
  passer.setInstantPosition(0, 0, 0);
  passer.oneTwoUntil = m.time + 1.7;
  passer.oneTwoPartner = m.teams[0].players[6].id;
  m.teams[0].phase = 'IN_POSSESSION';
  m.teams[0].ballProgress = 0.45;
  ball.reset(V.v3(8, BALL_RADIUS, 3));
  ball.vel = V.v3(2, 0, -1);

  m.processBehaviours(passer, 1 / 30);
  assert.equal(passer.aiBehaviour, 'PassAndRunBehaviour');
});

test('the ball-side defender overlaps while the far-side defender holds shape', () => {
  const m = live(12);
  const holder = m.teams[0].players[5];
  const near = m.teams[0].players[1];
  const far = m.teams[0].players[2];
  park(m, 0);
  park(m, 1, 40, -25);
  holder.setInstantPosition(0, 12);
  near.setInstantPosition(-5, 10);
  far.setInstantPosition(-5, -20);
  giveBall(m, holder);
  m.teams[0].phase = 'IN_POSSESSION';
  m.teams[0].ballProgress = 0.55;

  m.processBehaviours(near, 1 / 30);
  assert.equal(near.aiBehaviour, 'OverlapUnderlapBehaviour');

  m.processBehaviours(far, 1 / 30);
  assert.notEqual(far.aiBehaviour, 'OverlapUnderlapBehaviour');
});

test('a midfielder underlaps the same wide attack from the inside channel', () => {
  const m = live(13);
  const holder = m.teams[0].players[5];
  const mid = m.teams[0].players[7];
  park(m, 0);
  park(m, 1, 40, -25);
  holder.setInstantPosition(0, 12);
  mid.setInstantPosition(-4, 11);
  giveBall(m, holder);
  m.teams[0].phase = 'IN_POSSESSION';
  m.teams[0].ballProgress = 0.55;
  m.processBehaviours(mid, 1 / 30);
  assert.equal(mid.aiBehaviour, 'OverlapUnderlapBehaviour');
  assert.ok(mid.pos.z < holder.pos.z, 'underlap stays inside the carrier');
});

test('strikers occupy opposite posts when the ball reaches the final third', () => {
  const m = live(14);
  const holder = m.teams[0].players[5];
  const strikers = m.teams[0].players.filter((p) => p.role === 'ST');
  park(m, 0);
  park(m, 1, 40, -25);
  holder.setInstantPosition(10, 5);
  giveBall(m, holder);
  m.teams[0].phase = 'IN_POSSESSION';
  m.teams[0].ballProgress = 0.66;
  m.teams[0].offsideLine = -20;
  for (const st of strikers) {
    st.setInstantPosition(20, st.anchor.h < 0.5 ? -8 : 8);
    m.processBehaviours(st, 1 / 30);
    assert.equal(st.aiBehaviour, 'BoxOverloadBehaviour');
  }
  for (let i = 0; i < 180; i++) {
    m.time += 1 / 30;
    m.teams[0].phase = 'IN_POSSESSION';
    m.teams[0].ballProgress = 0.66;
    m.teams[0].offsideLine = -20;
    giveBall(m, holder);
    for (const st of strikers) m.processBehaviours(st, 1 / 30);
  }
  const goal = m.teams[0].attackGoal;
  const xs = strikers.map((p) => p.pos.x);
  const zs = strikers.map((p) => p.pos.z);
  assert.ok(xs.every((x) => Math.abs(goal.x - x) < 12), 'both strikers attack the box');
  assert.ok(Math.sign(zs[0]) !== Math.sign(zs[1]), 'near and far post are split');
});

test('cross utility chooses the open near-post runner and a cutback spots the penalty area', () => {
  const m = live(15);
  const carrier = m.teams[0].players[6];
  const near = m.teams[0].players[9];
  const far = m.teams[0].players[10];
  const cutRunner = m.teams[0].players[8];
  park(m, 0, -40, 30);
  park(m, 1, 10, -30);
  carrier.setInstantPosition(30, 25, 0);
  near.setInstantPosition(45, 3, 0);
  far.setInstantPosition(40, -20, 0);
  giveBall(m, carrier);

  const option = m.bestCrossOption(carrier);
  assert.ok(option);
  assert.equal(option.player.id, near.id);
  assert.equal(option.post, 'near');
  assert.ok(Math.abs(option.point.z) < m.cfg.goalW / 2);
  assert.deepEqual(m.bestCrossTarget(carrier), option.point);

  carrier.setInstantPosition(48, 25, 0);
  near.setInstantPosition(-40, 30);
  far.setInstantPosition(-40, 30);
  cutRunner.setInstantPosition(41.5, 0, 0);
  giveBall(m, carrier);
  const cut = m.bestCutbackTarget(carrier);
  assert.ok(cut);
  assert.equal(cut.player.id, cutRunner.id);
  assert.ok(Math.abs(cut.point.x - (m.teams[0].attackGoal.x - 11)) < 1e-6);
  assert.ok(Math.abs(cut.point.z) < 8);
});

test('a wide carrier crosses in front of the box and cuts back from the byline', () => {
  const m = live(16);
  const behaviour = new AICrossingBehaviour();
  const carrier = m.teams[0].players[6];
  const runner = m.teams[0].players[9];
  park(m, 0, -40, 30);
  park(m, 1, 10, -30);
  carrier.setInstantPosition(30, 25, 0);
  runner.setInstantPosition(45, 3, 0);
  giveBall(m, carrier);
  m.teams[0].ballProgress = 0.8;
  let crossed = null;
  m.events.on('PlayerCross', (e) => { crossed = e; });

  behaviour.set(m.behaviourContext(carrier, 1 / 30));
  assert.equal(behaviour.behave(), true);
  assert.ok(crossed);
  assert.equal(m.ball.lastTouch?.id, carrier.id);
  assert.ok(Math.abs(crossed.target.z) < m.cfg.goalW / 2, 'cross aims inside the posts');

  carrier.setInstantPosition(48, 25, 0);
  runner.setInstantPosition(41.5, 0, 0);
  giveBall(m, carrier);
  m.teams[0].ballProgress = 0.9;
  let passed = null;
  m.events.on('PlayerPass', (e) => { passed = e; });
  behaviour.set(m.behaviourContext(carrier, 1 / 30));
  assert.equal(behaviour.behave(), true);
  assert.ok(passed, 'cutback is a pass, not a hopeful cross');
  assert.ok(m.ball.vel.x < 0, 'cutback travels back across the box');
});

test('an aerial duel is won by the stronger jumper and recorded as contested', () => {
  const m = live(17);
  const winner = m.teams[0].players[9];
  const loser = m.teams[1].players[9];
  const outlet = m.teams[0].players[5];
  park(m, 0, -40, 30);
  park(m, 1, 40, -30);
  outlet.setInstantPosition(10, 10);
  winner.setInstantPosition(0.5, 0);
  loser.setInstantPosition(-0.5, 0);
  Object.assign(winner.skills, { jump: 100, strength: 100, reaction: 100 });
  Object.assign(loser.skills, { jump: 40, strength: 40, reaction: 40 });
  m.ball.reset(V.v3(0, 2.1, 0));
  m.ball.vel = V.v3(0, -0.8, 0);
  let header = null;
  m.events.on('PlayerHeader', (e) => { header = e; });

  m.handleTouches(0);

  assert.ok(header);
  assert.equal(header.player.id, winner.id);
  assert.equal(header.contested, true);
  assert.ok(winner.jumpHeight > 0);
  assert.equal(winner.animMode, 'HEADER');
});

test('a second-ball runner attacks the drop while the chaser presses', () => {
  const m = live(18);
  const chaser = m.teams[0].players[5];
  const runner = m.teams[0].players[6];
  const other = m.teams[0].players[7];
  park(m, 0);
  park(m, 1, 40, -30);
  chaser.setInstantPosition(15, 0);
  runner.setInstantPosition(1, 1);
  other.setInstantPosition(-30, 25);
  m.ball.reset(V.v3(0, 3, 0));
  m.ball.vel = V.v3(0, -4, 0);
  m.teams[0].phase = 'LOOSE';
  m.teams[0].chaser = chaser;

  m.processBehaviours(runner, 1 / 30);
  assert.equal(runner.aiBehaviour, 'SecondBallBehaviour');

  m.processBehaviours(chaser, 1 / 30);
  assert.equal(chaser.aiBehaviour, 'BallChasingBehaviour');
});

test('a defensive wall stands 9.15m from the ball and attackers retreat 2m', () => {
  const m = live(19);
  for (const p of m.players) p.setInstantPosition(40, -30);
  const spot = V.v3(10, BALL_RADIUS, 0);
  m.freeKick(0, spot, 'FOUL');

  const wall = m.teams[1].players.filter((p) => V.distXZ(p.pos, spot) < 10);
  assert.equal(wall.length, 3);
  for (const p of wall) {
    const d = V.distXZ(p.pos, spot);
    assert.ok(d > 8.8 && d < 9.6, `${p.id} wall distance ${d.toFixed(2)}`);
  }
  const taker = m.ball.holder;
  for (const p of m.teams[0].fielders) {
    if (p === taker) continue;
    assert.ok(V.distXZ(p.pos, spot) >= 2.15, `${p.id} is inside the 2m exclusion`);
  }
});

test('foul risk rises for lunges from behind and standing tackles', () => {
  const m = live(20);
  const carrier = m.teams[0].players[5];
  const front = m.teams[1].players[1];
  const behind = m.teams[1].players[2];
  carrier.setInstantPosition(0, 0, 0);
  front.setInstantPosition(1, 0);
  behind.setInstantPosition(-1, 0);
  front.speed = 0;
  behind.speed = 0;

  const frontSlide = m.tackleFoulRisk(front, carrier, true);
  const behindSlide = m.tackleFoulRisk(behind, carrier, true);
  assert.ok(behindSlide > frontSlide + 0.3);
  assert.ok(m.tackleFoulRisk(behind, carrier, false) < behindSlide);
});

test('a controlled reception turns the first touch away from the nearest presser', () => {
  const m = live(21);
  const receiver = m.teams[0].players[5];
  const marker = m.teams[1].players[1];
  park(m, 0, -40, 30);
  park(m, 1, 40, -30);
  receiver.setInstantPosition(0, 0, 0);
  receiver.skills.ballControl = 100;
  marker.setInstantPosition(0.9, 0.5);
  m.ball.reset(V.v3(0.5, BALL_RADIUS, 0));
  m.ball.vel = V.v3(-5, 0, 0);
  const baseRng = m.rng;
  m.rng = Object.assign(() => 0, { range: baseRng.range, sign: baseRng.sign });

  m.handleTouches(0);

  assert.equal(m.ball.holder?.id, receiver.id);
  assert.ok(receiver.receptionQuality > 0.9);
  const away = V.normalizeXZ(V.sub(receiver.pos, marker.pos));
  assert.ok(V.dotXZ(V.fromHeading(receiver.facing), away) > 0.8);
  m.rng = baseRng;
});

test('only the deepest centre-back stays home while the team attacks', () => {
  const m = live(22);
  const holder = m.teams[0].players[5];
  park(m, 0);
  park(m, 1, 40, -25);
  holder.setInstantPosition(0, 0);
  m.ball.hold(holder);
  m.teams[0].phase = 'IN_POSSESSION';
  m.teams[0].ballProgress = 0.7;
  const cbs = m.teams[0].fielders.filter((p) => p.anchor.band === 'CB');
  cbs.forEach((p, i) => p.setInstantPosition(-10 + i * 4, 0));
  for (const cb of cbs) m.processBehaviours(cb, 1 / 30);
  const rest = cbs.filter((p) => p.aiBehaviour === 'RestDefenceBehaviour');
  assert.equal(rest.length, 1);
  assert.equal(rest[0], cbs.slice().sort((a, b) => a.anchor.v - b.anchor.v)[0]);
});

test('corner routines split the strikers across the near and far post', () => {
  const m = live(23);
  const gx = m.goalNets[1].x;
  let taken = null;
  m.events.on('CornerTaken', (e) => { taken = e; });
  m.restart(0, V.v3(gx - 0.6, BALL_RADIUS, m.fieldHalfZ), 'CORNER');
  const strikers = m.teams[0].players.filter((p) => p.role === 'ST');
  const base = m.rng;
  m.rng = Object.assign(() => 0.9, { range: base.range, sign: base.sign });
  m.executeSetPiece();
  m.rng = base;

  assert.ok(taken);
  assert.equal(taken.short, false);
  assert.ok(['near', 'far'].includes(taken.post));
  assert.equal(m.ball.lastTouchTeam, 0);
  assert.ok(strikers.every((p) => Math.abs(gx - p.pos.x) >= 4 && Math.abs(gx - p.pos.x) <= 9));
  assert.ok(Math.sign(strikers[0].pos.z) !== Math.sign(strikers[1].pos.z));
  assert.ok(Math.abs(Math.abs(strikers[0].pos.z) - m.cfg.goalW * 0.34) < 2);
});

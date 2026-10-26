import test from 'node:test';
import assert from 'node:assert/strict';
import { Match, Phase } from '../src/engine/match.js';
import { MODE_CONFIGS } from '../src/config/modes.js';
import { BALL_RADIUS } from '../src/engine/ball.js';
import * as V from '../src/engine/vec.js';

function goalKick(cfg, team, seed = 123) {
  const m = new Match(cfg, { seed, humanSlot: null });
  m.phase = Phase.LIVE;
  const sign = team === 0 ? -1 : 1;
  m.restart(team, V.v3(sign * (m.fieldHalfX - 4), BALL_RADIUS, 0), 'GOALKICK');
  return m;
}

for (const cfg of Object.values(MODE_CONFIGS)) {
  for (const team of [0, 1]) {
    test(`${cfg.id} team ${team}: 32 seeded goal kicks land in field and do not roll out untouched`, () => {
      for (let seed = 0; seed < 32; seed++) {
        const m = goalKick(cfg, team, seed);
        const keeper = m.ball.holder;
        m.gkClear(keeper);
        const target = V.copy(m.ball.crossTarget);
        let landed = false;
        for (let tick = 0; tick < 120 * 8; tick++) {
          m.ball.step(1 / 120);
          const b = m.ball.pos;
          assert.ok(Number.isFinite(b.x + b.y + b.z), `non-finite flight ${seed}`);
          assert.ok(Math.abs(b.x) <= m.fieldHalfX + 0.05, `endline exit ${seed}: ${b.x}`);
          assert.ok(Math.abs(b.z) <= m.fieldHalfZ + 0.05, `touchline exit ${seed}: ${b.z}`);
          if (!landed && tick > 1 && b.y <= BALL_RADIUS + 0.001) {
            landed = true;
            assert.ok(V.distXZ(b, target) < 0.8, `missed intended landing ${seed}`);
          }
        }
        assert.ok(landed, `never landed ${seed}`);
      }
    });

    test(`${cfg.id} team ${team}: bot matches leave the restart loop and resume outfield play`, () => {
      for (let seed = 0; seed < 8; seed++) {
        const m = goalKick({ ...cfg, durationSec: 90 }, team, seed);
        let controls = 0, consecutiveGoalKicks = 1, maxChain = 1;
        m.events.on('PlayerControlBall', ev => {
          if (!ev.player.isGoalKeeper) { controls++; consecutiveGoalKicks = 0; }
        });
        m.events.on('PlayerTouchTheBall', ev => {
          if (!ev.player.isGoalKeeper) consecutiveGoalKicks = 0;
        });
        m.events.on('GoalKick', () => {
          consecutiveGoalKicks++;
          maxChain = Math.max(maxChain, consecutiveGoalKicks);
        });
        for (let i = 0; i < 30 * 45; i++) m.step(1 / 30);
        assert.ok(controls > 0, `no outfield possession: seed ${seed}`);
        assert.ok(maxChain < 3, `goal-kick loop (${maxChain}): seed ${seed}`);
      }
    });
  }
}

test('goal kick always selects keeper even when an outfield player is closer', () => {
  const m = new Match(MODE_CONFIGS.classic5, { seed: 4 });
  const spot = V.v3(-m.fieldHalfX + 4, BALL_RADIUS, 0);
  m.teams[0].fielders[0].setInstantPosition(spot.x, spot.z);
  m.teams[0].players[0].setInstantPosition(0, 0);
  m.restart(0, spot, 'GOALKICK');
  assert.equal(m.ball.holder?.role, 'GK');
  assert.equal(m.ball.holder?.isGoalKickHolder, true);
});

test('keeper distribution chooses an open short receiver instead of a random far target', () => {
  const m = goalKick(MODE_CONFIGS.classic5, 0);
  const keeper = m.ball.holder;
  const receiver = m.teams[0].fielders[0];
  receiver.setInstantPosition(keeper.pos.x + 9, 5);
  for (const p of m.teams[0].fielders.slice(1)) p.setInstantPosition(m.fieldHalfX - 4, m.fieldHalfZ - 4);
  for (const p of m.teams[1].players) p.setInstantPosition(m.fieldHalfX - 6, -m.fieldHalfZ + 4);
  let distribution;
  m.events.on('GKDegage', ev => { distribution = ev; });
  m.gkClear(keeper);
  assert.equal(distribution.receiverId, receiver.id);
  assert.ok(V.distXZ(distribution.target, receiver.pos) < 1);
  assert.ok(distribution.target.x < 0);
});

test('keeper falls back to safe space when no short receiver is available', () => {
  const m = goalKick(MODE_CONFIGS.classic5, 0);
  for (const p of m.teams[0].fielders) p.setInstantPosition(-m.fieldHalfX + 2, m.fieldHalfZ - 2);
  m.gkClear(m.ball.holder);
  assert.ok(m.ball.crossTarget.x < 0);
  assert.ok(Math.abs(m.ball.crossTarget.z) < 0.25);
});

test('keeper does not chase and re-catch their own distribution', () => {
  const m = goalKick(MODE_CONFIGS.classic5, 0);
  const keeper = m.ball.holder;
  m.time = 1;
  let catches = 0;
  m.events.on('KeeperSavesTheBall', ev => { if (ev.player.id === keeper.id) catches++; });
  m.gkClear(keeper);
  const until = m.ball.ignoreHitterUntil;
  assert.ok(until > m.time + 0.8);
  for (let i = 0; i < 20; i++) m.step(1 / 30);
  assert.equal(catches, 0);
});

test('human shoot button at a goal kick uses distribution, not a full-field shot', () => {
  const m = goalKick(MODE_CONFIGS.classic5, 0);
  const keeper = m.ball.holder;
  keeper.isHuman = true;
  keeper.intent = { shoot: true, shootPower: 1 };
  m.time = 1;
  let distributions = 0, shots = 0, started = 0;
  m.events.on('GKDegage', () => distributions++);
  m.events.on('GkDistributionStarted', () => started++);
  m.events.on('PlayerShoot', () => shots++);
  m.processBehaviours(keeper, 1 / 30);
  assert.equal(started, 1, 'human distribution should be scheduled');
  assert.equal(distributions, 0, 'the ball must not leave before the contact frame');
  assert.equal(m.ball.holder, keeper, 'the keeper keeps the ball during the wind-up');
  for (let i = 0; i < 20; i++) m.step(1 / 30);
  assert.equal(distributions, 1);
  assert.equal(shots, 0);
  assert.equal(keeper.isGoalKickHolder, false);
  assert.equal(m.ball.holder, null);
});

test('keeper distribution releases only on the contact frame', () => {
  const m = goalKick(MODE_CONFIGS.classic5, 0);
  const keeper = m.ball.holder;
  m.ball.hold(keeper, true);
  keeper.isGoalKickHolder = false;
  keeper.ballHoldTime = 3;
  m.time = 1;
  let started = null, released = null;
  m.events.on('GkDistributionStarted', (ev) => { started = ev; });
  m.events.on('GKDegage', (ev) => { released = ev; });
  assert.equal(m.gkDistribute(keeper), true);
  assert.ok(keeper.pendingDistribution);
  assert.equal(m.ball.holder, keeper);
  assert.equal(m.ball.heldInHands, true);
  for (let i = 0; i < 10; i++) m.step(1 / 30);
  assert.equal(released, null, 'ball left the hands during the wind-up');
  for (let i = 0; i < 10; i++) m.step(1 / 30);
  assert.ok(released, 'distribution never released');
  assert.ok(started);
  assert.ok(released.heldFor >= 0.4, `heldFor=${released.heldFor}`);
  assert.equal(m.ball.holder, null);
  assert.equal(m.ball.heldInHands, false);
});

test('keeper hold behaviour schedules a distribution once and does not loop', () => {
  const m = goalKick(MODE_CONFIGS.classic5, 0);
  const keeper = m.ball.holder;
  keeper.ballHoldTime = 3;
  m.time = 1;
  let started = 0;
  m.events.on('GkDistributionStarted', () => started++);
  m.processBehaviours(keeper, 1 / 30);
  m.processBehaviours(keeper, 1 / 30);
  assert.equal(started, 1, 'a pending distribution must not be rescheduled');
  assert.ok(keeper.pendingDistribution);
});

test('loft solver compensates launch height as well as air drag', () => {
  const m = goalKick(MODE_CONFIGS.classic5, 0);
  m.ball.hold(m.ball.holder, true);
  const target = V.v3(-9, BALL_RADIUS, 4);
  const velocity = m.ball.velocityForFlightTime(target, 1.6);
  m.ball.release();
  m.ball.vel = velocity;
  m.ball.spin = V.v3();
  for (let i = 0; i < 192; i++) m.ball.step(1 / 120);
  assert.ok(V.distXZ(m.ball.pos, target) < 0.01);
  assert.ok(Math.abs(m.ball.pos.y - BALL_RADIUS) < 0.01);
});

function keeperSetup(team = 0, seed = 314) {
  const m = new Match(MODE_CONFIGS.classic5, { seed, humanSlot: null });
  m.phase = Phase.LIVE;
  m.time = 5;
  m.freezeUntil = 0;
  m.setPiece = null;
  const keeper = m.teams[team].players.find((p) => p.isGoalKeeper);
  const ownGoal = m.teams[team].ownGoal;
  const dir = m.dirFor(team);
  keeper.setInstantPosition(ownGoal.x + dir * 3, 0, dir > 0 ? 0 : Math.PI);
  m.players.filter((p) => p !== keeper).forEach((p, i) => p.setInstantPosition(ownGoal.x + dir * (8 + i), 14, 0));
  m.ball.reset({ x: keeper.pos.x + dir * 0.4, y: BALL_RADIUS, z: keeper.pos.z });
  m.ball.vel = V.v3(dir * 9, 0, 0);
  return { m, keeper, dir };
}

test('keeper catch enters HOLD, distributes on contact, then recovers to SET', () => {
  const { m, keeper } = keeperSetup();
  let catchEvent = null;
  let startEvent = null;
  let releaseEvent = null;
  m.events.on('KeeperSavesTheBall', (ev) => { catchEvent = ev; });
  m.events.on('GkDistributionStarted', (ev) => { startEvent = ev; });
  m.events.on('GKDegage', (ev) => { releaseEvent = ev; });
  assert.equal(m.gkContact(keeper), true);
  assert.equal(keeper.gkState, 'HOLD');
  assert.equal(catchEvent?.outcome, 'catch');
  assert.equal(m.getSnapshot().players.find((p) => p.id === keeper.id).gkState, 'HOLD');

  keeper.ballHoldTime = 3;
  m.step(1 / 30);
  assert.ok(startEvent, 'hold limit should schedule a distribution');
  assert.equal(keeper.gkState, 'DISTRIBUTE');
  assert.ok(keeper.pendingDistribution);

  for (let i = 0; i < 20 && !releaseEvent; i++) m.step(1 / 30);
  assert.ok(releaseEvent, 'distribution never reached its contact frame');
  assert.ok(releaseEvent.heldFor >= 0.4, `heldFor=${releaseEvent.heldFor}`);
  assert.equal(m.ball.holder, null);
  assert.equal(m.ball.heldInHands, false);
  assert.equal(keeper.gkState, 'RECOVER');
  for (let i = 0; i < 15; i++) m.step(1 / 30);
  assert.equal(keeper.gkState, 'SET');
});

test('keeper catch chance falls with shot speed, height and lateral reach', () => {
  const { m, keeper } = keeperSetup();
  const easy = m.keeperCatchChance(keeper, 16, BALL_RADIUS, 0);
  const hard = m.keeperCatchChance(keeper, 30, 1.9, 0.8);
  assert.ok(easy > hard, `easy=${easy.toFixed(3)} hard=${hard.toFixed(3)}`);
  assert.ok(hard >= 0.08 && easy <= 0.94);
});

test('a keeper holding the ball cannot be tackled or knocked off balance', () => {
  const { m, keeper } = keeperSetup();
  m.ball.hold(keeper, true);
  keeper.balance = 0.1;
  const opponent = m.teams[1].players.find((p) => !p.isGoalKeeper);
  opponent.setInstantPosition(keeper.pos.x + 0.6, keeper.pos.z, Math.PI);
  opponent.vx = -3; opponent.vz = 0; opponent.speed = 3;
  m.attemptTackle(opponent, false);
  assert.equal(m.ball.holder, keeper);
  assert.equal(m.ball.heldInHands, true);
  m.separatePlayers(1 / 30);
  assert.equal(m.ball.holder, keeper, 'a shoulder charge must not dislodge a held ball');
  assert.equal(keeper.balance, 0.1, 'protected keepers do not lose balance');
  assert.equal(keeper.stunned, false);
  assert.ok(opponent.balance < 1, 'the charging player still absorbs the contact');
});

test('a deliberate backpass cannot be picked up by the keeper', () => {
  const { m, keeper } = keeperSetup();
  m.ball.release();
  const teammate = m.teams[0].fielders[0];
  m.ball.lastKickBy = teammate;
  m.ball.lastKickKind = 'kick';
  m.ball.lastKickAt = m.time - 0.5;
  m.ball.pos = V.v3(keeper.pos.x + 0.4, BALL_RADIUS, keeper.pos.z);
  m.ball.vel = V.v3(-2, 0, 0);
  assert.equal(m.canHandleBall(keeper), false);
  assert.equal(m.gkContact(keeper), false);
  assert.equal(m.ball.heldInHands, false);
  m.handleTouches(0);
  assert.notEqual(m.ball.heldInHands, true, 'backpasses must be played with the feet');
});

test('goal kicks use a punt and held-ball distributions use throws or rolls', () => {
  const m = goalKick(MODE_CONFIGS.classic5, 0);
  const keeper = m.ball.holder;
  assert.equal(m.gkChooseDistribution(keeper).kind, 'punt');
  m.ball.hold(keeper, true);
  keeper.isGoalKickHolder = false;
  const near = m.teams[0].fielders[0];
  near.setInstantPosition(keeper.pos.x + 8, 4);
  for (const p of m.teams[0].fielders.slice(1)) p.setInstantPosition(m.fieldHalfX - 4, m.fieldHalfZ - 4);
  for (const p of m.teams[1].players) p.setInstantPosition(m.fieldHalfX - 6, -m.fieldHalfZ + 4);
  assert.equal(m.gkChooseDistribution(keeper).kind, 'throw');
});

test('keeper jumps to claim a dropping cross above shoulder height', () => {
  const { m, keeper } = keeperSetup();
  const rng = m.rng;
  m.rng = new Proxy(rng, { apply: () => 0 });
  m.ball.release();
  m.ball.pos = V.v3(keeper.pos.x + 0.5, 2.2, keeper.pos.z);
  m.ball.vel = V.v3(0, -1.2, 0);
  m.ball.spin = V.v3();
  m.handleTouches(0);
  m.rng = rng;
  assert.equal(m.ball.holder, keeper, 'the keeper should claim the high ball');
  assert.equal(m.ball.heldInHands, true);
  assert.ok(keeper.jumpHeight > 0, 'a high claim should use a jump');
  assert.equal(keeper.gkState, 'HOLD');
});

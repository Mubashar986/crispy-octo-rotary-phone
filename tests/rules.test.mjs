import test from 'node:test';
import assert from 'node:assert/strict';
import { Match, Phase } from '../src/engine/match.js';
import { MODE_CONFIGS } from '../src/config/modes.js';
import * as V from '../src/engine/vec.js';

const live = (cfg = MODE_CONFIGS.full11) => {
  const m = new Match(cfg, { seed: 6, humanSlot: null, aiLevel: 0 });
  m.phase = Phase.LIVE;
  m.time = 10;
  m.freezeUntil = 0;
  m.setPiece = null;
  m.clockSec = 0;
  return m;
};

test('the HUD clock is scaled to match minutes and added time appears only late', () => {
  const m = new Match(MODE_CONFIGS.full11, { seed: 6, humanSlot: null, aiLevel: 0 });
  m.phase = Phase.LIVE;
  m.half = 1;
  m.clockSec = 120;
  m.addedTime = [10, 0];
  assert.equal(m.matchMinutes, 90);
  assert.equal(Math.round(m.displayClockSec), 18 * 60);
  assert.equal(m.displayAddedMinutes, 0, 'no added-time badge early in the half');

  m.clockSec = 290;
  assert.equal(m.displayAddedMinutes, 2, 'ten real seconds become two match minutes');

  m.phase = Phase.HALF_TIME;
  assert.equal(m.displayClockSec, 45 * 60);
  assert.equal(m.displayAddedMinutes, 2);

  m.phase = Phase.LIVE;
  m.half = 2;
  m.clockSec = 430;
  assert.equal(Math.round(m.displayClockSec), 63 * 60);

  m.addedTime = [10, 20];
  m.clockSec = 590;
  assert.equal(m.displayAddedMinutes, 3);
  m.phase = Phase.ENDED;
  assert.equal(m.displayClockSec, 90 * 60);
  assert.equal(m.displayAddedMinutes, 3);
  const small = new Match(MODE_CONFIGS.cage3, { seed: 6, humanSlot: null, aiLevel: 0 });
  assert.equal(small.matchMinutes, 40);
  assert.ok(small.clockScale > m.clockScale, 'small-sided matches use a faster displayed clock');
});

test('half-time swaps ends and starts the second half', () => {
  const m = live({ ...MODE_CONFIGS.full11, durationSec: 20 });
  const attackBefore = m.teams[0].attackGoal.x;
  for (let i = 0; i < 40 * 30 && m.phase !== Phase.HALF_TIME; i++) m.step(1 / 30);
  assert.equal(m.phase, Phase.HALF_TIME);
  assert.equal(m.half, 1);
  for (let i = 0; i < 10 * 30 && m.half === 1; i++) m.step(1 / 30);
  assert.equal(m.half, 2);
  assert.equal(m.sideSwapped, true);
  assert.equal(Math.sign(m.teams[0].attackGoal.x), -Math.sign(attackBefore));
  assert.equal(m.teams[0].dir, -1);
  assert.equal(m.teams[1].dir, 1);
});

test('kickoff walk-in moves players into the compact shape without teleporting', () => {
  const m = new Match(MODE_CONFIGS.full11, { seed: 24, humanSlot: null, aiLevel: 0 });
  const player = m.players.find((p) => p !== m.ball.holder && !p.isGoalKeeper);
  const start = { x: player.pos.x, z: player.pos.z };
  const target = { ...player.kickoffTo };
  m.step(1 / 30);
  assert.ok(Math.hypot(player.pos.x - start.x, player.pos.z - start.z) > 0.01, 'walk-in starts immediately');
  assert.ok(Math.hypot(player.pos.x - target.x, player.pos.z - target.z) > 0.2, 'first frame must not teleport');
  for (let i = 0; i < 120 && m.phase === Phase.COUNTDOWN; i++) m.step(1 / 30);
  assert.equal(m.phase, Phase.LIVE);
  assert.ok(Math.hypot(player.pos.x - target.x, player.pos.z - target.z) < 0.15);
});

test('kickoff keeps players in their own half and outside the centre circle', () => {
  const m = live();
  const kicker = m.ball.holder;
  for (const p of m.players) {
    const dir = m.dirFor(p.team);
    const ownX = m.goalNets[p.team].x;
    assert.ok((p.pos.x - ownX) * dir >= -0.5, `${p.id} not in own half`);
    if (p !== kicker) assert.ok(Math.hypot(p.pos.x, p.pos.z) >= 9.1, `${p.id} inside centre circle`);
  }
});

test('a foul can be played as advantage and carded at the next stoppage', () => {
  const m = live();
  const carrier = m.teams[0].players[5];
  const tackler = m.teams[1].players[5];
  carrier.setInstantPosition(10, 0, 0);
  tackler.setInstantPosition(10, -1, 0);
  m.ball.hold(carrier);
  m.ball.pos = V.v3(10, 0.11, 0);
  const base = m.rng;
  m.rng = Object.assign(() => 0, { range: base.range, sign: base.sign });
  const fouled = m.awardFoul(carrier.team, V.copy(carrier.pos), tackler, true, true, true, carrier);
  assert.equal(fouled, true);
  assert.ok(m.advantage);
  m.time = m.advantage.until + 0.1;
  m.resolveAdvantage();
  assert.equal(m.advantage, null);
  assert.ok(m.pendingCard);
  m.flushPendingCard();
  assert.equal(tackler.yellowCards, 1);
  m.rng = base;
});

test('a human penalty waits for placement and only shoots on the chosen attempt', () => {
  const m = new Match(MODE_CONFIGS.full11, { seed: 17, humanSlot: 5, aiLevel: 0 });
  m.phase = Phase.LIVE;
  m.time = 10;
  m.freezeUntil = 0;
  m.setPiece = null;
  m.awardPenalty(0, V.v3(0, 0.11, 0));
  assert.equal(m.penalty.waiting, true);
  let shots = 0;
  m.events.on('PlayerShoot', () => { shots++; });
  m.freezeUntil = 0;
  m.executeSetPiece();
  assert.equal(shots, 0, 'the engine must not auto-shoot a human penalty');
  const result = m.takePenalty({ zoneZ: 1, zoneY: 0.2, power: 0.8 });
  assert.equal(result.ok, true);
  assert.equal(shots, 1);
  assert.equal(m.penalty.taken, true);
  assert.equal(m.penalty.waiting, false);
  assert.equal(m.setPiece, null);
});

test('a human can choose a dive when defending a penalty', () => {
  const m = new Match(MODE_CONFIGS.full11, { seed: 18, humanSlot: 5, aiLevel: 0 });
  m.phase = Phase.LIVE;
  m.time = 10;
  m.freezeUntil = 0;
  m.setPiece = null;
  m.awardPenalty(1, V.v3(0, 0.11, 0));
  assert.equal(m.penalty.waiting, true);
  let shots = 0;
  m.events.on('PlayerShoot', () => { shots++; });
  const result = m.takePenaltyDefense(-1);
  assert.equal(result.ok, true);
  assert.equal(shots, 1);
  assert.equal(m.penalty.waiting, false);
  assert.equal(m.setPiece, null);
});

test('a human free kick waits for the aim panel and executes the chosen strike', () => {
  const m = new Match(MODE_CONFIGS.full11, { seed: 19, humanSlot: 5, aiLevel: 0 });
  m.phase = Phase.LIVE;
  m.time = 10;
  m.freezeUntil = 0;
  m.setPiece = null;
  let awarded = null;
  m.events.on('FreeKickAwarded', (ev) => { awarded = ev; });
  const goal = m.teams[0].attackGoal;
  m.freeKick(0, V.v3(goal.x - 25, 0.11, 0), 'FOUL', false);
  assert.ok(awarded);
  assert.equal(awarded.canShoot, true);
  assert.equal(m.setPiece, 'FREEKICK');
  assert.equal(m.freeKickInfo.canShoot, true);
  let shots = 0;
  m.events.on('PlayerShoot', () => { shots++; });
  const result = m.takeFreeKick({ zoneZ: 1, zoneY: 0.7, power: 0.75, curve: 0.4 });
  assert.equal(result.ok, true);
  assert.equal(shots, 1);
  assert.equal(m.freeKickInfo, null);
  assert.equal(m.setPiece, null);
});

test('an indirect or long free kick is not a shooting opportunity', () => {
  const m = new Match(MODE_CONFIGS.full11, { seed: 20, humanSlot: 5, aiLevel: 0 });
  m.phase = Phase.LIVE;
  m.time = 10;
  m.freezeUntil = 0;
  m.setPiece = null;
  const goal = m.teams[0].attackGoal;
  m.freeKick(0, V.v3(goal.x - 25, 0.11, 0), 'OFFSIDE', true);
  assert.equal(m.freeKickInfo.canShoot, false);
  m.freeKick(0, V.v3(-30, 0.11, 0), 'FOUL', false);
  assert.equal(m.freeKickInfo.canShoot, false);
});

test('AI penalties still resolve automatically', () => {
  const m = live();
  m.awardPenalty(0, V.v3(0, 0.11, 0));
  assert.equal(m.penalty.waiting, false);
  let shots = 0;
  m.events.on('PlayerShoot', () => { shots++; });
  m.freezeUntil = 0;
  m.executeSetPiece();
  assert.equal(shots, 1);
  assert.equal(m.penalty.taken, true);
});

test('a foul in the box becomes a penalty and the taker shoots from the spot', () => {
  const m = live();
  const carrier = m.teams[0].players[9];
  const tackler = m.teams[1].players[2];
  const goal = m.teams[0].attackGoal;
  carrier.setInstantPosition(goal.x - m.dirFor(0) * 10, 0, 0);
  tackler.setInstantPosition(carrier.pos.x, -1, Math.PI);
  m.ball.hold(carrier);
  m.ball.pos = V.v3(carrier.pos.x, 0.11, 0);
  let shot = null;
  m.events.on('PlayerShoot', (ev) => { shot = ev; });
  m.awardFoul(carrier.team, V.copy(carrier.pos), tackler, false, false, false, carrier);
  assert.equal(m.setPiece, 'PENALTY');
  assert.ok(m.penalty?.taker);
  const spot = m.penalty.pos;
  assert.ok(Math.abs(spot.x - (goal.x - m.dirFor(0) * 11)) < 0.01);
  m.executeSetPiece();
  assert.ok(shot);
  assert.equal(shot.player.id, m.penalty.taker.id);
  assert.equal(m.penalty.taken, true);
  const keeper = m.teams[1].players.find((p) => p.isGoalKeeper);
  for (const p of m.players) {
    if (p === m.penalty.taker || p === keeper || p.sentOff) continue;
    assert.equal(m.insidePenaltyArea(1, p.pos), false, `${p.id} inside the box`);
  }
});

test('a second yellow sends the player off and removes them from the field', () => {
  const m = live();
  const p = m.teams[0].players[4];
  m.applyCard(p, 'yellow', 'RECKLESS');
  assert.equal(p.yellowCards, 1);
  assert.equal(p.sentOff, false);
  m.applyCard(p, 'yellow', 'RECKLESS');
  assert.equal(p.sentOff, true);
  assert.equal(p.redCard, true);
  assert.equal(m.teams[0].fielders.includes(p), false);
  assert.equal(m.cards[0].yellow, 2);
  assert.equal(m.cards[0].red, 1);
});

test('an offside touch awards an indirect free kick', () => {
  const m = live();
  const attacker = m.teams[0].players[9];
  attacker.setInstantPosition(10, 0, 0);
  attacker.isInOffside = true;
  m.ball.release();
  m.ball.pos = V.v3(10.2, 0.11, 0);
  m.ball.vel = V.v3(0, 0, 0);
  m.ball.lastTouchTeam = 1;
  m.handleTouches(0);
  assert.equal(m.offsides[0], 1);
  assert.equal(m.indirectFreeKick, true);
  assert.equal(m.setPiece, 'FREEKICK');
});

test('goal kicks and corners remain direct while an indirect free kick is restricted', () => {
  const m = live();
  m.freeKick(0, V.v3(10, 0.11, 0), 'OFFSIDE', true);
  const taker = m.ball.holder;
  assert.equal(m.indirectFreeKick, true);
  assert.equal(m.restrictedGoalBy, taker.id);
  m.freeKick(0, V.v3(10, 0.11, 0), 'FOUL', false);
  assert.equal(m.indirectFreeKick, false);
  assert.equal(m.restrictedGoalBy, null);
});

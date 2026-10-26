import test from 'node:test';
import assert from 'node:assert/strict';
import { Match, Phase } from '../src/engine/match.js';
import { MODE_CONFIGS } from '../src/config/modes.js';
import { MoveMode } from '../src/engine/player.js';
import * as V from '../src/engine/vec.js';

function makeMatch() {
  const m = new Match(MODE_CONFIGS.classic5, { seed: 11, humanSlot: null, aiLevel: 0 });
  m.phase = Phase.LIVE;
  m.time = 10;
  m.freezeUntil = 0;
  m.setPiece = null;
  // Park everyone out of the way; individual tests place the duelists.
  m.players.forEach((p, i) => p.setInstantPosition(i * 1.5, 30 + i * 1.5, 0));
  return m;
}

function duelists(m, strengthA = 100, strengthB = 20) {
  const a = m.players.find((p) => p.team === 0 && !p.isGoalKeeper);
  const b = m.players.find((p) => p.team === 1 && !p.isGoalKeeper);
  a.skills.strength = strengthA;
  a.skills.agility = strengthA;
  b.skills.strength = strengthB;
  b.skills.agility = strengthB;
  return { a, b };
}

test('a shoulder duel slows the weaker player more and drains his balance faster', () => {
  const m = makeMatch();
  const { a, b } = duelists(m);
  a.setInstantPosition(0, 0, 0);
  b.setInstantPosition(0.9, 0, Math.PI);
  a.vx = 3; a.vz = 0; a.speed = 3;
  b.vx = -3; b.vz = 0; b.speed = 3;
  let duels = 0;
  m.events.on('PlayerDuel', () => duels++);
  m.separatePlayers(1 / 30);
  assert.ok(V.distXZ(a.pos, b.pos) >= 0.71, `contact resolution left overlap at ${V.distXZ(a.pos, b.pos).toFixed(3)}`);
  assert.ok(a.vx > b.vx + 3.5, `strong=${a.vx.toFixed(2)} weak=${b.vx.toFixed(2)}`);
  assert.ok(b.balance < a.balance, `strong balance=${a.balance.toFixed(3)} weak=${b.balance.toFixed(3)}`);
  assert.equal(duels, 1);
  assert.deepEqual(m.stats.duels, [1, 1]);
});

test('a sustained mismatch eventually stumbles the weaker player', () => {
  const m = makeMatch();
  const { a, b } = duelists(m, 100, 10);
  a.setInstantPosition(0, 0, 0);
  b.setInstantPosition(0.85, 0, Math.PI);
  let stumbled = null;
  m.events.on('PlayerStumbled', (ev) => { stumbled = ev; });
  for (let i = 0; i < 60 && !stumbled; i++) {
    a.vx = 2.4; a.vz = 0; a.speed = 2.4;
    b.vx = -2.4; b.vz = 0; b.speed = 2.4;
    m.time += 1 / 30;
    m.separatePlayers(1 / 30);
  }
  assert.ok(stumbled, 'the weaker player should lose his footing');
  assert.equal(stumbled.player, b);
  assert.equal(stumbled.by, a);
  assert.ok(b.stunned, 'a stumble briefly takes the player out of the action');
  assert.equal(m.stats.duelsWon[0], 1);
});

test('shielding requires the body to be between the ball and the defender', () => {
  const m = makeMatch();
  const { a, b } = duelists(m, 80, 80);
  a.setInstantPosition(0, 0, 0);
  b.setInstantPosition(-0.9, 0, 0);
  m.ball.hold(a);
  m.ball.pos = V.v3(0.5, 0.11, 0);
  a.moveMode = MoveMode.Shield;
  m.updateDuelContext();
  assert.equal(a.shieldActive, true, 'ball ahead + defender behind should register a shield');
  assert.equal(a.shieldTargetId, b.id);

  b.setInstantPosition(0.9, 0, Math.PI);
  m.updateDuelContext();
  assert.equal(a.shieldActive, false, 'turning the ball toward the defender exposes it');
});

test('shielding cuts tackle success and makes the challenge riskier', () => {
  const m = makeMatch();
  const { a, b } = duelists(m, 85, 85);
  a.setInstantPosition(0, 0, 0);
  b.setInstantPosition(-0.8, 0, 0);
  m.ball.hold(a);
  m.ball.pos = V.v3(0.5, 0.11, 0);
  a.moveMode = MoveMode.Shield;
  m.updateDuelContext();
  const shielded = m.tackleSuccessChance(b, a, false);
  const shieldedRisk = m.tackleFoulRisk(b, a, false);
  a.shieldActive = false;
  const open = m.tackleSuccessChance(b, a, false);
  const openRisk = m.tackleFoulRisk(b, a, false);
  assert.ok(open - shielded > 0.2, `shielded=${shielded.toFixed(3)} open=${open.toFixed(3)}`);
  assert.ok(shieldedRisk > openRisk, 'pushing through a shield should risk a foul');
});

test('a leaning shield resists balance damage better than the challenger', () => {
  const m = makeMatch();
  const { a, b } = duelists(m, 80, 80);
  a.setInstantPosition(0, 0, 0);
  b.setInstantPosition(-0.8, 0, 0);
  m.ball.hold(a);
  m.ball.pos = V.v3(0.5, 0.11, 0);
  a.moveMode = MoveMode.Shield;
  m.updateDuelContext();
  assert.equal(a.shieldActive, true);
  b.vx = 2.5; b.vz = 0; b.speed = 2.5;
  m.separatePlayers(1 / 30);
  assert.ok(a.balance > b.balance,
    `shield balance=${a.balance.toFixed(3)} challenger=${b.balance.toFixed(3)}`);
});

test('a stumble releases the ball and credits the duel winner', () => {
  const m = makeMatch();
  const { a, b } = duelists(m, 100, 15);
  a.setInstantPosition(0, 0, 0);
  b.setInstantPosition(-0.8, 0, 0);
  m.ball.hold(a);
  m.ball.pos = V.v3(0.4, 0.11, 0);
  a.balance = 0.17;
  b.vx = 3; b.vz = 0; b.speed = 3;
  let event = null;
  m.events.on('PlayerStumbled', (ev) => { event = ev; });
  m.separatePlayers(1 / 30);
  assert.ok(event, 'the carrier should stumble under the challenge');
  assert.equal(m.ball.holder, null, 'the ball must break loose');
  assert.ok(m.ball.speed > 1, 'the loose ball should carry away from the contact');
  assert.equal(m.stats.duelsWon[1], 1);
});

test('balance recovers and a rattled carrier is easier to tackle', () => {
  const m = makeMatch();
  const { a, b } = duelists(m, 80, 80);
  a.setInstantPosition(0, 0, 0);
  b.setInstantPosition(-0.8, 0, 0);
  m.ball.hold(a);
  m.ball.pos = V.v3(0.5, 0.11, 0);
  a.shieldActive = false;
  const steady = m.tackleSuccessChance(b, a, false);
  a.balance = 0.3;
  const rattled = m.tackleSuccessChance(b, a, false);
  assert.ok(rattled > steady, `rattled=${rattled.toFixed(3)} steady=${steady.toFixed(3)}`);
  a.updateStability(1.0);
  assert.ok(a.balance > 0.9, `balance did not recover: ${a.balance.toFixed(3)}`);
});

test('duel events are throttled instead of firing every contact tick', () => {
  const m = makeMatch();
  const { a, b } = duelists(m, 80, 80);
  a.setInstantPosition(0, 0, 0);
  b.setInstantPosition(0.8, 0, Math.PI);
  let duels = 0;
  m.events.on('PlayerDuel', () => duels++);
  for (let i = 0; i < 30; i++) {
    a.vx = 2.2; a.vz = 0; a.speed = 2.2;
    b.vx = -2.2; b.vz = 0; b.speed = 2.2;
    m.time += 1 / 30;
    m.separatePlayers(1 / 30);
  }
  assert.ok(duels <= 2, `expected at most 2 duel events in one second, got ${duels}`);
});

test('AI carriers shield automatically when pressed', () => {
  const m = makeMatch();
  const { a, b } = duelists(m, 80, 80);
  a.setInstantPosition(0, 0, 0);
  b.setInstantPosition(-1.0, 0, 0);
  m.ball.hold(a);
  m.ball.pos = V.v3(0.45, 0.11, 0);
  const behaviour = a.behaviours.find((entry) => entry.name === 'DribblingBehaviour');
  behaviour.set(m.behaviourContext(a, 1 / 30));
  assert.equal(behaviour.behave(), true);
  assert.equal(a.moveMode, MoveMode.Shield);
  m.updateDuelContext();
  assert.equal(a.shieldActive, true);
});

test('human close control keeps the shield carry mode instead of dropping to normal', () => {
  const m = makeMatch();
  const { a, b } = duelists(m, 80, 80);
  a.isHuman = true;
  a.setInstantPosition(0, 0, 0);
  b.setInstantPosition(-0.85, 0, 0);
  b.tackleReadyAt = 1e9;
  m.ball.hold(a);
  m.ball.pos = V.v3(0.5, 0.11, 0);
  a.intent = { worldX: 1, worldZ: 0, speedScale: 0.4, closeControl: true };
  m.applyHumanControl(a, 1 / 30);
  assert.equal(a.moveMode, MoveMode.Shield, 'the engine must remember the requested carry mode');
  m.updateDuelContext();
  assert.equal(a.shieldActive, true);
});

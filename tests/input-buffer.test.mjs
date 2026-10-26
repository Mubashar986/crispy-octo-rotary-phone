import test from 'node:test';
import assert from 'node:assert/strict';
import { Match, Phase } from '../src/engine/match.js';
import { MODE_CONFIGS } from '../src/config/modes.js';
import { BALL_RADIUS } from '../src/engine/ball.js';

function makeMatch() {
  const m = new Match(MODE_CONFIGS.classic5, { seed: 11, humanSlot: 0, aiLevel: 0 });
  m.phase = Phase.LIVE;
  m.time = 10;
  m.freezeUntil = 0;
  m.setPiece = null;
  const p = m.players.find((q) => q.isHuman);
  p.setInstantPosition(0, 0);
  m.ball.reset({ x: 0.4, y: BALL_RADIUS, z: 0 });
  return { m, p };
}

test('a higher-priority shot cancels a pending pass inside the cancel window', () => {
  const { m, p } = makeMatch();
  m.ball.hold(p);
  p.intent = { pass: true, passPower: 0.6 };
  m.applyHumanControl(p, 1 / 30);
  assert.equal(p.pendingStrike?.type, 'pass');
  const seq = p.actionSeq;

  p.intent = { shoot: true, shootPower: 0.9 };
  m.applyHumanControl(p, 1 / 30);
  assert.equal(p.pendingStrike?.type, 'shoot');
  assert.equal(p.kickKind, 'shot');
  assert.ok(p.actionSeq > seq, 'the animation sequence must restart for the new strike');
  assert.equal(p.bufferedAction, null);
});

test('a lower-priority pass cannot cancel a pending shot', () => {
  const { m, p } = makeMatch();
  m.ball.hold(p);
  p.intent = { shoot: true, shootPower: 0.9 };
  m.applyHumanControl(p, 1 / 30);
  assert.equal(p.pendingStrike?.type, 'shoot');
  const seq = p.actionSeq;

  p.intent = { pass: true, passPower: 0.6 };
  m.applyHumanControl(p, 1 / 30);
  assert.equal(p.pendingStrike?.type, 'shoot');
  assert.equal(p.actionSeq, seq);
  assert.equal(p.bufferedAction?.type, 'pass');
});

test('an action that cannot execute is buffered and fires when the ball arrives', () => {
  const { m, p } = makeMatch();
  m.ball.release();
  m.ball.pos.x = 20;
  p.intent = { shoot: true, shootPower: 0.8 };
  m.applyHumanControl(p, 1 / 30);
  assert.equal(p.pendingStrike, null);
  assert.equal(p.bufferedAction?.type, 'shoot');

  m.ball.release();
  m.ball.pos.x = p.pos.x + 0.4;
  m.ball.pos.y = BALL_RADIUS;
  m.ball.pos.z = p.pos.z;
  p.intent = null;
  m.applyHumanControl(p, 1 / 30);
  assert.equal(p.bufferedAction, null);
  assert.ok(m.ball.speed > 0, 'the buffered shot fired when the ball became reachable');
  assert.equal(m.ball.lastKickBy?.id, p.id);
});

test('a buffered action expires instead of firing late', () => {
  const { m, p } = makeMatch();
  m.ball.release();
  m.ball.pos.x = 20;
  p.intent = { shoot: true, shootPower: 0.8 };
  m.applyHumanControl(p, 1 / 30);
  assert.equal(p.bufferedAction?.type, 'shoot');
  m.time += 0.3;
  p.intent = null;
  m.applyHumanControl(p, 1 / 30);
  assert.equal(p.bufferedAction, null);
  assert.equal(p.pendingStrike, null);
  assert.equal(m.ball.speed, 0);
});

test('the wind-up lock leaves the human able to cancel but unable to move', () => {
  const { m, p } = makeMatch();
  m.ball.hold(p);
  p.intent = { pass: true, passPower: 0.6 };
  m.applyHumanControl(p, 1 / 30);
  assert.ok(p.actionLockUntil > m.time);
  const before = { ...p.pos };
  p.intent = { shoot: true, shootPower: 0.9, moveX: 1, moveZ: 0 };
  m.processBehaviours(p, 1 / 30);
  assert.equal(p.pendingStrike?.type, 'shoot');
  assert.ok(Math.hypot(p.pos.x - before.x, p.pos.z - before.z) < 0.01, 'the taker must stay planted during the strike');
});

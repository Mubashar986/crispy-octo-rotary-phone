import test from 'node:test';
import assert from 'node:assert/strict';
import { Player, MovementType, MoveMode } from '../src/engine/player.js';
import * as V from '../src/engine/vec.js';

const SKILLS = {
  topSpeed: 75, acceleration: 75, agility: 75, strength: 70, dribbleSpeed: 75,
  ballControl: 75, passing: 75, longBall: 70, shooting: 75, shootPower: 75,
  tackling: 60, positioning: 70, reaction: 70, jump: 65
};

function player(opts = {}) {
  return new Player({
    id: opts.id ?? 'p', team: 0, role: 'ST', x: opts.x ?? 0, z: opts.z ?? 0,
    facing: opts.facing ?? 0, skills: { ...SKILLS, ...(opts.skills ?? {}) }
  });
}

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

test('a 180-degree reversal does not orbit the player', () => {
  const p = player();
  const dt = 1 / 30;
  for (let i = 0; i < 30; i++) p.move(dt, 1, 0, MovementType.BestHeCanDo);
  const forwardX = p.pos.x;
  for (let i = 0; i < 45; i++) p.move(dt, -1, 0, MovementType.BestHeCanDo);
  assert.ok(p.pos.x < forwardX, `player did not reverse, x=${p.pos.x.toFixed(2)}`);
  assert.ok(Math.abs(p.pos.z) < 0.05, `player orbited sideways z=${p.pos.z.toFixed(3)}`);
  assert.ok(Math.abs(wrap(p.facing - Math.PI)) < 0.35, `facing did not settle on the reverse, facing=${p.facing.toFixed(2)}`);
  assert.ok(p.speed > 1, 'player should be moving after the reversal');
});

test('reversing from rest pivots before accelerating', () => {
  const p = player({ facing: 0 });
  const dt = 1 / 30;
  const start = V.copy(p.pos);
  p.move(dt, -1, 0, MovementType.BestHeCanDo);
  assert.ok(p.turnInPlace, 'first frame from rest should pivot in place');
  assert.ok(Math.abs(p.speed) < 0.2, 'pivot frame should not accelerate');
  for (let i = 0; i < 3; i++) p.move(dt, -1, 0, MovementType.BestHeCanDo);
  assert.ok(Math.abs(p.pos.x - start.x) < 0.2, `player accelerated before pivoting x=${p.pos.x.toFixed(3)}`);
  assert.ok(Math.abs(wrap(p.facing - Math.PI)) < 1.0, `player did not start the pivot facing=${p.facing.toFixed(2)}`);
});

test('analog stick magnitude scales target speed', () => {
  const full = player({ id: 'full' });
  const half = player({ id: 'half' });
  const dt = 1 / 30;
  for (let i = 0; i < 90; i++) {
    full.move(dt, 1, 0, MovementType.Normal, null, 1, MoveMode.Normal);
    half.move(dt, 1, 0, MovementType.Normal, null, 0.5, MoveMode.Normal);
  }
  assert.ok(half.speed > 0.3, 'half stick should still move');
  assert.ok(half.speed < full.speed * 0.62, `half=${half.speed.toFixed(2)} full=${full.speed.toFixed(2)}`);
  assert.ok(half.speed > full.speed * 0.38, `half=${half.speed.toFixed(2)} full=${full.speed.toFixed(2)}`);
});

test('facing follows the ball while the feet move sideways (keeper shuffle)', () => {
  const p = player({ x: 0, z: 0, facing: 0 });
  const dt = 1 / 30;
  const ball = { x: 0, z: 20 };
  for (let i = 0; i < 45; i++) p.moveTo(dt, { x: 0, z: -5 }, ball, MovementType.Normal);
  assert.ok(p.pos.z < -1.5, `keeper did not shuffle across, z=${p.pos.z.toFixed(2)}`);
  assert.ok(Math.abs(p.pos.x) < 0.2, `keeper drifted forward/back, x=${p.pos.x.toFixed(2)}`);
  assert.ok(Math.abs(wrap(p.facing - Math.PI / 2)) < 0.3, `keeper did not face the ball, facing=${p.facing.toFixed(2)}`);
  assert.equal(p.motionState !== 'IDLE', true);
});

test('close control is slower than normal and sprint is the fastest', () => {
  const dt = 1 / 30;
  const close = player({ id: 'close' });
  const normal = player({ id: 'normal' });
  const sprint = player({ id: 'sprint' });
  for (let i = 0; i < 90; i++) {
    close.move(dt, 1, 0, MovementType.BestHeCanDo, null, 1, MoveMode.Close);
    normal.move(dt, 1, 0, MovementType.Normal, null, 1, MoveMode.Normal);
    sprint.move(dt, 1, 0, MovementType.BestHeCanDo, null, 1, MoveMode.Sprint);
  }
  assert.ok(close.speed < normal.speed, `close=${close.speed.toFixed(2)} normal=${normal.speed.toFixed(2)}`);
  assert.ok(normal.speed < sprint.speed, `normal=${normal.speed.toFixed(2)} sprint=${sprint.speed.toFixed(2)}`);
});

test('moveTo arrives without overshooting or jittering', () => {
  const p = player({ x: 0, z: 0 });
  const dt = 1 / 30;
  const target = { x: 6, z: 2 };
  for (let i = 0; i < 120; i++) p.moveTo(dt, target, null, MovementType.BestHeCanDo);
  assert.ok(V.distXZ(p.pos, target) < 0.12, `arrived at ${p.pos.x.toFixed(2)},${p.pos.z.toFixed(2)}`);
  assert.ok(p.speed < 0.1, `residual speed ${p.speed.toFixed(2)}`);
});

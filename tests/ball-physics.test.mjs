import test from 'node:test';
import assert from 'node:assert/strict';
import { Match, Phase } from '../src/engine/match.js';
import { MODE_CONFIGS } from '../src/config/modes.js';
import * as V from '../src/engine/vec.js';

function fly(spin, velocity = { x: 20, y: 3, z: 0 }, seconds = 0.5) {
  const m = new Match(MODE_CONFIGS.classic5, { seed: 3 });
  m.phase = Phase.LIVE;
  m.freezeUntil = 0;
  m.ball.reset(V.v3(0, 1, 0));
  m.ball.vel = V.v3(velocity.x, velocity.y, velocity.z);
  m.ball.spin = V.v3(spin.x, spin.y, spin.z);
  for (let t = 0; t < seconds; t += 1 / 120) m.ball.step(1 / 120);
  return { pos: V.copy(m.ball.pos), spin: V.copy(m.ball.spin) };
}

test('side spin bends the flight laterally in the expected direction', () => {
  const plain = fly({ x: 0, y: 0, z: 0 });
  const side = fly({ x: 0, y: 12, z: 0 });
  assert.ok(side.pos.z > plain.pos.z + 0.8, `side z=${side.pos.z.toFixed(2)} plain z=${plain.pos.z.toFixed(2)}`);
  assert.ok(Math.abs(side.pos.x - plain.pos.x) < 0.8, 'side spin should not materially change forward travel');
});

test('topspin dips and backspin lifts relative to a plain ball', () => {
  const plain = fly({ x: 0, y: 0, z: 0 });
  const top = fly({ x: 0, y: 0, z: 12 });
  const back = fly({ x: 0, y: 0, z: -12 });
  assert.ok(top.pos.y < plain.pos.y, `top=${top.pos.y.toFixed(2)} plain=${plain.pos.y.toFixed(2)}`);
  assert.ok(back.pos.y > plain.pos.y, `back=${back.pos.y.toFixed(2)} plain=${plain.pos.y.toFixed(2)}`);
});

test('spin decays in flight', () => {
  const r = fly({ x: 0, y: 14, z: 0 }, { x: 20, y: 3, z: 0 }, 0.5);
  assert.ok(Math.abs(r.spin.y) < 12, `spin should decay, got ${r.spin.y.toFixed(2)}`);
});

test('a grounded rolling ball settles toward rolling spin', () => {
  const m = new Match(MODE_CONFIGS.classic5, { seed: 4 });
  m.phase = Phase.LIVE;
  m.freezeUntil = 0;
  m.ball.reset(V.v3(0, 0.11, 0));
  m.ball.vel = V.v3(6, 0, 0);
  m.ball.spin = V.v3(0, 0, 0);
  for (let t = 0; t < 0.4; t += 1 / 120) m.ball.step(1 / 120);
  assert.ok(m.ball.spin.z > 10, `ground contact should build rolling spin, got ${m.ball.spin.z.toFixed(2)}`);
  assert.ok(m.ball.vel.x > 0, 'the ball should still roll forward');
});

import * as V from './vec.js';

const EPSILON = 1e-8;
export const POST_RADIUS = 0.065;

function roots(a, b, c) {
  if (a < EPSILON) return [];
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return [];
  const d = Math.sqrt(discriminant);
  return [(-b - d) / (2 * a), (-b + d) / (2 * a)];
}

export function sweepSphereCapsule(from, to, start, end, radius) {
  const motion = V.sub(to, from);
  const axis = V.normalize(V.sub(end, start));
  const length = V.dist(start, end);
  const relative = V.sub(from, start);
  const along = V.dot(relative, axis);
  const speed = V.dot(motion, axis);
  const radial = V.addScaled(relative, axis, -along);
  const radialMotion = V.addScaled(motion, axis, -speed);
  const candidates = [];
  const closest = V.addScaled(start, axis, Math.max(0, Math.min(length, along)));
  if (V.dist(from, closest) <= radius) candidates.push(0);

  for (const t of roots(V.dot(radialMotion, radialMotion), 2 * V.dot(radial, radialMotion), V.dot(radial, radial) - radius * radius)) {
    const h = along + speed * t;
    if (h >= 0 && h <= length) candidates.push(t);
  }
  for (const cap of [start, end]) {
    const delta = V.sub(from, cap);
    candidates.push(...roots(V.dot(motion, motion), 2 * V.dot(delta, motion), V.dot(delta, delta) - radius * radius));
  }
  for (const t of candidates.sort((a, b) => a - b)) {
    if (t < 0 || t > 1) continue;
    const point = V.addScaled(from, motion, t);
    const h = Math.max(0, Math.min(length, V.dot(V.sub(point, start), axis)));
    const normal = V.normalize(V.sub(point, V.addScaled(start, axis, h)));
    if (V.dot(motion, normal) < -EPSILON) return { t, point, normal };
  }
  return null;
}

export function createGoalFrame(halfLength, width, height) {
  const frame = [];
  for (const sign of [-1, 1]) {
    const x = sign * halfLength;
    for (const z of [-width / 2, width / 2]) {
      frame.push({ start: V.v3(x, 0, z), end: V.v3(x, height, z), part: 'POST' });
    }
    frame.push({ start: V.v3(x, height, -width / 2), end: V.v3(x, height, width / 2), part: 'CROSSBAR' });
  }
  return frame;
}

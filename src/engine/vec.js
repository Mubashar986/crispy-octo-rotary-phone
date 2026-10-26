// Plain-object vectors so the engine stays free of three.js and the DOM.
export const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const copy = (a) => ({ x: a.x, y: a.y, z: a.z });
export const set = (o, x, y, z) => { o.x = x; o.y = y; o.z = z; return o; };
export const add = (a, b) => v3(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a, b) => v3(a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (a, s) => v3(a.x * s, a.y * s, a.z * s);
export const addScaled = (a, b, s) => v3(a.x + b.x * s, a.y + b.y * s, a.z + b.z * s);
export const len = (a) => Math.hypot(a.x, a.y, a.z);
export const lenXZ = (a) => Math.hypot(a.x, a.z);
export const dist = (a, b) => len(sub(a, b));
export const distXZ = (a, b) => Math.hypot(b.x - a.x, b.z - a.z);
export const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const dotXZ = (a, b) => a.x * b.x + a.z * b.z;

export function normalize(a) {
  const l = len(a);
  return l > 1e-5 ? v3(a.x / l, a.y / l, a.z / l) : v3(0, 0, 0);
}
export function normalizeXZ(a) {
  const l = lenXZ(a);
  return l > 1e-5 ? v3(a.x / l, 0, a.z / l) : v3(0, 0, 0);
}
export function withLength(a, l) {
  const n = normalize(a);
  return scale(n, l);
}
// heading in radians on the XZ plane, 0 = +X
export const headingOf = (a) => Math.atan2(a.z, a.x);
export const fromHeading = (h) => v3(Math.cos(h), 0, Math.sin(h));

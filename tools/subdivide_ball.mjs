import { readFileSync, writeFileSync } from 'node:fs';

const source = readFileSync('assets/meshes/ball.obj', 'utf8').split(/\r?\n/);
const verts = [];
const uvs = [];
let faces = [];
for (const line of source) {
  if (line.startsWith('v ')) {
    const [, x, y, z] = line.split(/\s+/).map(Number);
    verts.push([x, y, z]);
  } else if (line.startsWith('vt ')) {
    const [, u, v] = line.split(/\s+/).map(Number);
    uvs.push([u, v]);
  } else if (line.startsWith('f ')) {
    const corners = line.slice(2).trim().split(/\s+/).map((token) => {
      const [v, t] = token.split('/').map(Number);
      return [v - 1, t - 1];
    });
    faces.push(corners);
  }
}

const radius = Math.max(...verts.map(([x, y, z]) => Math.hypot(x, y, z)));
for (const v of verts) {
  const len = Math.hypot(...v) || 1;
  v[0] = v[0] / len * (radius || 0.5);
  v[1] = v[1] / len * (radius || 0.5);
  v[2] = v[2] / len * (radius || 0.5);
}

function mid(a, b, cache) {
  const key = a[0] < b[0] ? `${a[0]}_${b[0]}` : `${b[0]}_${a[0]}`;
  if (cache.has(key)) return cache.get(key);
  const pa = verts[a[0]], pb = verts[b[0]];
  let ua = uvs[a[1]], ub = uvs[b[1]];
  if (Math.abs(ua[0] - ub[0]) > 0.5) ub = [ub[0] + (ua[0] > ub[0] ? 1 : -1), ub[1]];
  if (Math.abs(ua[1] - ub[1]) > 0.5) ub = [ub[0], ub[1] + (ua[1] > ub[1] ? 1 : -1)];
  const x = (pa[0] + pb[0]) / 2, y = (pa[1] + pb[1]) / 2, z = (pa[2] + pb[2]) / 2;
  const len = Math.hypot(x, y, z) || 1;
  const vi = verts.length;
  verts.push([x / len * radius, y / len * radius, z / len * radius]);
  uvs.push([((ua[0] + ub[0]) / 2) % 1, (ua[1] + ub[1]) / 2]);
  cache.set(key, [vi, vi]);
  return [vi, vi];
}

for (let level = 0; level < 2; level++) {
  const cache = new Map();
  const next = [];
  for (const [a, b, c] of faces) {
    const ab = mid(a, b, cache), bc = mid(b, c, cache), ca = mid(c, a, cache);
    next.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
  }
  faces = next;
}

const lines = ['# Subdivided Pitchline ball (2 levels)', 'o Ball_Hi'];
for (const [x, y, z] of verts) lines.push(`v ${x.toFixed(6)} ${y.toFixed(6)} ${z.toFixed(6)}`);
for (const [u, v] of uvs) lines.push(`vt ${u.toFixed(6)} ${v.toFixed(6)}`);
for (const [x, y, z] of verts) {
  const len = Math.hypot(x, y, z) || 1;
  lines.push(`vn ${(x / len).toFixed(6)} ${(y / len).toFixed(6)} ${(z / len).toFixed(6)}`);
}
for (const [a, b, c] of faces) {
  lines.push(`f ${a[0] + 1}/${a[1] + 1}/${a[0] + 1} ${b[0] + 1}/${b[1] + 1}/${b[0] + 1} ${c[0] + 1}/${c[1] + 1}/${c[0] + 1}`);
}
writeFileSync('assets/meshes/ball_hi.obj', `${lines.join('\n')}\n`);
console.log(`ball_hi.obj: ${verts.length} vertices, ${uvs.length} uvs, ${faces.length} faces`);

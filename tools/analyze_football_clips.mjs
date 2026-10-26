import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'assets/football/clips';
const loader = new GLTFLoader();
const files = readdirSync(dir).filter((f) => f.endsWith('.glb')).sort();
const out = [];

const parse = (file) => new Promise((resolve, reject) => {
  const buf = readFileSync(join(dir, file));
  loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', resolve, reject);
});

for (const file of files) {
  const gltf = await parse(file);
  const clip = gltf.animations[0];
  if (!clip) continue;
  const mixer = new THREE.AnimationMixer(gltf.scene);
  mixer.clipAction(clip).play();
  const bones = {};
  gltf.scene.traverse((o) => {
    if (['Hips', 'RightToe', 'LeftToe', 'RightFoot', 'LeftFoot', 'RightHand', 'LeftHand'].includes(o.name)) {
      bones[o.name] = o;
    }
  });
  const fps = 30;
  const samples = [];
  let prevToe = null, prevHand = null;
  for (let i = 0; i <= Math.ceil(clip.duration * fps); i++) {
    mixer.setTime(i / fps);
    gltf.scene.updateMatrixWorld(true);
    const toe = new THREE.Vector3(), hand = new THREE.Vector3(), hip = new THREE.Vector3();
    bones.RightToe?.getWorldPosition(toe);
    bones.RightHand?.getWorldPosition(hand);
    bones.Hips?.getWorldPosition(hip);
    const toeSpeed = prevToe ? toe.distanceTo(prevToe) * fps : 0;
    const handSpeed = prevHand ? hand.distanceTo(prevHand) * fps : 0;
    prevToe = toe.clone(); prevHand = hand.clone();
    samples.push({ t: +(i / fps).toFixed(2), toe: toe.toArray(), hand: hand.toArray(), hip: hip.toArray(), toeSpeed, handSpeed });
  }
  const topToe = [...samples].sort((a, b) => b.toeSpeed - a.toeSpeed).slice(0, 5)
    .map((s) => ({ t: s.t, v: +s.toeSpeed.toFixed(2), toe: s.toe.map((n) => +n.toFixed(2)) }));
  const topHand = [...samples].sort((a, b) => b.handSpeed - a.handSpeed).slice(0, 3)
    .map((s) => ({ t: s.t, v: +s.handSpeed.toFixed(2) }));
  const ys = samples.map((s) => s.toe[1]);
  const zs = samples.map((s) => s.toe[2]);
  const hips = samples.map((s) => s.hip);
  out.push({
    file, duration: +clip.duration.toFixed(2), tracks: clip.tracks.length,
    topToe, topHand,
    toeY: [Math.min(...ys), Math.max(...ys)].map((n) => +n.toFixed(2)),
    toeZ: [Math.min(...zs), Math.max(...zs)].map((n) => +n.toFixed(2)),
    hipX: [Math.min(...hips.map((h) => h[0])), Math.max(...hips.map((h) => h[0]))].map((n) => +n.toFixed(2)),
    hipZ: [Math.min(...hips.map((h) => h[2])), Math.max(...hips.map((h) => h[2]))].map((n) => +n.toFixed(2))
  });
}
console.log(JSON.stringify(out, null, 2));

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneRig } from 'three/addons/utils/SkeletonUtils.js';
import { FootPlanting } from '../src/render/footPlanting.js';
import { AthleteInstance, findClip } from '../src/render/athletes.js';

const DT = 1 / 60;
const idle = { animMode: 'IDLE', speed: 0 };
const close = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
const sameVector = (a, b, tolerance = 1e-6) => assert.ok(a.distanceTo(b) <= tolerance, `${a.toArray()} != ${b.toArray()}`);
const sameQuaternion = (a, b) => {
  const sign = a.dot(b) < 0 ? -1 : 1;
  a.toArray().forEach((n, i) => close(n, b.toArray()[i] * sign));
};
const world = (bone) => bone.getWorldPosition(new THREE.Vector3());
const pose = (bones) => Object.fromEntries(Object.entries(bones).map(([name, bone]) => [name, bone.quaternion.clone()]));
const samePose = (bones, expected) => Object.entries(expected).forEach(([name, q]) => sameQuaternion(bones[name].quaternion, q));
const finitePose = (bones) => Object.values(bones).forEach((bone) => {
  assert.ok(bone.quaternion.toArray().every(Number.isFinite), bone.name);
  close(bone.quaternion.length(), 1, 2e-5);
  assert.ok(world(bone).toArray().every(Number.isFinite), bone.name);
});

function synthetic() {
  const scene = new THREE.Group();
  scene.rotation.y = -0.3;
  scene.scale.set(0.9, 1.1, 1.2);
  const root = new THREE.Group();
  root.position.set(4, 0, -3);
  root.rotation.y = 0.7;
  root.scale.setScalar(1.25);
  scene.add(root);
  const pivot = new THREE.Group();
  pivot.rotation.set(0.12, 0.2, -0.04);
  pivot.scale.set(0.95, 1.1, 1.2);
  root.add(pivot);
  const bones = {};
  const bone = (name, parent, x, y, z) => {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(x, y, z);
    parent.add(b);
    bones[name] = b;
    return b;
  };
  const pelvis = bone('pelvis', pivot, 0, 0.9, 0);
  pelvis.rotation.set(0.05, -0.15, 0.06);
  for (const [side, sign] of [['l', 1], ['r', -1]]) {
    const thigh = bone(`thigh_${side}`, pelvis, sign * 0.12, 0, 0);
    thigh.rotation.x = -0.35;
    const calf = bone(`calf_${side}`, thigh, 0, -0.45, 0);
    calf.rotation.x = 0.7;
    const foot = bone(`foot_${side}`, calf, 0, -0.45, 0);
    foot.rotation.x = -0.35;
    bone(`ball_${side}`, foot, 0, -0.06, 0.12);
  }
  scene.updateMatrixWorld(true);
  // Place the authored contact near (not on) the flat world ground plane.
  pivot.position.y += (0.04 - world(bones.ball_l).y) / root.getWorldScale(new THREE.Vector3()).y;
  scene.updateMatrixWorld(true);
  const planting = new FootPlanting(root, bones);
  return { scene, root, pivot, bones, planting, base: pose(bones) };
}

function step(rig, p = idle, sample = () => {}, dt = DT) {
  rig.planting.restore();
  sample();
  rig.planting.update(dt, p);
  return rig.planting.getDiagnostics();
}
function settle(rig, count = 12) {
  let diagnostics;
  for (let i = 0; i < count; i++) diagnostics = step(rig);
  return diagnostics;
}

function athlete(t, rig, clips = {}) {
  const mixer = new THREE.AnimationMixer(rig.pivot);
  const noLegTracks = new THREE.AnimationClip('Idle', 1, [
    new THREE.NumberKeyframeTrack('pelvis.position[x]', [0, 1], [0, 0])
  ]);
  const actions = Object.fromEntries(Object.entries({ idle: noLegTracks, ...clips }).map(([kind, clip]) => [kind, mixer.clipAction(clip)]));
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: () => ({ getContext: () => ({ createRadialGradient: () => ({ addColorStop() {} }), fillRect() {} }) })
  } });
  let instance;
  try { instance = new AthleteInstance(rig.root, rig.pivot, mixer, actions, {}); }
  finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else delete globalThis.document;
  }
  t.after(() => { if (instance.root.children.length) instance.dispose(); });
  return instance;
}

test('world contact locks at ground clearance under rotated, scaled, nonidentity parents', () => {
  const rig = synthetic();
  const rootPosition = rig.root.position.clone();
  const pivotPosition = rig.pivot.position.clone();
  const positions = Object.fromEntries(Object.entries(rig.bones).map(([name, bone]) => [name, bone.position.clone()]));
  const first = world(rig.bones.ball_l);
  let diagnostics = settle(rig);
  assert.equal(diagnostics.length, 2);
  for (const d of diagnostics) {
    assert.equal(d.planted, true);
    close(d.weight, 1);
    assert.equal(d.limited, false);
    sameVector(d.contact, d.target);
    close(d.contact.y, 0.018);
    assert.ok(d.finite);
  }
  const target = diagnostics[0].target.clone();
  close(target.x, first.x);
  close(target.z, first.z);
  sameVector(rig.root.position, rootPosition);
  sameVector(rig.pivot.position, pivotPosition);
  for (const [name, position] of Object.entries(positions)) sameVector(rig.bones[name].position, position);
  for (let i = 0; i < 20; i++) {
    diagnostics = step(rig, idle, () => { rig.root.position.z += 0.002; });
    sameVector(diagnostics[0].target, target);
    sameVector(diagnostics[0].contact, target);
    assert.ok(world(rig.bones.foot_l).y >= 0.018);
  }
  // Diagnostics are copies, not an externally writable contact controller.
  diagnostics[0].target.set(100, 100, 100);
  sameVector(rig.planting.getDiagnostics()[0].target, target);
  finitePose(rig.bones);
});

test('planting preserves the sampled knee bend hemisphere and segment lengths', () => {
  const rig = synthetic();
  const kneeBend = () => {
    const parent = rig.bones.thigh_l.parent;
    const hip = rig.bones.thigh_l.position.clone();
    const knee = parent.worldToLocal(world(rig.bones.calf_l)).sub(hip);
    const end = parent.worldToLocal(world(rig.bones.foot_l)).sub(hip).normalize();
    return knee.addScaledVector(end, -knee.dot(end)).normalize();
  };
  const before = kneeBend();
  settle(rig);
  assert.ok(before.dot(kneeBend()) > 0.99);
  close(rig.bones.calf_l.position.length(), 0.45);
  close(rig.bones.foot_l.position.length(), 0.45);
});

test('stance detection uses animation-local backward motion, not root travel', () => {
  const rig = synthetic();
  const run = { animMode: 'RUN', speed: 1 };
  for (let i = 0; i < 8; i++) {
    const diagnostics = step(rig, run, () => { rig.root.position.z += 0.01; });
    assert.ok(diagnostics.every((d) => !d.planted));
  }
  let planted = false;
  for (let i = 0; i < 6; i++) {
    const diagnostics = step(rig, run, () => {
      rig.root.position.z += 0.008;
      rig.bones.pelvis.position.z -= 0.008;
    });
    planted ||= diagnostics[0].planted;
  }
  assert.ok(planted, 'low, backward-moving local foot should enter stance');
  const before = rig.planting.getDiagnostics()[0];
  assert.equal(before.weight, 1);
  const released = step(rig, run, () => { rig.bones.pelvis.position.z += 0.03; })[0];
  assert.equal(released.planted, false, 'a low foot travelling forward is swing, not stance');
  assert.ok(released.weight > 0 && released.weight < before.weight);
});

test('blend-in, high-foot release, blend-out, and fresh contact capture', () => {
  const rig = synthetic();
  step(rig);
  const entering = step(rig)[0];
  assert.ok(entering.weight > 0 && entering.weight < 1);
  const planted = settle(rig)[0];
  const originalHeight = rig.bones.pelvis.position.y;
  const released = step(rig, idle, () => { rig.bones.pelvis.position.y += 0.25; })[0];
  assert.equal(released.planted, false);
  assert.ok(released.weight > 0 && released.weight < 1);
  sameVector(released.target, planted.target);
  const airborne = settle(rig)[0];
  assert.equal(airborne.target, null);
  assert.equal(airborne.weight, 0);
  samePose(rig.bones, rig.base);
  step(rig, idle, () => {
    rig.bones.pelvis.position.y = originalHeight;
    rig.bones.pelvis.position.z += 0.04;
  });
  const next = settle(rig)[0];
  assert.equal(next.planted, true);
  assert.ok(next.target.distanceTo(planted.target) > 0.03);
  sameVector(next.target, next.contact);
});

test('horizontal correction is capped and a stretched contact releases without repeatedly relatching', () => {
  const rig = synthetic();
  settle(rig);
  let released = false;
  for (let i = 0; i < 24; i++) {
    rig.planting.restore();
    rig.root.position.z += 0.02;
    const sampled = world(rig.bones.foot_l);
    rig.planting.update(DT, idle);
    const corrected = world(rig.bones.foot_l);
    assert.ok(Math.hypot(corrected.x - sampled.x, corrected.z - sampled.z) <= 0.18001);
    const d = rig.planting.getDiagnostics()[0];
    released ||= !d.planted;
    if (released) assert.equal(d.planted, false);
    finitePose(rig.bones);
  }
  assert.ok(released);
  assert.equal(rig.planting.getDiagnostics()[0].target, null);
});

test('skip all nonlocomotion and goalkeeper action poses without leaking corrections', () => {
  const rig = synthetic();
  for (const animMode of ['KICK', 'HEADER', 'DIVE', 'SLIDE', 'FEINT', 'BROKEN', 'TACKLE', 'CELEBRATE', 'GK_READY', 'GK_HOLD', 'GK_SPREAD', 'THROWIN', 'UNKNOWN']) {
    assert.equal(settle(rig)[0].planted, true);
    const diagnostics = step(rig, { animMode, speed: 8, kickTimer: 0.16 });
    assert.ok(diagnostics.every((d) => d.target === null && d.weight === 0 && !d.planted), animMode);
    samePose(rig.bones, rig.base);
  }
});

test('teleport, abrupt facing change, reversed travel, and long frame gaps reset contact', () => {
  for (const change of [
    (rig) => { rig.root.position.x += 5; },
    (rig) => { rig.root.rotation.y += Math.PI / 2; },
    (rig) => { rig.root.position.z -= 0.01; }
  ]) {
    const rig = synthetic();
    settle(rig);
    step(rig, idle, () => { rig.root.position.z += 0.01; });
    const previous = rig.planting.getDiagnostics()[0].target;
    const diagnostics = step(rig, idle, () => change(rig));
    assert.ok(diagnostics.every((d) => d.target === null && d.weight === 0));
    samePose(rig.bones, rig.base);
    const next = settle(rig)[0];
    assert.equal(next.planted, true);
    if (rig.root.position.x > 5) assert.ok(next.target.distanceTo(previous) > 4);
  }
  const rig = synthetic();
  for (const dt of [0, -1, NaN, Infinity, 0.4]) {
    settle(rig);
    assert.ok(step(rig, idle, () => {}, dt).every((d) => d.target === null));
    samePose(rig.bones, rig.base);
  }
});

test('hundreds of updates restore exact untracked bases without accumulated rotation or position', () => {
  const rig = synthetic();
  const planted = settle(rig)[0];
  const expected = pose(rig.bones);
  const offset = rig.pivot.position.clone();
  for (let i = 0; i < 300; i++) {
    rig.planting.restore();
    samePose(rig.bones, rig.base);
    rig.planting.restore(); // Idempotent even on bones absent from mixer tracks.
    rig.planting.update(DT, idle);
    samePose(rig.bones, expected);
    sameVector(rig.planting.getDiagnostics()[0].target, planted.target);
    sameVector(rig.pivot.position, offset);
  }
  rig.planting.reset();
  samePose(rig.bones, rig.base);
});

test('straight, unreachable, degenerate, and unsupported scaled legs remain finite', () => {
  const rig = synthetic();
  rig.planting.restore();
  for (const name of ['thigh_l', 'calf_l', 'foot_l']) rig.bones[name].quaternion.identity();
  for (let i = 0; i < 60; i++) step(rig);
  finitePose(rig.bones);
  const parent = rig.bones.thigh_l.parent;
  const hip = rig.bones.thigh_l.position;
  const end = parent.worldToLocal(world(rig.bones.foot_l));
  assert.ok(end.distanceTo(hip) <= 0.9 + 1e-6, 'never extends bone lengths');
  rig.planting.reset();
  rig.bones.calf_l.scale.set(1, 0.8, 1);
  assert.equal(settle(rig)[0].target, null);
  finitePose(rig.bones);
  rig.root.scale.x = 0;
  assert.ok(step(rig).every((d) => d.target === null));
  finitePose(rig.bones);
  const missing = synthetic();
  delete missing.bones.ball_l;
  missing.bones.foot_r.position.set(0, 0, 0);
  const planting = new FootPlanting(missing.root, missing.bones);
  planting.update(DT, idle);
  assert.equal(planting.getDiagnostics().length, 0);
});

test('AthleteInstance restores planting before new mixer bindings and overlays, leaving turf markers alone', (t) => {
  const source = synthetic();
  const cleanSource = synthetic();
  const q = source.bones.thigh_r.quaternion.clone();
  const kick = new THREE.AnimationClip('Kick', 1, [
    new THREE.QuaternionKeyframeTrack('thigh_r.quaternion', [0, 1], [...q.toArray(), ...q.toArray()])
  ]);
  const rig = athlete(t, source, { kick });
  const clean = athlete(t, cleanSource, { kick });
  const rootPosition = source.root.position.clone();
  const pivotPosition = source.pivot.position.clone();
  const ringPosition = world(rig.ring);
  const shadowPosition = world(rig.contactShadow);
  for (let i = 0; i < 12; i++) rig.update(DT, idle);
  assert.ok(rig.footPlanting.getDiagnostics().some((d) => d.planted));
  const originalUpdate = rig.mixer.update;
  const sample = t.mock.method(rig.mixer, 'update', function (dt) {
    samePose(source.bones, source.base);
    return originalUpdate.call(this, dt);
  });
  const p = { animMode: 'KICK', speed: 0, kickTimer: 0.16 };
  rig.update(DT, p);
  clean.update(DT, p);
  assert.equal(sample.mock.callCount(), 1);
  sample.mock.restore();
  samePose(source.bones, pose(cleanSource.bones));
  assert.ok(rig.footPlanting.getDiagnostics().every((d) => d.target === null));
  for (const animMode of ['HEADER', 'DIVE', 'GK_READY', 'IDLE']) {
    rig.update(DT, { ...p, animMode });
    clean.update(DT, { ...p, animMode });
    samePose(source.bones, pose(cleanSource.bones));
  }
  sameVector(source.root.position, rootPosition);
  sameVector(source.pivot.position, pivotPosition);
  sameVector(world(rig.ring), ringPosition);
  sameVector(world(rig.contactShadow), shadowPosition);
  close(rig.bodyOffset.position.y, 0);
  rig.dispose();
  assert.ok(rig.footPlanting.getDiagnostics().every((d) => d.target === null));
});

test('bundled Quaternius GLB: idle, walk, jog, sprint contact/release and finite poses', async (t) => {
  // The existing GLTFLoader parses the real geometry, hierarchy and tracks in
  // Node. Texture decoding alone is omitted: no DOM, WebGL or new dependency.
  const loader = new GLTFLoader().register(() => ({
    name: 'HEADLESS_TEST_TEXTURES', loadTexture: () => Promise.resolve(null)
  }));
  const load = async (name) => {
    const bytes = await readFile(new URL(`../assets/athletes/${name}.glb`, import.meta.url));
    return loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  };
  const [model, animations] = await Promise.all([load('player'), load('locomotion')]);
  for (const [kind, speed] of [['idle', 0], ['walk', 0.99], ['jog', 5.2], ['sprint', 6]]) {
    await t.test(kind, () => {
      const root = new THREE.Group();
      root.position.set(3, 0, -5);
      root.rotation.y = 0.8;
      const pivot = cloneRig(model.scene);
      const size = new THREE.Box3().setFromObject(pivot).getSize(new THREE.Vector3());
      pivot.scale.setScalar(1.84 / size.y);
      root.add(pivot);
      pivot.position.y -= new THREE.Box3().setFromObject(pivot).min.y;
      const bones = {};
      pivot.traverse((o) => { if (o.isBone) bones[o.name] = o; });
      assert.equal(Object.keys(bones).length, 65);
      const planting = new FootPlanting(root, bones);
      assert.equal(planting.getDiagnostics().length, 2);
      const mixer = new THREE.AnimationMixer(pivot);
      const clip = findClip(animations.animations, kind);
      assert.ok(clip, kind);
      mixer.clipAction(clip).play();
      const previousTargets = new Map();
      let contacts = 0;
      let settledContacts = 0;
      let releases = 0;
      for (let i = 0; i < 480; i++) {
        planting.restore();
        root.translateZ(speed / 120);
        mixer.update(1 / 120);
        planting.update(1 / 120, { animMode: kind === 'idle' ? 'IDLE' : 'RUN', speed });
        for (const d of planting.getDiagnostics()) {
          assert.ok(d.finite);
          const previous = previousTargets.get(d.side);
          if (d.target) {
            if (previous) sameVector(d.target, previous, 1e-8);
            close(d.target.y, 0.018);
          }
          if (d.planted) contacts++;
          if (d.weight === 1 && d.planted && !d.limited) {
            sameVector(d.contact, d.target, 3e-5);
            settledContacts++;
          }
          if (previous && !d.target) releases++;
          previousTargets.set(d.side, d.target);
        }
        finitePose(bones);
      }
      assert.ok(contacts > 0, `${kind} must detect actual stance`);
      assert.ok(settledContacts > 0, `${kind} must perform actual contact correction, not merely report a target`);
      if (kind !== 'idle') assert.ok(releases > 0, `${kind} must release during swing`);
      planting.reset();
      mixer.stopAllAction();
      mixer.uncacheRoot(pivot);
    });
  }
});

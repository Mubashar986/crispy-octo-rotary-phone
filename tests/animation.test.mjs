import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { AthleteInstance, findClip } from '../src/render/athletes.js';

const clip = (name, duration = 1, tracks = [
  new THREE.NumberKeyframeTrack('animated.position[x]', [0, duration], [0, 0])
]) => new THREE.AnimationClip(name, duration, tracks);
const close = (actual, expected, message = '') => {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} != ${expected}`);
};
const sameQuaternion = (actual, expected, message) => {
  // Component comparison avoids acos precision loss for nearly identical poses.
  const sign = actual.dot(expected) < 0 ? -1 : 1;
  actual.toArray().forEach((v, i) => close(v, expected.toArray()[i] * sign, message));
};
const snapshot = (animMode, kickTimer = 0, speed = 0) => ({ animMode, kickTimer, speed, diveSide: 1 });
const pose = (rig) => Object.fromEntries(Object.entries(rig.bones).map(([name, bone]) => [name, bone.quaternion.clone()]));
const samePose = (rig, expected) => {
  for (const [name, q] of Object.entries(expected)) sameQuaternion(rig.bones[name].quaternion, q, name);
};

function makeRig(t, extraClips = {}) {
  const root = new THREE.Group();
  const pivot = new THREE.Group();
  root.add(pivot);
  const addBone = (name, parent, x = 0, y = 0, z = 0) => {
    const bone = new THREE.Bone();
    bone.name = name;
    bone.position.set(x, y, z);
    parent.add(bone);
    return bone;
  };
  addBone('animated', pivot);
  const pelvis = addBone('pelvis', pivot);
  const spine = addBone('spine_01', pelvis);
  addBone('Head', spine, 0, 1.7);
  for (const [side, sign] of [['l', 1], ['r', -1]]) {
    const arm = addBone(`upperarm_${side}`, spine, sign * 0.23, 1.45);
    arm.rotation.set(Math.PI, 0, sign * 0.05);
    const forearm = addBone(`lowerarm_${side}`, arm, 0, 0.3);
    addBone(`hand_${side}`, forearm, 0, 0.3);
    const thigh = addBone(`thigh_${side}`, pelvis, sign * 0.12, 0.9);
    const calf = addBone(`calf_${side}`, thigh, 0, -0.4);
    calf.rotation.x = 0.03;
    addBone(`foot_${side}`, calf, 0, -0.4);
  }
  const mixer = new THREE.AnimationMixer(pivot);
  const clips = { idle: clip('Idle_Loop'), jog: clip('Jog_Fwd_Loop'), ...extraClips };
  const actions = Object.fromEntries(Object.entries(clips).filter(([, c]) => c).map(([kind, c]) => [kind, mixer.clipAction(c)]));
  // Only the shared blob-shadow texture needs a canvas; no browser or WebGL.
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => ({ getContext: () => ({
      createRadialGradient: () => ({ addColorStop() {} }),
      fillRect() {}
    }) }) }
  });
  let rig;
  try {
    rig = new AthleteInstance(root, pivot, mixer, actions, {});
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete globalThis.document;
  }
  root.userData.rig = rig;
  t.after(() => { if (root.children.length) rig.dispose(); });
  return rig;
}

test('clip selection preserves exact alias priority and never treats Roll as slide', () => {
  const clips = ['Idle_Talking_Loop', 'Walk_Formal_Loop', 'Roll', 'Slide_Extra', 'Slide', 'Idle_Loop', 'Walk_Loop', 'Jog_Fwd_Loop'].map((name) => clip(name));
  assert.equal(findClip(clips, 'idle').name, 'Idle_Loop');
  assert.equal(findClip(clips, 'walk').name, 'Walk_Loop');
  assert.equal(findClip(clips, 'jog').name, 'Jog_Fwd_Loop');
  assert.equal(findClip(clips, 'slide').name, 'Slide');
  assert.equal(findClip([clip('Roll')], 'slide'), null);
  assert.equal(findClip([clip('Slide_Extra')], 'slide').name, 'Slide_Extra');
});

for (const [mode, kind, scale] of [['KICK', 'kick', 1.15], ['DIVE', 'dive', 1], ['SLIDE', 'slide', 1], ['BROKEN', 'stunned', 1]]) {
  test(`${mode} one-shot time advances across updates`, (t) => {
    const rig = makeRig(t, { [kind]: clip(kind, 1, [
      new THREE.NumberKeyframeTrack('animated.position[x]', [0, 1], [0, 2])
    ]) });
    for (let i = 1; i <= 3; i++) {
      rig.update(0.1, snapshot(mode, 0.32 - i * 0.01));
      close(rig.actions[kind].time, i * 0.1 * scale);
      // The first sample may still be fading in (BROKEN uses a 0.12s fade).
      close(rig.bones.animated.position.x, i * 0.2 * scale * rig.actions[kind].getEffectiveWeight());
    }
    assert.equal(rig.actions[kind].loop, THREE.LoopOnce);
    assert.equal(rig.oneShot, true);
  });
}

test('identical snapshots do not restart active or finished one-shots; re-entry does', (t) => {
  const rig = makeRig(t, { kick: clip('Kick', 0.25) });
  const action = rig.actions.kick;
  const reset = t.mock.method(action, 'reset');
  const p = Object.freeze(snapshot('KICK', 0.16));
  for (let i = 0; i < 12; i++) rig.update(0.05, p);
  close(action.time, 0.25);
  assert.equal(reset.mock.callCount(), 1);
  assert.equal(rig.current, action);
  assert.equal(rig.oneShot, false);
  assert.equal(action.paused, true);
  rig.update(0.3, snapshot('IDLE'));
  rig.update(0.05, p);
  close(action.time, 0.05 * 1.15);
  assert.equal(reset.mock.callCount(), 2);
});

test('an outgoing one-shot finishing cannot clear the newly selected action', (t) => {
  const rig = makeRig(t, { kick: clip('Kick', 0.12), dive: clip('Dive') });
  rig.update(0.1, snapshot('KICK', 0.2));
  rig.update(0.04, snapshot('DIVE', 0.4));
  assert.equal(rig.actions.kick.paused, true);
  assert.equal(rig.current, rig.actions.dive);
  assert.equal(rig.oneShot, true);
});

test('missing action clips use looping idle rather than a one-shot jog', (t) => {
  const rig = makeRig(t);
  for (const mode of ['KICK', 'SLIDE', 'DIVE', 'BROKEN', 'CELEBRATE', 'HEADER', 'FEINT', 'GK_HOLD', 'GK_READY']) {
    rig.update(0.1, snapshot(mode, 0.16, 8));
    assert.equal(rig.current, rig.actions.idle, mode);
    assert.equal(rig.current.loop, THREE.LoopRepeat, mode);
    assert.equal(rig.current.clampWhenFinished, false, mode);
    assert.equal(rig.oneShot, false, mode);
    assert.equal(rig.current.timeScale, 1, mode);
  }
  close(rig.actions.jog.time, 0);
});

test('missing idle and dive do not substitute jog or retain the previous clip', (t) => {
  const rig = makeRig(t, { idle: null });
  rig.update(0.1, snapshot('RUN', 0, 4));
  assert.equal(rig.current, rig.actions.jog);
  rig.update(0.1, snapshot('DIVE', 0.3));
  assert.equal(rig.current, null);
  assert.equal(rig.oneShot, false);
  close(rig.bodyOffset.position.y, -0.32);
  assert.equal(rig.actions.jog.isRunning(), false);
});

const overlayModes = ['KICK', 'SLIDE', 'DIVE', 'BROKEN', 'CELEBRATE', 'FEINT', 'HEADER', 'GK_HOLD', 'GK_READY'];
for (const mode of overlayModes) {
  test(`${mode} overlay neither accumulates on untracked bones nor leaks into idle`, (t) => {
    const rig = makeRig(t);
    const neutral = pose(rig);
    const p = snapshot(mode, 0.16);
    rig.update(1 / 60, p);
    const firstPose = pose(rig);
    const firstOffset = rig.bodyOffset.position.y;
    for (let i = 0; i < 60; i++) rig.update(1 / 60, p);
    samePose(rig, firstPose);
    close(rig.bodyOffset.position.y, firstOffset);
    rig.update(0.3, snapshot('IDLE'));
    samePose(rig, neutral);
    close(rig.bodyOffset.position.y, 0);
  });
}

test('direct mode transitions match clean poses without prior overlays', (t) => {
  const rig = makeRig(t);
  for (const mode of ['HEADER', 'DIVE', 'FEINT', 'GK_HOLD', 'GK_READY', 'KICK', 'IDLE']) {
    const clean = makeRig(t);
    const p = snapshot(mode, 0.16);
    clean.update(0.1, p);
    rig.update(0.1, p);
    samePose(rig, pose(clean));
    close(rig.bodyOffset.position.y, clean.bodyOffset.position.y);
  }
});

test('tracked bones retain the sampled base beneath procedural offsets', (t) => {
  const start = new THREE.Quaternion();
  const end = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, 0, 0));
  const rig = makeRig(t, { idle: clip('Idle', 1, [
    new THREE.QuaternionKeyframeTrack('pelvis.quaternion', [0, 1], [...start.toArray(), ...end.toArray()])
  ]) });
  for (let i = 1; i <= 3; i++) {
    rig.update(0.1, snapshot('DIVE', 0.3));
    close(rig.bones.pelvis.rotation.x, i * 0.04);
    close(rig.bones.pelvis.rotation.z, 1.1);
  }
  rig.update(0.1, snapshot('IDLE'));
  close(rig.bones.pelvis.rotation.x, 0.16);
  close(rig.bones.pelvis.rotation.z, 0);
});

test('new mixer bindings never capture a previous additive pose as their rest state', (t) => {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0, 0));
  const rig = makeRig(t, { dive: clip('Dive', 1, [
    new THREE.QuaternionKeyframeTrack('thigh_r.quaternion', [0, 1], [...q.toArray(), ...q.toArray()])
  ]) });
  const neutral = rig.bones.thigh_r.quaternion.clone();
  rig.update(0.1, snapshot('KICK', 0.16));
  rig.update(0.1, snapshot('DIVE', 0.3));
  for (let i = 0; i < 30; i++) rig.update(0.05, snapshot('IDLE'));
  sameQuaternion(rig.bones.thigh_r.quaternion, neutral, 'thigh_r');
});

for (const mode of ['HEADER', 'FEINT', 'DIVE']) {
  test(`${mode} does not select a kick clip or apply the kick overlay`, (t) => {
    const rig = makeRig(t, { kick: clip('Kick') });
    const noTimer = makeRig(t, { kick: clip('Kick') });
    rig.update(0.1, snapshot(mode, 0.16));
    noTimer.update(0.1, snapshot(mode, 0));
    samePose(rig, pose(noTimer));
    assert.equal(rig.current, rig.actions.idle);
    close(rig.actions.kick.time, 0);
    close(rig.bones.foot_r.rotation.x, 0);
    if (mode === 'HEADER') close(rig.bones.thigh_r.rotation.x, rig.bones.thigh_l.rotation.x);
  });
}

test('GK_HOLD interrupts a dive on catch and brings both hands around the held ball', (t) => {
  const rig = makeRig(t, { dive: clip('Dive'), kick: clip('Kick') });
  rig.root.position.set(7, 0, -3);
  rig.root.rotation.y = 1.2;
  rig.update(0.1, snapshot('DIVE', 0.4));
  assert.equal(rig.oneShot, true);
  rig.update(0.1, snapshot('GK_HOLD', 0, 8));
  assert.equal(rig.current, rig.actions.idle);
  assert.equal(rig.oneShot, false);
  close(rig.bodyOffset.position.y, 0);
  const hands = ['l', 'r'].map((side) => rig.bodyOffset.worldToLocal(rig.bones[`hand_${side}`].getWorldPosition(new THREE.Vector3())));
  for (const hand of hands) {
    assert.ok(hand.y > 0.98 && hand.y < 1.2, `hand height: ${hand.y}`);
    assert.ok(hand.z > 0.3 && hand.z < 0.5, `hand forward: ${hand.z}`);
    assert.ok(Math.abs(hand.x) < 0.2);
  }
  assert.ok(hands[0].x > 0 && hands[1].x < 0);
  const midpoint = hands[0].clone().add(hands[1]).multiplyScalar(0.5);
  assert.ok(midpoint.distanceTo(new THREE.Vector3(0, 1.08, 0.42)) < 0.1);
  const heldPose = pose(rig);
  rig.update(0.1, snapshot('GK_HOLD'));
  samePose(rig, heldPose);
});

test('GK_READY provides a wider, lowered ready pose rather than locomotion', (t) => {
  const rig = makeRig(t);
  rig.update(0.1, snapshot('GK_READY', 0, 7));
  assert.equal(rig.current, rig.actions.idle);
  close(rig.bodyOffset.position.y, -0.06);
  for (const side of ['l', 'r']) {
    const hand = rig.bones[`hand_${side}`].getWorldPosition(new THREE.Vector3());
    assert.ok(Math.abs(hand.x) > 0.3);
    assert.ok(hand.z > 0.2);
  }
});

test('body offsets leave the shadow, selection ring, and mixer pivot at turf', (t) => {
  const rig = makeRig(t);
  rig.root.position.set(12, 0, -4);
  rig.pivot.position.y = 0.4;
  rig.pivot.scale.setScalar(2);
  for (const [mode, offset] of [['HEADER', 0.28], ['SLIDE', -0.42], ['DIVE', -0.32], ['BROKEN', -0.22], ['IDLE', 0]]) {
    rig.update(0.1, snapshot(mode, 0.16));
    close(rig.bodyOffset.position.y, offset);
    close(rig.root.position.y, 0);
    close(rig.pivot.position.y, 0.4);
    close(rig.ring.getWorldPosition(new THREE.Vector3()).y, 0.025);
    close(rig.contactShadow.getWorldPosition(new THREE.Vector3()).y, 0.012);
  }
});

test('dispose releases skeleton textures once, mixer bindings, listeners, and owned resources', (t) => {
  const rig = makeRig(t, { kick: clip('Kick') });
  const skeleton = new THREE.Skeleton([rig.bones.pelvis]);
  skeleton.computeBoneTexture();
  const skeletonDispose = t.mock.method(skeleton, 'dispose');
  const textureDispose = t.mock.method(skeleton.boneTexture, 'dispose');
  const sharedGeometry = new THREE.BufferGeometry();
  const sharedDispose = t.mock.method(sharedGeometry, 'dispose');
  const ownedGeometry = new THREE.BufferGeometry();
  const ownedDispose = t.mock.method(ownedGeometry, 'dispose');
  const materials = [new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial()];
  const materialDisposes = materials.map((material) => t.mock.method(material, 'dispose'));
  for (let i = 0; i < 2; i++) {
    const mesh = new THREE.SkinnedMesh(i ? ownedGeometry : sharedGeometry, materials[i]);
    mesh.skeleton = skeleton;
    mesh.userData.ownedGeometry = !!i;
    rig.pivot.add(mesh);
  }
  rig.update(0.1, snapshot('KICK', 0.16));
  const kickClip = rig.actions.kick.getClip();
  assert.ok(rig.mixer.stats.bindings.total > 0);
  rig.dispose();
  assert.equal(skeletonDispose.mock.callCount(), 1);
  assert.equal(textureDispose.mock.callCount(), 1);
  assert.equal(skeleton.boneTexture, null);
  assert.equal(ownedDispose.mock.callCount(), 1);
  assert.equal(sharedDispose.mock.callCount(), 0);
  for (const dispose of materialDisposes) assert.equal(dispose.mock.callCount(), 1);
  assert.equal(rig.mixer.stats.actions.total, 0);
  assert.equal(rig.mixer.stats.bindings.total, 0);
  assert.equal(rig.mixer.existingAction(kickClip, rig.pivot), null);
  assert.equal(rig.mixer.hasEventListener('finished', rig.onFinished), false);
  assert.equal(rig.root.children.length, 0);
  assert.equal(rig.root.userData.rig, undefined);
  sharedGeometry.dispose();
});

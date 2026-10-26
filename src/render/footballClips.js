import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const loader = new GLTFLoader();

// Rokoko/Newton source bone -> Quaternius target bone.
const SOURCE_TO_TARGET = {
  Hips: 'pelvis',
  Spine1: 'spine_01',
  Spine2: 'spine_02',
  Spine3: 'spine_03',
  Neck: 'neck_01',
  Head: 'Head',
  LeftShoulder: 'clavicle_l',
  RightShoulder: 'clavicle_r',
  LeftArm: 'upperarm_l',
  RightArm: 'upperarm_r',
  LeftForeArm: 'lowerarm_l',
  RightForeArm: 'lowerarm_r',
  LeftHand: 'hand_l',
  RightHand: 'hand_r',
  LeftThigh: 'thigh_l',
  RightThigh: 'thigh_r',
  LeftShin: 'calf_l',
  RightShin: 'calf_r',
  LeftFoot: 'foot_l',
  RightFoot: 'foot_r',
  LeftToe: 'ball_l',
  RightToe: 'ball_r'
};
const NAMES = Object.fromEntries(Object.entries(SOURCE_TO_TARGET).map(([source, target]) => [target, source]));
const SOURCE_NAMES = new Set(Object.keys(SOURCE_TO_TARGET));

function findSkinnedMesh(root) {
  let found = null;
  root.traverse((object) => {
    if (!found && object.isSkinnedMesh && object.skeleton?.bones?.length) found = object;
  });
  return found;
}

// The athlete model is Z-up under a -90deg armature root, while the mocap is
// Y-up. World-space rotation transfer lays the body down, and raw local deltas
// twist the limbs because the joints' rest rolls differ. Retarget the source's
// *world rotation delta* onto the target's rest world rotation, then solve the
// target local quaternion through its own animated parent chain.
export async function loadFootballClips(targetRoot, base = '/assets/football') {
  const manifest = await fetch(`${base}/manifest.json`).then((response) => {
    if (!response.ok) throw new Error(`football manifest ${response.status}`);
    return response.json();
  });
  const targetMesh = findSkinnedMesh(targetRoot);
  if (!targetMesh) throw new Error('athlete has no skinned mesh to retarget');
  targetMesh.skeleton.pose();
  targetRoot.updateMatrixWorld(true);

  const MAPPED = Object.keys(NAMES);
  const mappedSet = new Set(MAPPED);
  const targetBones = new Map(targetMesh.skeleton.bones.map((bone) => [bone.name, bone]));
  const worldQuat = (object) => {
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    object.matrixWorld.decompose(position, quaternion, scale);
    return quaternion;
  };
  const depth = (bone) => {
    let d = 0;
    for (let parent = bone.parent; parent; parent = parent.parent) d++;
    return d;
  };
  const mappedBones = MAPPED.map((name) => targetBones.get(name)).filter(Boolean)
    .sort((a, b) => depth(a) - depth(b));
  const targetRestWorld = new Map([...targetBones].map(([name, bone]) => [name, worldQuat(bone)]));
  const targetRootWorld = worldQuat(targetRoot);
  // Nearest non-mapped parent (the target's root bone) keeps its rest world;
  // mapped parents are solved in animated order below.
  const parentUnmappedWorld = new Map();
  for (const bone of mappedBones) {
    let parent = bone.parent;
    while (parent && !mappedSet.has(parent.name)) {
      if (targetBones.has(parent.name)) parentUnmappedWorld.set(bone.name, targetRestWorld.get(parent.name));
      parent = parent.parent;
      if (parentUnmappedWorld.has(bone.name)) break;
    }
  }

  const out = { clipsByKind: {}, variants: {}, meta: {} };
  for (const entry of manifest.clips) {
    try {
      const gltf = await loader.loadAsync(`${base}/clips/${entry.file}`);
      const sourceBones = new Map();
      gltf.scene.traverse((object) => {
        if (SOURCE_NAMES.has(object.name)) sourceBones.set(object.name, object);
      });
      if (!sourceBones.size) throw new Error('no matching source bones');
      gltf.scene.updateMatrixWorld(true);
      const sourceRestWorld = new Map([...sourceBones].map(([name, bone]) => [name, worldQuat(bone)]));
      const sourceClip = gltf.animations[0];
      if (!sourceClip) throw new Error('no animation');

      const [start, end] = entry.trim ?? [0, sourceClip.duration];
      const fps = 30;
      const frames = Math.max(2, Math.round((end - start) * fps));
      const mixer = new THREE.AnimationMixer(gltf.scene);
      mixer.clipAction(sourceClip).play();
      const values = new Map();
      for (let frame = 0; frame < frames; frame++) {
        mixer.setTime(start + frame / fps);
        gltf.scene.updateMatrixWorld(true);
        const sourceWorld = new Map([...sourceBones].map(([name, bone]) => [name, worldQuat(bone)]));
        const animatedWorld = new Map();
        for (const bone of mappedBones) {
          const sourceName = NAMES[bone.name];
          const s0 = sourceRestWorld.get(sourceName);
          const s1 = sourceWorld.get(sourceName);
          const t0 = targetRestWorld.get(bone.name);
          if (!s0 || !s1 || !t0) continue;
          const delta = s0.clone().invert().multiply(s1);
          const desiredWorld = t0.clone().multiply(delta);
          let parentWorld = parentUnmappedWorld.get(bone.name);
          if (!parentWorld) {
            let parent = bone.parent;
            while (parent && !mappedSet.has(parent.name)) parent = parent.parent;
            parentWorld = parent ? animatedWorld.get(parent.name) : targetRootWorld;
          }
          const local = (parentWorld ?? targetRootWorld).clone().invert().multiply(desiredWorld).normalize();
          let track = values.get(bone.name);
          if (!track) { track = { times: [], values: [] }; values.set(bone.name, track); }
          track.times.push(frame / fps);
          track.values.push(local.x, local.y, local.z, local.w);
          animatedWorld.set(bone.name, desiredWorld);
        }
      }
      mixer.uncacheAction(sourceClip);
      const tracks = [...values].map(([name, track]) =>
        new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, track.times, track.values));
      const clip = new THREE.AnimationClip(entry.id, (frames - 1) / fps, tracks);
      const contactOffset = entry.contact != null ? entry.contact - start : null;
      const startAtOffset = entry.startAt != null ? entry.startAt - start : null;
      const meta = { ...entry, contactOffset, startAtOffset, duration: clip.duration };
      (out.variants[entry.kind] ??= []).push({ meta, clip });
      if (!out.clipsByKind[entry.kind]) {
        out.clipsByKind[entry.kind] = clip;
        out.meta[entry.kind] = meta;
      }
    } catch (error) {
      console.warn(`[football] skipped ${entry.file}:`, error.message);
    }
  }
  targetMesh.skeleton.pose();
  targetRoot.updateMatrixWorld(true);
  return out;
}

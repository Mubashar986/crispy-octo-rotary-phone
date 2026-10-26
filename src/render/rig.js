import * as THREE from 'three';

const part = (geo, mat, x = 0, y = 0, z = 0) => {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
};

// Articulated low-poly footballer. Returns the rig only — the caller attaches it.
export function createFootballer(spec) {
  const disposables = [];
  const track = (o) => { disposables.push(o); return o; };

  const kit = track(new THREE.MeshStandardMaterial({ color: spec.kitPrimary ?? 0x2aa8e0, roughness: 0.7 }));
  const kit2 = track(new THREE.MeshStandardMaterial({ color: spec.kitSecondary ?? 0x0d2b45, roughness: 0.7 }));
  const skin = track(new THREE.MeshStandardMaterial({ color: spec.skin ?? 0x8a5a3b, roughness: 0.8 }));
  const boot = track(new THREE.MeshStandardMaterial({ color: spec.boot ?? 0xf2c200, roughness: 0.5 }));
  const hair = track(new THREE.MeshStandardMaterial({ color: spec.hair ?? 0x23160d, roughness: 0.9 }));

  const torsoGeo = track(new THREE.CylinderGeometry(0.19, 0.23, 0.62, 10));
  const headGeo = track(new THREE.SphereGeometry(0.155, 12, 10));
  const hairGeo = track(new THREE.SphereGeometry(0.165, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55));
  const limbGeo = track(new THREE.CylinderGeometry(0.065, 0.055, 0.42, 8));
  const lowerGeo = track(new THREE.CylinderGeometry(0.055, 0.05, 0.42, 8));
  const bootGeo = track(new THREE.BoxGeometry(0.12, 0.09, 0.28));
  const shortsGeo = track(new THREE.CylinderGeometry(0.22, 0.2, 0.24, 10));

  const root = new THREE.Group();
  const pelvis = new THREE.Group(); pelvis.position.y = 0.92; root.add(pelvis);
  const shorts = part(shortsGeo, kit2, 0, 0.02, 0); pelvis.add(shorts);

  const torso = new THREE.Group(); torso.position.y = 0.12; pelvis.add(torso);
  torso.add(part(torsoGeo, kit, 0, 0.31, 0));

  const headGroup = new THREE.Group(); headGroup.position.y = 0.68; torso.add(headGroup);
  headGroup.add(part(headGeo, skin, 0, 0.06, 0));
  headGroup.add(part(hairGeo, hair, 0, 0.075, 0));

  const buildLimb = (side, isArm) => {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.24, isArm ? 0.55 : 0.0, 0);
    const upper = part(isArm ? limbGeo : limbGeo, isArm ? kit : kit2, 0, -0.21, 0);
    shoulder.add(upper);
    const joint = new THREE.Group(); joint.position.y = -0.42; shoulder.add(joint);
    const lower = part(lowerGeo, isArm ? skin : kit, 0, -0.21, 0);
    joint.add(lower);
    const foot = new THREE.Group(); foot.position.y = -0.42; joint.add(foot);
    if (!isArm) foot.add(part(bootGeo, boot, 0, -0.03, 0.06));
    else foot.add(part(new THREE.SphereGeometry(0.06, 8, 6), skin, 0, -0.05, 0));
    return { shoulder, joint, foot };
  };

  const leftArm = buildLimb(-1, true); torso.add(leftArm.shoulder);
  const rightArm = buildLimb(1, true); torso.add(rightArm.shoulder);
  const leftLeg = buildLimb(-1, false); pelvis.add(leftLeg.shoulder);
  const rightLeg = buildLimb(1, false); pelvis.add(rightLeg.shoulder);

  // selection ring (local player) — hidden by default
  const ringGeo = track(new THREE.RingGeometry(0.42, 0.55, 28));
  const ringMat = track(new THREE.MeshBasicMaterial({ color: 0x35e06a, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.03;
  ring.visible = false;
  root.add(ring);

  return {
    root, pelvis, torso, headGroup,
    leftArm, rightArm, leftLeg, rightLeg, ring,
    animPhase: Math.random() * 6, kickTimer: 0, prevYaw: 0, turnLean: 0,
    dispose() { for (const d of disposables) d.dispose?.(); root.clear(); }
  };
}

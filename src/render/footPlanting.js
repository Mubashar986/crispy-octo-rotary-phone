import * as THREE from 'three';

const LOCOMOTION = new Set(['IDLE', 'RUN', 'WALK', 'JOG', 'SPRINT']);
const CLEARANCE = 0.018;
const MAX_HORIZONTAL = 0.18;
const MAX_VERTICAL = 0.12;
const EPS = 1e-7;
const finiteVector = (v) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
const finiteQuaternion = (q) => finiteVector(q) && Number.isFinite(q.w) && q.lengthSq() > EPS;
// GLB float32 scale tracks have small component differences even at unit scale.
const uniformScale = (v) => finiteVector(v) && v.x > EPS && Math.abs(v.x - v.y) < v.x * 1e-5 && Math.abs(v.x - v.z) < v.x * 1e-5;

// A flat-turf, leg-only contact correction, not a replacement locomotion clip.
// Call restore BEFORE activating/sampling the mixer, then update BEFORE overlays.
export class FootPlanting {
  constructor(root, bones, { groundY = 0 } = {}) {
    this.root = root;
    this.groundY = groundY;
    this.legs = [];
    this.hasRootSample = false;
    this.previousRoot = new THREE.Vector3();
    this.previousForward = new THREE.Vector3();
    this.previousScale = new THREE.Vector3();
    this.travelDirection = new THREE.Vector3();
    this.rootPosition = new THREE.Vector3();
    this.forward = new THREE.Vector3();
    this.scale = new THREE.Vector3();
    this.travel = new THREE.Vector3();
    this.rootInverse = new THREE.Matrix4();
    root.updateWorldMatrix(true, true);
    for (const side of ['l', 'r']) {
      const [thigh, calf, foot, toe] = ['thigh', 'calf', 'foot', 'ball'].map((name) => bones[`${name}_${side}`]);
      // Partial/unrecognised rigs retain their authored animation unchanged.
      if (!thigh?.parent || calf?.parent !== thigh || foot?.parent !== calf || toe?.parent !== foot) continue;
      const upper = calf.position.length() * thigh.scale.x;
      const lower = foot.position.length() * thigh.scale.x * calf.scale.x;
      if (!(upper > EPS && lower > EPS)) continue;
      const leg = {
        side, thigh, calf, foot, toe, restLengths: [upper, lower],
        base: [thigh.quaternion.clone(), calf.quaternion.clone(), foot.quaternion.clone()],
        applied: false, planted: false, armed: true, weight: 0, age: 0,
        hasSample: false, hasTarget: false, anchor: toe, limited: false,
        previousLocal: new THREE.Vector3(), previousHeight: 0,
        local: new THREE.Vector3(), ankle: new THREE.Vector3(), toePosition: new THREE.Vector3(),
        contact: new THREE.Vector3(), target: new THREE.Vector3(), goal: new THREE.Vector3(),
        hip: new THREE.Vector3(), knee: new THREE.Vector3(), end: new THREE.Vector3(),
        direction: new THREE.Vector3(), pole: new THREE.Vector3(), bend: new THREE.Vector3(),
        desiredKnee: new THREE.Vector3(), axis: new THREE.Vector3(), aim: new THREE.Vector3(),
        parentInverse: new THREE.Matrix4(), rotation: new THREE.Quaternion(),
        footOrientation: new THREE.Quaternion(),
        solvedThigh: new THREE.Quaternion(), solvedCalf: new THREE.Quaternion()
      };
      this.legs.push(leg);
    }
  }

  restore() {
    for (const leg of this.legs) {
      if (!leg.applied) continue;
      [leg.thigh, leg.calf, leg.foot].forEach((bone, i) => bone.quaternion.copy(leg.base[i]));
      leg.applied = false;
    }
  }

  reset() {
    this.restore();
    this.hasRootSample = false;
    this.travelDirection.set(0, 0, 0);
    for (const leg of this.legs) {
      leg.planted = leg.hasSample = leg.hasTarget = leg.limited = false;
      leg.armed = true;
      leg.weight = leg.age = 0;
      leg.pole.set(0, 0, 0);
    }
  }

  update(dt, p = {}) {
    if (!LOCOMOTION.has(p.animMode ?? 'IDLE') || !Number.isFinite(dt) || dt <= 0 || dt > 0.15 || !Number.isFinite(this.groundY)) {
      this.reset();
      return;
    }
    this.root.updateWorldMatrix(true, true);
    const matrix = this.root.matrixWorld;
    this.rootPosition.setFromMatrixPosition(matrix);
    this.forward.set(0, 0, 1).transformDirection(matrix);
    this.scale.setFromMatrixScale(matrix);
    if (!finiteVector(this.rootPosition) || !finiteVector(this.scale) || Math.abs(matrix.determinant()) < EPS) {
      this.reset();
      return;
    }
    this.travel.subVectors(this.rootPosition, this.previousRoot);
    const moving = this.hasRootSample && this.travel.lengthSq() > 0.000001;
    const discontinuity = this.hasRootSample && (
      this.travel.length() > 0.75 || this.forward.dot(this.previousForward) < 0.64 ||
      this.scale.distanceTo(this.previousScale) > this.previousScale.length() * 0.02 ||
      (moving && this.travelDirection.lengthSq() > 0 && this.travel.dot(this.travelDirection) / this.travel.length() < 0.25)
    );
    if (discontinuity) this.reset();
    if (moving && !discontinuity) this.travelDirection.copy(this.travel).normalize();
    this.previousRoot.copy(this.rootPosition);
    this.previousForward.copy(this.forward);
    this.previousScale.copy(this.scale);
    this.hasRootSample = true;
    if (discontinuity) return;
    this.rootInverse.copy(matrix).invert();
    for (const leg of this.legs) this.updateLeg(leg, dt, (p.speed ?? 0) < 0.35);
  }

  updateLeg(leg, dt, idle) {
    const { thigh, calf, foot, toe } = leg;
    foot.getWorldPosition(leg.ankle);
    toe.getWorldPosition(leg.toePosition);
    leg.local.copy(leg.ankle).applyMatrix4(this.rootInverse);
    const height = Math.min(leg.ankle.y, leg.toePosition.y);
    const forwardSpeed = leg.hasSample ? (leg.local.z - leg.previousLocal.z) * this.scale.z / dt : 0;
    const riseSpeed = leg.hasSample ? (height - leg.previousHeight) / dt : 0;
    // Keyframe interpolation can ripple a grounded toe by a few millimetres;
    // rising velocity alone is not lift-off until the contact also clears turf.
    const swing = height > this.groundY + 0.11 || forwardSpeed > 0.2 || (riseSpeed > 0.65 && height > this.groundY + 0.045);
    const stance = leg.hasSample && !swing && height < this.groundY + 0.065 &&
      (idle ? Math.abs(forwardSpeed) < 0.15 : forwardSpeed < -0.04);
    leg.previousLocal.copy(leg.local);
    leg.previousHeight = height;
    leg.hasSample = true;
    leg.limited = false;
    if (!finiteVector(leg.ankle) || !finiteVector(leg.toePosition) ||
        ![thigh, calf, foot].every((bone) => finiteQuaternion(bone.quaternion)) ||
        !uniformScale(thigh.scale) || !uniformScale(calf.scale) ||
        Math.abs(thigh.parent.matrixWorld.determinant()) < EPS) {
      leg.planted = leg.hasTarget = leg.hasSample = false;
      leg.weight = 0;
      return;
    }

    if (swing) { leg.planted = false; leg.armed = true; }
    if (stance && leg.armed && !leg.hasTarget) {
      // Lock the lowest authored contact point (toe or heel/ankle). Keeping its
      // sampled offset below lets the foot roll without inventing ankle pitch.
      leg.anchor = leg.toePosition.y < leg.ankle.y ? toe : foot;
      leg.target.copy(leg.anchor === toe ? leg.toePosition : leg.ankle);
      leg.target.y = this.groundY + CLEARANCE;
      leg.planted = leg.hasTarget = true;
      leg.armed = false;
      leg.age = 0;
    }
    if (!leg.hasTarget) return;
    leg.age += dt;
    leg.contact.copy(leg.anchor === toe ? leg.toePosition : leg.ankle);
    // A stationary world contact, converted to an ankle goal using THIS mixer
    // sample, never the corrected pose. Only quaternions are changed below.
    leg.goal.copy(leg.target).sub(leg.contact).add(leg.ankle);
    const horizontal = Math.hypot(leg.goal.x - leg.ankle.x, leg.goal.z - leg.ankle.z);
    const vertical = leg.goal.y - leg.ankle.y;
    const otherBelowGround = leg.goal.y + Math.min(0, leg.toePosition.y - leg.ankle.y) < this.groundY + CLEARANCE - 0.008;
    if (horizontal > MAX_HORIZONTAL || Math.abs(vertical) > MAX_VERTICAL || otherBelowGround || (!idle && leg.age > 0.7)) {
      leg.planted = false;
    }
    leg.weight = THREE.MathUtils.clamp(leg.weight + (leg.planted ? dt / 0.045 : -dt / 0.08), 0, 1);
    if (leg.weight === 0) { leg.hasTarget = false; return; }
    if (horizontal > MAX_HORIZONTAL) {
      const ratio = MAX_HORIZONTAL / horizontal;
      leg.goal.x = leg.ankle.x + (leg.goal.x - leg.ankle.x) * ratio;
      leg.goal.z = leg.ankle.z + (leg.goal.z - leg.ankle.z) * ratio;
      leg.limited = true;
    }
    leg.goal.y = leg.ankle.y + THREE.MathUtils.clamp(vertical, -MAX_VERTICAL, MAX_VERTICAL);
    if (Math.abs(vertical) > MAX_VERTICAL) leg.limited = true;
    leg.goal.lerpVectors(leg.ankle, leg.goal, leg.weight);
    this.solve(leg);
    leg.anchor.getWorldPosition(leg.contact);
  }

  solve(leg) {
    const { thigh, calf, foot } = leg;
    leg.parentInverse.copy(thigh.parent.matrixWorld).invert();
    leg.hip.copy(thigh.position);
    calf.getWorldPosition(leg.knee).applyMatrix4(leg.parentInverse);
    leg.end.copy(leg.ankle).applyMatrix4(leg.parentInverse);
    // Imported clips may also key bone translations. Cache rest lengths, but
    // honour the sampled segment lengths rather than stretching those bones.
    const upper = calf.position.length() * thigh.scale.x;
    const lower = foot.position.length() * thigh.scale.x * calf.scale.x;
    const epsilon = Math.max(EPS, (leg.restLengths[0] + leg.restLengths[1]) * 0.001);
    if (!(upper > epsilon && lower > epsilon)) return;
    leg.direction.subVectors(leg.end, leg.hip).normalize();
    leg.bend.subVectors(leg.knee, leg.hip);
    leg.bend.addScaledVector(leg.direction, -leg.bend.dot(leg.direction));
    if (leg.bend.lengthSq() > epsilon * epsilon) leg.pole.copy(leg.bend).normalize();
    leg.goal.applyMatrix4(leg.parentInverse);
    leg.direction.subVectors(leg.goal, leg.hip);
    const distance = leg.direction.length();
    if (!(distance > EPS) || !finiteVector(leg.goal)) return;
    leg.direction.divideScalar(distance);
    const reach = THREE.MathUtils.clamp(distance, Math.abs(upper - lower) + epsilon, upper + lower - epsilon);
    if (Math.abs(reach - distance) > EPS) leg.limited = true;
    leg.goal.copy(leg.hip).addScaledVector(leg.direction, reach);
    leg.bend.copy(leg.pole).addScaledVector(leg.direction, -leg.pole.dot(leg.direction));
    if (leg.bend.lengthSq() < EPS) {
      // Exactly straight legs have no pole. Choose a stable perpendicular, then
      // retain it; otherwise always keep the sampled knee's bend hemisphere.
      leg.bend.set(Math.abs(leg.direction.x) < 0.8 ? 1 : 0, 0, Math.abs(leg.direction.x) < 0.8 ? 0 : 1);
      leg.bend.addScaledVector(leg.direction, -leg.bend.dot(leg.direction));
      leg.pole.copy(leg.bend).normalize();
    }
    leg.bend.normalize();
    const along = (upper * upper - lower * lower + reach * reach) / (2 * reach);
    const bendHeight = Math.sqrt(Math.max(0, upper * upper - along * along));
    leg.desiredKnee.copy(leg.hip).addScaledVector(leg.direction, along).addScaledVector(leg.bend, bendHeight);
    [thigh, calf, foot].forEach((bone, i) => leg.base[i].copy(bone.quaternion));
    leg.applied = true;
    leg.footOrientation.copy(thigh.quaternion).multiply(calf.quaternion).multiply(foot.quaternion);

    leg.aim.subVectors(leg.desiredKnee, leg.hip).normalize();
    leg.axis.copy(calf.position).multiply(thigh.scale).applyQuaternion(thigh.quaternion).normalize();
    this.rotate(leg, thigh, leg.base[0], 0.65);
    thigh.updateWorldMatrix(false, true);
    leg.goal.applyMatrix4(thigh.parent.matrixWorld);
    leg.aim.copy(leg.goal);
    thigh.worldToLocal(leg.aim).sub(calf.position).normalize();
    leg.axis.copy(foot.position).multiply(calf.scale).applyQuaternion(calf.quaternion).normalize();
    this.rotate(leg, calf, leg.base[1], 0.9);
    this.orientFoot(leg);
    if (![thigh, calf, foot].every((bone) => finiteQuaternion(bone.quaternion))) {
      [thigh, calf, foot].forEach((bone, i) => bone.quaternion.copy(leg.base[i]));
      thigh.updateWorldMatrix(false, true);
      leg.applied = leg.planted = leg.hasTarget = false;
      leg.weight = 0;
      return;
    }
    this.enforceBounds(leg);
  }

  orientFoot(leg) {
    // Preserve the authored foot orientation in thigh-parent space. Solving in
    // this space also supports rotated/nonuniformly scaled ancestors without
    // decomposing sheared world matrices. Segment scales themselves must be uniform.
    leg.foot.quaternion.copy(leg.thigh.quaternion).multiply(leg.calf.quaternion).invert().multiply(leg.footOrientation).normalize();
    leg.thigh.updateWorldMatrix(false, true);
  }

  withinBounds(leg) {
    leg.foot.getWorldPosition(leg.end).sub(leg.ankle);
    return Math.hypot(leg.end.x, leg.end.z) <= MAX_HORIZONTAL && Math.abs(leg.end.y) <= MAX_VERTICAL;
  }

  enforceBounds(leg) {
    // Reach/joint clamps can miss the requested endpoint. Bound the actual
    // displacement too, including under nonuniform ancestor scale.
    if (this.withinBounds(leg)) return;
    leg.limited = true;
    leg.solvedThigh.copy(leg.thigh.quaternion);
    leg.solvedCalf.copy(leg.calf.quaternion);
    let low = 0;
    let high = 1;
    for (let i = 0; i < 8; i++) {
      const fraction = (low + high) / 2;
      leg.thigh.quaternion.slerpQuaternions(leg.base[0], leg.solvedThigh, fraction);
      leg.calf.quaternion.slerpQuaternions(leg.base[1], leg.solvedCalf, fraction);
      this.orientFoot(leg);
      if (this.withinBounds(leg)) low = fraction;
      else high = fraction;
    }
    leg.thigh.quaternion.slerpQuaternions(leg.base[0], leg.solvedThigh, low);
    leg.calf.quaternion.slerpQuaternions(leg.base[1], leg.solvedCalf, low);
    this.orientFoot(leg);
  }

  rotate(leg, bone, base, limit) {
    leg.rotation.setFromUnitVectors(leg.axis, leg.aim);
    bone.quaternion.premultiply(leg.rotation).normalize();
    const angle = base.angleTo(bone.quaternion);
    if (angle > limit) {
      bone.quaternion.slerpQuaternions(base, bone.quaternion, limit / angle);
      leg.limited = true;
    }
  }

  // Snapshots only: callers cannot mutate targets or feed diagnostics into IK.
  getDiagnostics() {
    return this.legs.map((leg) => ({
      side: leg.side, planted: leg.planted, weight: leg.weight, limited: leg.limited,
      target: leg.hasTarget ? leg.target.clone() : null,
      contact: leg.hasTarget ? leg.contact.clone() : null,
      finite: [leg.thigh, leg.calf, leg.foot].every((bone) => finiteQuaternion(bone.quaternion))
    }));
  }
}

// Procedural pose driver. Every channel is reset each frame so no pose can leak
// between animModes (the original left arms/head permanently splayed — bug G11).
export function animateRig(rig, p, dt, ballPos) {
  const { torso, headGroup, leftArm, rightArm, leftLeg, rightLeg, pelvis } = rig;
  torso.rotation.set(0, 0, 0);
  headGroup.rotation.set(0, 0, 0);
  leftArm.shoulder.rotation.set(0, 0, 0.12);
  rightArm.shoulder.rotation.set(0, 0, -0.12);
  leftArm.joint.rotation.set(-0.35, 0, 0);
  rightArm.joint.rotation.set(-0.35, 0, 0);
  leftLeg.shoulder.rotation.set(0, 0, 0);
  rightLeg.shoulder.rotation.set(0, 0, 0);
  leftLeg.joint.rotation.set(0.06, 0, 0);
  rightLeg.joint.rotation.set(0.06, 0, 0);
  pelvis.position.y = 0.92;
  pelvis.rotation.set(0, 0, 0);

  const speed = p.speed ?? 0;
  rig.animPhase += dt * (4 + speed * 2.1);
  const ph = rig.animPhase;

  switch (p.animMode) {
    case 'GK_READY':
      leftArm.shoulder.rotation.z = 0.5; rightArm.shoulder.rotation.z = -0.5;
      leftArm.shoulder.rotation.x = -0.4; rightArm.shoulder.rotation.x = -0.4;
      pelvis.position.y = 0.84;
      leftLeg.shoulder.rotation.x = 0.25; rightLeg.shoulder.rotation.x = -0.25;
      break;
    case 'GK_SPREAD':
      leftArm.shoulder.rotation.z = 1.35; rightArm.shoulder.rotation.z = -1.35;
      pelvis.position.y = 0.8;
      break;
    case 'DIVE': {
      const t = Math.min(1, (p.kickTimer ?? 0) * 3);
      torso.rotation.z = 1.35 * t * (p.diveSide ?? 1);
      pelvis.position.y = 0.92 - 0.5 * t;
      leftArm.shoulder.rotation.z = 1.9; rightArm.shoulder.rotation.z = -1.9;
      break;
    }
    case 'SLIDE':
      pelvis.position.y = 0.42;
      torso.rotation.x = -0.5;
      leftLeg.shoulder.rotation.x = 1.35; rightLeg.shoulder.rotation.x = 0.3;
      leftLeg.joint.rotation.x = 0.2; rightLeg.joint.rotation.x = 0.9;
      break;
    case 'TACKLE':
      torso.rotation.x = 0.35;
      rightLeg.shoulder.rotation.x = 1.1;
      leftArm.shoulder.rotation.x = -0.8; rightArm.shoulder.rotation.x = -0.8;
      break;
    case 'BROKEN':
      torso.rotation.x = 0.7;
      headGroup.rotation.x = 0.5;
      pelvis.position.y = 0.6;
      leftLeg.shoulder.rotation.x = 0.7; rightLeg.shoulder.rotation.x = -0.4;
      break;
    case 'CELEBRATE':
      leftArm.shoulder.rotation.z = 2.6; rightArm.shoulder.rotation.z = -2.6;
      pelvis.position.y = 0.92 + Math.abs(Math.sin(ph * 2)) * 0.16;
      break;
    case 'KICK': {
      const t = Math.max(0, Math.min(1, 1 - (p.kickTimer ?? 0) / 0.32));
      const swing = Math.sin(t * Math.PI);
      rightLeg.shoulder.rotation.x = -1.5 * swing + 0.4;
      rightLeg.joint.rotation.x = 1.2 * (1 - swing);
      torso.rotation.x = -0.25 * swing;
      leftArm.shoulder.rotation.z = 0.7; rightArm.shoulder.rotation.z = -0.4;
      break;
    }
    default: { // RUN / IDLE
      if (speed > 0.5) {
        const amp = Math.min(1, speed / 6);
        leftLeg.shoulder.rotation.x = Math.sin(ph) * 0.85 * amp;
        rightLeg.shoulder.rotation.x = Math.sin(ph + Math.PI) * 0.85 * amp;
        leftLeg.joint.rotation.x = Math.max(0, -Math.sin(ph + 0.6)) * 1.1 * amp + 0.08;
        rightLeg.joint.rotation.x = Math.max(0, -Math.sin(ph + Math.PI + 0.6)) * 1.1 * amp + 0.08;
        leftArm.shoulder.rotation.x = Math.sin(ph + Math.PI) * 0.7 * amp;
        rightArm.shoulder.rotation.x = Math.sin(ph) * 0.7 * amp;
        leftArm.joint.rotation.x = -0.6 * amp; rightArm.joint.rotation.x = -0.6 * amp;
        torso.rotation.y = Math.sin(ph) * 0.06 * amp;
        pelvis.position.y = 0.92 + Math.abs(Math.sin(ph)) * 0.045 * amp;
      } else {
        const b = Math.sin(ph * 0.5) * 0.02;
        torso.rotation.x = b;
        pelvis.position.y = 0.92 + b * 0.5;
      }
    }
  }

  // head tracks the ball
  if (ballPos) {
    const dx = ballPos.x - rig.root.position.x;
    const dz = ballPos.z - rig.root.position.z;
    const rel = Math.atan2(dz, dx) - rig.root.rotation.y;
    headGroup.rotation.y = Math.max(-0.9, Math.min(0.9, rel));
  }
}

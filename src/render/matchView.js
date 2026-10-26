import * as THREE from 'three';
import { createFootballer } from './rig.js';
import { animateRig } from './rigAnimator.js';

const TEAM_KITS = [
  { kitPrimary: 0x2aa8e0, kitSecondary: 0x0d2b45 },
  { kitPrimary: 0xe8452f, kitSecondary: 0x3a0d0d }
];
const REF_KIT = { kitPrimary: 0x17191e, kitSecondary: 0x0a0b0e, skin: 0xa57352, hair: 0x15100c, boot: 0x08090b };
const CARRY_COLORS = { SHIELD: 0xffc857, CLOSE: 0x53e0ff, 'FACE-UP': 0xc084fc, SPRINT: 0xff8a4d, NORMAL: 0x54f58a };

function ballTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#141821';
  for (let i = 0; i < 12; i++) {
    const x = (i * 67) % 256, y = (i * 113) % 256;
    g.beginPath();
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2 - Math.PI / 2;
      const px = x + Math.cos(a) * 22, py = y + Math.sin(a) * 22;
      k ? g.lineTo(px, py) : g.moveTo(px, py);
    }
    g.closePath(); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function ballShadowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  grad.addColorStop(0, 'rgba(0,0,0,.55)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export class MatchView {
  constructor(sceneView, cfg, ballMeshOverride = null, athleteFactory = null) {
    this.sv = sceneView;
    this.cfg = cfg;
    this.athletes = athleteFactory;
    this.group = new THREE.Group();
    sceneView.scene.add(this.group);
    this.disposables = [];
    const track = (o) => { this.disposables.push(o); return o; };

    if (ballMeshOverride) {
      this.ball = ballMeshOverride;
    } else {
      const bTex = track(ballTexture());
      bTex.anisotropy = 8;
      const bGeo = track(new THREE.SphereGeometry(0.11, 48, 32));
      const bMat = track(new THREE.MeshStandardMaterial({ map: bTex, roughness: 0.34 }));
      this.ball = new THREE.Mesh(bGeo, bMat);
      this.ball.castShadow = true;
    }
    this.group.add(this.ball);
    this.ballAxis = new THREE.Vector3();
    const shadowTex = track(ballShadowTexture());
    const shadowMat = track(new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, opacity: 0.7 }));
    this.ballShadow = new THREE.Mesh(track(new THREE.PlaneGeometry(0.7, 0.7)), shadowMat);
    this.ballShadow.rotation.x = -Math.PI / 2;
    this.ballShadow.position.y = 0.014;
    this.group.add(this.ballShadow);

    const trailGeo = track(new THREE.BufferGeometry());
    this.trailLen = 40;
    trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.trailLen * 3), 3));
    const trailMat = track(new THREE.LineBasicMaterial({ color: 0x8ff0ff, transparent: true, opacity: 0.55 }));
    this.trail = new THREE.Line(trailGeo, trailMat);
    this.trail.frustumCulled = false; // positions mutate in place; never cull (fix E13)
    this.trailPoints = [];
    this.group.add(this.trail);

    const markerGeo = track(new THREE.ConeGeometry(0.2, 0.32, 4));
    const markerMat = track(new THREE.MeshBasicMaterial({
      color: 0x35e06a, transparent: true, opacity: 0.92, depthTest: false, depthWrite: false
    }));
    this.humanMarker = new THREE.Mesh(markerGeo, markerMat);
    this.humanMarker.rotation.x = Math.PI;
    this.humanMarker.renderOrder = 10;
    this.humanMarker.visible = false;
    this.group.add(this.humanMarker);

    // one offside line per team (the original only ever drew team 0's — D10)
    this.offsideLines = [0, 1].map((i) => {
      const geo = track(new THREE.PlaneGeometry(cfg.pitchWidth, 0.16));
      const mat = track(new THREE.MeshBasicMaterial({ color: i === 0 ? 0xffe14d : 0xff8a4d, transparent: true, opacity: 0.75, side: THREE.DoubleSide }));
      const m = new THREE.Mesh(geo, mat);
      m.rotation.x = -Math.PI / 2;
      m.position.y = 0.02;
      m.visible = !!cfg.offside;
      this.group.add(m);
      return m;
    });

    this.rigs = new Map();
    this.referee = this.athletes ? this.athletes.create(REF_KIT) : createFootballer(REF_KIT);
    this.referee.root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = false;
      o.receiveShadow = true;
      if (/eye|brow/i.test(o.name)) o.visible = false;
    });
    this.group.add(this.referee.root);
    this.refPos = new THREE.Vector3(0, 0, 8);
    this.refPlayer = {
      id: 'ref', team: -1, pos: new THREE.Vector3(0, 0, 8), facing: 0, speed: 0,
      animMode: 'IDLE', kickTimer: 0, diveTimer: 0, diveSide: 1, jumpHeight: 0
    };
  }

  syncRigs(snapshot) {
    const seen = new Set();
    for (const p of snapshot.players) {
      seen.add(p.id);
      if (!this.rigs.has(p.id)) {
        const rig = this.athletes
          ? this.athletes.create({ ...TEAM_KITS[p.team] })
          : createFootballer({ ...TEAM_KITS[p.team], skin: 0x8a5a3b });
        this.rigs.set(p.id, rig);
        this.group.add(rig.root);
      }
    }
    for (const [id, rig] of [...this.rigs]) {
      if (!seen.has(id)) { rig.dispose(); this.group.remove(rig.root); this.rigs.delete(id); }
    }
  }

  update(dt, snapshot, localId) {
    this.syncRigs(snapshot);
    const b = snapshot.ball;
    this.ball.position.set(b.x, b.y, b.z);
    this.ball.scale.setScalar(1 + Math.min(0.18, (b.dribblePulse ?? 0) * 0.14));
    const speed = Math.hypot(b.vx, b.vz);
    if (b.y > 0.135) {
      const sx = b.spinX ?? 0, sy = b.spinY ?? 0, sz = b.spinZ ?? 0;
      const spinLen = Math.hypot(sx, sy, sz);
      if (spinLen > 0.05) {
        this.ballAxis.set(sx, sy, sz).normalize();
        this.ball.rotateOnWorldAxis(this.ballAxis, spinLen * dt);
      }
    } else if (speed > 0.05) {
      this.ballAxis.set(b.vz, 0, -b.vx).normalize();
      this.ball.rotateOnWorldAxis(this.ballAxis, speed / 0.11 * dt);
    }
    this.ballShadow.position.set(b.x, 0.014, b.z);
    const shadowScale = 1 / (1 + Math.max(0, b.y - 0.11) * 0.7);
    this.ballShadow.scale.setScalar(shadowScale);
    this.ballShadow.material.opacity = 0.7 * shadowScale;

    this.trailPoints.push(b.x, b.y, b.z);
    if (this.trailPoints.length > this.trailLen * 3) this.trailPoints.splice(0, this.trailPoints.length - this.trailLen * 3);
    const attr = this.trail.geometry.attributes.position;
    const n = this.trailPoints.length / 3;
    for (let i = 0; i < this.trailLen; i++) {
      const j = Math.min(i, n - 1) * 3;
      attr.array[i * 3] = this.trailPoints[j] ?? 0;
      attr.array[i * 3 + 1] = this.trailPoints[j + 1] ?? 0;
      attr.array[i * 3 + 2] = this.trailPoints[j + 2] ?? 0;
    }
    attr.needsUpdate = true;
    this.trail.visible = snapshot.ball.holderId == null && (b.vx * b.vx + b.vz * b.vz) > 25;

    const L = snapshot.cfg.pitchLength, W = snapshot.cfg.pitchWidth;
    const side = b.z >= 0 ? -1 : 1;
    const targetX = THREE.MathUtils.clamp(b.x * 0.55, -L / 2 + 6, L / 2 - 6);
    const targetZ = THREE.MathUtils.clamp(b.z * 0.35 + side * 9.5, -W / 2 + 4, W / 2 - 4);
    const ox = this.refPos.x, oz = this.refPos.z;
    const k = 1 - Math.exp(-3.2 * dt);
    this.refPos.x += (targetX - this.refPos.x) * k;
    this.refPos.z += (targetZ - this.refPos.z) * k;
    const rp = this.refPlayer;
    rp.pos.set(this.refPos.x, 0, this.refPos.z);
    const targetFacing = Math.atan2(b.z - this.refPos.z, b.x - this.refPos.x);
    rp.facing += Math.atan2(Math.sin(targetFacing - rp.facing), Math.cos(targetFacing - rp.facing)) * Math.min(1, dt * 4);
    rp.speed = Math.min(6.5, Math.hypot(this.refPos.x - ox, this.refPos.z - oz) / Math.max(dt, 0.001));
    rp.animMode = rp.speed > 0.45 ? 'RUN' : 'IDLE';
    this.referee.root.position.set(this.refPos.x, 0, this.refPos.z);
    this.referee.root.rotation.y = -rp.facing + (this.referee.manifest?.forwardRotation ?? 0);
    if (this.referee.isAthlete) this.referee.update(dt, rp, this.ball.position);
    else animateRig(this.referee, rp, dt, this.ball.position);

    for (const p of snapshot.players) {
      const rig = this.rigs.get(p.id);
      if (!rig) continue;
      rig.root.position.set(p.x, 0, p.z);
      rig.root.rotation.y = -p.facing + (rig.manifest?.forwardRotation ?? 0);
      const isLocal = p.id === localId;
      rig.ring.visible = isLocal;
      if (isLocal) {
        const pulse = 1 + Math.sin(performance.now() / 220) * 0.08;
        rig.ring.scale.setScalar(pulse);
        rig.ring.material.opacity = 0.72 + Math.sin(performance.now() / 220) * 0.18;
        rig.ring.material.color.setHex(CARRY_COLORS[p.carryMode] ?? CARRY_COLORS.NORMAL);
      }
      if (rig.isAthlete) rig.update(dt, p, this.ball.position);
      else animateRig(rig, p, dt, this.ball.position);
    }
    const local = snapshot.players.find((p) => p.id === localId);
    if (local) {
      this.humanMarker.visible = true;
      this.humanMarker.position.set(local.x, 2.55 + Math.sin(performance.now() / 260) * 0.08, local.z);
      this.humanMarker.rotation.y += dt * 1.2;
    } else {
      this.humanMarker.visible = false;
    }

    if (this.cfg.offside) {
      this.offsideLines[0].position.x = snapshot.offsideLines[0];
      this.offsideLines[1].position.x = snapshot.offsideLines[1];
    }
  }

  clearTrail() { this.trailPoints.length = 0; }

  dispose() {
    this.referee?.dispose();
    this.referee = null;
    for (const rig of this.rigs.values()) rig.dispose();
    this.rigs.clear();
    for (const d of this.disposables) d.dispose?.();
    this.sv.scene.remove(this.group);
    this.group.clear();
  }
}

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { damp } from '../core/math.js';

export const CAMERA_MODES = ['ATTACK', 'FOLLOW', 'WIDE', 'GOAL', 'BROADCAST'];

const GradeShader = {
  uniforms: { tDiffuse: { value: null }, contrast: { value: 1.055 }, saturation: { value: 1.06 }, vignette: { value: 0.16 } },
  vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float contrast,saturation,vignette; varying vec2 vUv;
    void main(){ vec4 c=texture2D(tDiffuse,vUv); c.rgb=(c.rgb-0.5)*contrast+0.5;
      float l=dot(c.rgb,vec3(0.2126,0.7152,0.0722)); c.rgb=mix(vec3(l),c.rgb,saturation);
      vec2 p=(vUv-0.5)*1.3; float v=1.0-smoothstep(0.25,0.9,dot(p,p)); c.rgb*=mix(1.0-vignette,1.0,v);
      gl_FragColor=c; }`
};

function createSky() {
  return new THREE.Mesh(
    new THREE.SphereGeometry(420, 32, 20),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        topColor: { value: new THREE.Color(0x2d66a3) },
        horizonColor: { value: new THREE.Color(0xb8d4e8) },
        sunDir: { value: new THREE.Vector3(0.45, 0.65, 0.35).normalize() }
      },
      vertexShader: 'varying vec3 vDir; void main(){vDir=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
      fragmentShader: `
        varying vec3 vDir; uniform vec3 topColor,horizonColor,sunDir;
        void main(){ vec3 d=normalize(vDir); float h=clamp(d.y*0.5+0.5,0.0,1.0);
          vec3 c=mix(horizonColor,topColor,pow(h,0.72)); float s=max(dot(d,sunDir),0.0);
          c+=vec3(1.0,0.88,0.62)*pow(s,700.0)*3.0+vec3(1.0,0.78,0.45)*pow(s,18.0)*0.12;
          gl_FragColor=vec4(c,1.0); }`
    })
  );
}

function aimMarkerTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.strokeStyle = 'rgba(255,255,255,0.95)';
  g.lineWidth = 5;
  g.beginPath(); g.arc(64, 64, 42, 0, Math.PI * 2); g.stroke();
  g.strokeStyle = 'rgba(140,240,255,0.8)';
  g.lineWidth = 2;
  g.beginPath(); g.arc(64, 64, 30, 0, Math.PI * 2); g.stroke();
  g.fillStyle = 'rgba(255,255,255,0.95)';
  g.beginPath(); g.arc(64, 64, 5, 0, Math.PI * 2); g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class SceneView {
  constructor(container) {
    this.container = container;
    this.quality = 'HIGH';
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.info.autoReset = false;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0xa9c4d8, 150, 390);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 600);
    this.cameraMode = 0;
    this._penaltyAim = null;
    this.onCameraLabel = null;

    this.hemi = new THREE.HemisphereLight(0xbfdcff, 0x405126, 1.0);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff0d8, 3.0);
    this.sun.position.set(42, 68, 34);
    this.sun.castShadow = true;
    this.sun.shadow.camera.left = -58; this.sun.shadow.camera.right = 58;
    this.sun.shadow.camera.top = 58; this.sun.shadow.camera.bottom = -58;
    this.sun.shadow.camera.near = 4; this.sun.shadow.camera.far = 180;
    this.sun.shadow.bias = -0.00035;
    this.sun.shadow.normalBias = 0.025;
    this.scene.add(this.sun, this.sun.target);
    this.fill = new THREE.DirectionalLight(0x9dbdff, 0.75);
    this.fill.position.set(-35, 26, -24);
    this.scene.add(this.fill);
    this.rim = new THREE.DirectionalLight(0xffe4bd, 0.8);
    this.rim.position.set(-22, 30, -38);
    this.scene.add(this.rim);
    this.ambient = new THREE.AmbientLight(0x8090a0, 0.35);
    this.scene.add(this.ambient);

    this.sky = createSky();
    this.scene.add(this.sky);
    this.createEnvironment();

    this.penaltyMarker = new THREE.Sprite(new THREE.SpriteMaterial({
      map: aimMarkerTexture(), color: 0xbdf6ff, transparent: true,
      depthWrite: false, blending: THREE.AdditiveBlending
    }));
    this.penaltyMarker.visible = false;
    this.penaltyMarker.scale.setScalar(0.85);
    this.scene.add(this.penaltyMarker);

    this._desired = new THREE.Vector3(0, 18, 38);
    this._look = new THREE.Vector3();
    this._lookTarget = new THREE.Vector3();
    this._pieceFocus = null;
    this._focusFresh = false;
    this._forceCut = false;
    this.resize();
    this.setQuality(this.quality);
  }

  createEnvironment() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    const sky = createSky();
    envScene.add(sky);
    this.environment = pmrem.fromScene(envScene, 0.04).texture;
    this.scene.environment = this.environment;
    sky.geometry.dispose(); sky.material.dispose(); pmrem.dispose();
  }

  setQuality(tier) {
    this.quality = tier;
    const high = tier === 'HIGH';
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, high ? 1.75 : 1.0));
    const shadowSize = 1024;
    if (this.sun.shadow.mapSize.x !== shadowSize) {
      this.sun.shadow.mapSize.set(shadowSize, shadowSize);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    this.sun.castShadow = high;
    this.renderer.shadowMap.enabled = high;
    this.scene.traverse((o) => {
      if (!o.material) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.needsUpdate = true;
    });
    this.buildComposer();
    this.resize();
    return this.quality;
  }

  buildComposer() {
    if (this.composer) {
      for (const pass of this.composer.passes) pass.dispose?.();
      this.composer.dispose();
    }
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    if (this.quality === 'HIGH') {
      this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.22, 0.25, 0.9);
      this.composer.addPass(this.bloom);
      this.composer.addPass(new ShaderPass(GradeShader));
    }
    this.composer.addPass(new OutputPass());
    this.fxaa = new ShaderPass(FXAAShader);
    this.composer.addPass(this.fxaa);
  }

  resize() {
    const w = this.container.clientWidth || innerWidth;
    const h = this.container.clientHeight || innerHeight;
    this.renderer.setSize(w, h);
    this.composer?.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const ratio = this.renderer.getPixelRatio();
    this.fxaa?.uniforms.resolution.value.set(1 / (w * ratio), 1 / (h * ratio));
  }

  cycleCameraMode() {
    this.cameraMode = (this.cameraMode + 1) % CAMERA_MODES.length;
    this._forceCut = true;
    this.onCameraLabel?.(`CAM ${CAMERA_MODES[this.cameraMode]}`);
    return this.cameraMode;
  }

  // Screen-relative input: the arrows follow the active camera, not fixed world axes.
  movementDirection(moveX, moveZ, team = 0, attackDir = null) {
    if (Math.hypot(moveX, moveZ) < 0.05) return null;
    this.camera.updateMatrixWorld();
    const e = this.camera.matrixWorld.elements;
    let fx = -e[8], fz = -e[10];
    let len = Math.hypot(fx, fz);
    if (len < 0.2) {
      const dir = attackDir ?? (team === 0 ? 1 : -1);
      fx = dir; fz = 0; len = 1;
    }
    fx /= len; fz /= len;
    const rx = -fz, rz = fx;
    let x = fx * moveZ + rx * moveX;
    let z = fz * moveZ + rz * moveX;
    const mag = Math.hypot(x, z);
    if (mag > 1) { x /= mag; z /= mag; }
    return { x, z };
  }

  focusSetPiece(kind, seconds = 2.6, meta = null) {
    this._pieceFocus = { kind, until: performance.now() + seconds * 1000, ...(meta ?? {}) };
    this._focusFresh = true;
    this.onCameraLabel?.(`CAM ${kind}`);
  }

  setPenaltyAim(aim) {
    this._penaltyAim = aim ? { z: aim.z ?? 0, y: aim.y ?? 0.35 } : null;
    this.penaltyMarker.visible = !!this._penaltyAim;
  }

  clearFocus() {
    this._pieceFocus = null;
    this._focusFresh = false;
    this._forceCut = true;
    this._penaltyAim = null;
    this.penaltyMarker.visible = false;
    this.onCameraLabel?.(`CAM ${CAMERA_MODES[this.cameraMode]}`);
  }

  resetLobbyCamera() {
    this._pieceFocus = null;
    this._focusFresh = false;
    this._forceCut = false;
    this.camera.position.set(0, 7.5, 22);
    this._lookTarget.set(0, 1.2, 0);
    this.camera.lookAt(this._lookTarget);
    this.onCameraLabel?.(`CAM ${CAMERA_MODES[this.cameraMode]}`);
  }

  get cameraLabel() {
    return this._pieceFocus ? `CAM ${this._pieceFocus.kind}` : `CAM ${CAMERA_MODES[this.cameraMode]}`;
  }

  screenDirection(from, to) {
    this.camera.updateMatrixWorld();
    const a = new THREE.Vector3(from.x, 0.2, from.z).project(this.camera);
    const b = new THREE.Vector3(to.x, 0.2, to.z).project(this.camera);
    return Math.atan2(b.y - a.y, b.x - a.x);
  }

  safeInField(x, y, z, snap, inset = 4, minY = 5.5) {
    const halfX = snap.cfg.pitchLength / 2 - inset;
    const halfZ = snap.cfg.pitchWidth / 2 - inset;
    return this._desired.set(
      THREE.MathUtils.clamp(x, -halfX, halfX),
      THREE.MathUtils.clamp(y, minY, 26),
      THREE.MathUtils.clamp(z, -halfZ, halfZ)
    );
  }

  updateCamera(dt, snap, localId) {
    const b = snap.ball;
    const local = snap.players.find((p) => p.id === localId);
    const L = snap.cfg.pitchLength, W = snap.cfg.pitchWidth;
    if (this._pieceFocus && performance.now() > this._pieceFocus.until) {
      this._pieceFocus = null;
      this._forceCut = true;
      this.onCameraLabel?.(`CAM ${CAMERA_MODES[this.cameraMode]}`);
    }
    let hardCut = this._forceCut;
    this._forceCut = false;

    if (this._pieceFocus) {
      const goalSide = Math.sign(b.x || 1);
      if (this._pieceFocus.kind === 'CORNER') {
        const side = Math.sign(b.z || 1);
        this.safeInField(b.x - goalSide * 26, 13.5, -side * 18, snap, 4);
        this._look.set(b.x - goalSide * 8, 1.1, side * 14);
      } else if (this._pieceFocus.kind === 'THROWIN') {
        this.safeInField(b.x - goalSide * 9, 7.2, b.z - Math.sign(b.z || 1) * 11, snap, 4);
        this._look.set(b.x, 1.1, b.z);
      } else if (this._pieceFocus.kind === 'CARD') {
        const target = snap.players.find((p) => p.id === this._pieceFocus.playerId) ?? b;
        const side = Math.sign(target.z || 1);
        this.safeInField(target.x - Math.sign(target.x || 1) * 7, 5.4, target.z + side * 5.5, snap, 3);
        this._look.set(target.x, 1.2, target.z);
      } else if (this._pieceFocus.kind === 'PENALTY_KEEPER') {
        const local = snap.players.find((p) => p.id === localId);
        const team = local?.team ?? 0;
        const goalX = snap.goalX?.[team] ?? (team === 0 ? -L / 2 : L / 2);
        const sign = Math.sign(goalX) || 1;
        const toward = -sign;
        this._desired.set(goalX - toward * 7, 7.0, 0.6);
        this._look.set(goalX + toward * 11, 1.1, 0);
      } else if (this._pieceFocus.kind === 'PENALTY') {
        const goalX = (snap.goalX ?? [L / 2, -L / 2]).reduce((best, g) =>
          Math.abs(g - b.x) < Math.abs(best - b.x) ? g : best, snap.goalX?.[0] ?? L / 2);
        const dir = Math.sign(goalX - b.x) || 1;
        const aim = this._penaltyAim ?? { z: 0, y: 0.35 };
        this.safeInField(b.x - dir * 9, 3.6, b.z + aim.z * 2.2, snap, 2, 2.6);
        this._look.set(goalX, 0.5 + aim.y * 1.4, aim.z * (snap.cfg.goalW / 2));
        if (this._penaltyAim) {
          this.penaltyMarker.visible = true;
          this.penaltyMarker.position.set(
            goalX - dir * 0.18,
            0.45 + aim.y * 1.25,
            aim.z * (snap.cfg.goalW / 2 - 0.45)
          );
          this.penaltyMarker.scale.setScalar(0.85 + Math.sin(performance.now() * 0.006) * 0.08);
        }
      } else if (this._pieceFocus.kind === 'FREEKICK') {
        const local = snap.players.find((p) => p.id === localId);
        const team = local?.team ?? 0;
        const attackGoalX = snap.goalX?.[1 - team] ?? (team === 0 ? L / 2 : -L / 2);
        const ownGoalX = snap.goalX?.[team] ?? (team === 0 ? -L / 2 : L / 2);
        const dir = Math.sign(attackGoalX - ownGoalX) || 1;
        const side = Math.sign(b.z || 1);
        this.safeInField(b.x - dir * 7, 4.8, b.z + side * 1.8, snap, 2);
        this._look.set(attackGoalX, 1.15, 0);
      } else if (this._pieceFocus.kind === 'SUBSTITUTION') {
        this.safeInField(b.x * 0.2, 9, W / 2 - 10, snap, 3);
        this._look.set(b.x * 0.2, 1.0, W / 2);
      } else if (this._pieceFocus.kind === 'KICKOFF') {
        this.safeInField(b.x * 0.15, 26, W / 2 - 6, snap, 3);
        this._look.set(b.x * 0.35, 0.4, b.z * 0.35);
      } else {
        this.safeInField(b.x - goalSide * 13, 8.5, b.z - Math.sign(b.z || 1) * 6, snap, 4);
        this._look.set(b.x, 1.1, b.z);
      }
      if (this._focusFresh) { hardCut = true; this._focusFresh = false; }
    } else if (this.cameraMode === 0) {
      const team = local?.team ?? 0;
      const attackGoalX = snap.goalX?.[1 - team] ?? (team === 0 ? 52.5 : -52.5);
      const ownGoalX = snap.goalX?.[team] ?? (team === 0 ? -52.5 : 52.5);
      const attackDir = Math.sign(attackGoalX - ownGoalX) || 1;
      this.safeInField(b.x - attackDir * 17, 9.5, b.z * 0.28, snap, 3);
      this._look.set(b.x + attackDir * 12, 1.2, b.z * 0.35);
    } else if (this.cameraMode === 1 && local) {
      const attackGoalX = snap.goalX?.[1 - local.team] ?? (local.team === 0 ? 52.5 : -52.5);
      const ownGoalX = snap.goalX?.[local.team] ?? (local.team === 0 ? -52.5 : 52.5);
      const attackDir = Math.sign(attackGoalX - ownGoalX) || 1;
      this.safeInField(local.x - attackDir * 7.5, 5.2, local.z, snap, 2);
      this._look.set(local.x + attackDir * 6, 1.15, local.z);
    } else if (this.cameraMode === 2) {
      this.safeInField(b.x * 0.15, Math.min(34, L * 0.38), W / 2 - 6, snap, 5);
      this._look.set(b.x * 0.35, 0, b.z * 0.35);
    } else if (this.cameraMode === 3) {
      const side = b.x >= 0 ? 1 : -1;
      this.safeInField(side * (L / 2 - 7), 8.5, b.z * 0.22, snap, 2);
      this._look.set(b.x, Math.max(0.7, b.y), b.z);
    } else {
      this.safeInField(b.x * 0.72, Math.max(13, W * 0.22), W / 2 - 4, snap, 3);
      this._look.set(b.x * 0.88, 0.9, b.z * 0.45);
    }
    this._desired.y = Math.max(4.2, this._desired.y);
    if (hardCut) {
      this.camera.position.copy(this._desired);
      this._lookTarget.copy(this._look);
    } else {
      const rate = this.cameraMode === 1 ? 6.5 : this.cameraMode === 0 ? 6 : 3.6;
      for (const k of ['x', 'y', 'z']) {
        this.camera.position[k] = damp(this.camera.position[k], this._desired[k], rate, dt);
        this._lookTarget[k] = damp(this._lookTarget[k], this._look[k], rate, dt);
      }
    }
    this.camera.lookAt(this._lookTarget);
  }

  render() {
    this.renderer.info.reset();
    if (this.quality === 'HIGH' && this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }
  getStats() {
    const i = this.renderer.info;
    return { calls: i.render.calls, triangles: i.render.triangles, geometries: i.memory.geometries, textures: i.memory.textures };
  }
  dispose() { this.composer?.dispose(); this.environment?.dispose(); this.renderer.dispose(); this.renderer.domElement.remove(); }
}

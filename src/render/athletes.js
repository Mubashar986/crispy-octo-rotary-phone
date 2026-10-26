import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneRig } from 'three/addons/utils/SkeletonUtils.js';
import { FootPlanting } from './footPlanting.js';
import { loadFootballClips } from './footballClips.js';

const loader = new GLTFLoader();
const normalizeName = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const LOCOMOTION_CLIPS = new Set(['walk', 'jog', 'sprint']);
const CLIP_ALIASES = {
  idle: ['idleloop', 'idle', 'standingidle', 'rest'],
  walk: ['walkloop', 'walkformalloop', 'walk', 'walking', 'walkforward'],
  jog: ['jogfwdloop', 'jog', 'jogging', 'run', 'running', 'runforward'],
  sprint: ['sprintloop', 'sprint', 'runningfast', 'fastrun'],
  kick: ['kick', 'kicking', 'soccerkick', 'pass', 'shot', 'shoot', 'strike'],
  slide: ['slide', 'sliding', 'tackle', 'slidetackle'],
  dive: ['dive', 'goalkeeperdive', 'gkdive', 'save'],
  celebrate: ['celebrate', 'celebration', 'cheer', 'victory', 'danceloop'],
  stunned: ['stunned', 'hithead', 'hitchest', 'hit', 'fall', 'falling', 'injured', 'death01'],
  throwin: ['throwin', 'throw'],
  turnL: ['turnleft', 'turnl', 'turn_left', 'turningleft'],
  turnR: ['turnright', 'turnr', 'turn_right', 'turningright'],
  strafeL: ['strafeleft', 'strafel', 'sideleft', 'shuffleleft'],
  strafeR: ['straferight', 'strafer', 'sideright', 'shuffleright'],
  start: ['startrun', 'runstart', 'startwalk', 'walkstart', 'start'],
  stop: ['stoprun', 'runstop', 'stopwalk', 'walkstop', 'stop'],
  pass: ['soccerpass', 'shortpass', 'pass'],
  shot: ['soccershot', 'shot', 'shoot', 'soccerkick'],
  header: ['soccerheader', 'header'],
  gkCatch: ['goalkeepercatch', 'gkcatch', 'catch'],
  gkThrow: ['goalkeeperthrow', 'gkthrow', 'overarmthrow'],
  gkRoll: ['goalkeeperroll', 'gkroll', 'underarmroll'],
  gkPunt: ['goalkeeperpunt', 'gkpunt', 'dropkick']
};

export function findClip(clips, kind) {
  const aliases = CLIP_ALIASES[kind] ?? [kind];
  for (const alias of aliases) {
    const exact = clips.find((c) => normalizeName(c.name) === alias);
    if (exact) return exact;
  }
  for (const alias of aliases) {
    const prefixed = clips.find((c) => normalizeName(c.name).startsWith(alias));
    if (prefixed) return prefixed;
  }
  return null;
}

let blobShadowTexture;
function getBlobShadowTexture() {
  if (blobShadowTexture) return blobShadowTexture;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 3, 32, 32, 31);
  grad.addColorStop(0, 'rgba(0,0,0,.62)');
  grad.addColorStop(0.55, 'rgba(0,0,0,.26)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  blobShadowTexture = new THREE.CanvasTexture(c);
  return blobShadowTexture;
}

export async function loadAthleteLibrary(manifestUrl = '/assets/athletes/manifest.json') {
  try {
    const manifest = await fetch(manifestUrl).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
    const base = manifestUrl.slice(0, manifestUrl.lastIndexOf('/') + 1);
    const gltf = await loader.loadAsync(base + manifest.model);
    const clips = [...gltf.animations];
    for (const path of manifest.animations ?? []) {
      const extra = await loader.loadAsync(base + path);
      clips.push(...extra.animations);
    }
    const model = gltf.scene;
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const scale = (manifest.heightMeters ?? 1.82) / Math.max(0.01, size.y);
    const clipsByKind = {};
    for (const kind of Object.keys(CLIP_ALIASES)) {
      const clip = findClip(clips, kind);
      if (clip) clipsByKind[kind] = clip;
    }
    let football = null;
    const skipFootball = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('nofootball');
    try {
      if (!skipFootball) football = await loadFootballClips(gltf.scene);
      for (const [kind, clip] of Object.entries(football.clipsByKind)) clipsByKind[kind] = clip;
    } catch (error) {
      console.warn('[athletes] football mocap unavailable:', error.message);
    }
    return {
      model, clips, clipsByKind, scale, manifest, sourceBox: box,
      football: football?.meta ?? {}, footballVariants: football?.variants ?? {}
    };
  } catch (error) {
    console.warn('[athletes] no glTF athlete library yet:', error.message);
    return null;
  }
}

export class AthleteFactory {
  constructor(library) { this.library = library; }

  applyKit(o, spec) {
    const source = Array.isArray(o.material) ? o.material[0] : o.material;
    o.geometry = o.geometry.clone();
    o.userData.ownedGeometry = true;
    o.geometry.computeBoundingBox();
    const box = o.geometry.boundingBox;
    const height = Math.max(0.01, box.max.y - box.min.y);
    const pos = o.geometry.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const primary = new THREE.Color(spec.kitPrimary ?? 0x2aa8e0);
    const secondary = new THREE.Color(spec.kitSecondary ?? 0x14283c);
    const socks = primary.clone().multiplyScalar(0.72);
    const boots = new THREE.Color(0x161b22);
    const skin = new THREE.Color(spec.skin ?? 0x9c6b4c);
    const hair = new THREE.Color(spec.hair ?? 0x211711);
    const out = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const h = (pos.getY(i) - box.min.y) / height;
      const ax = Math.abs(pos.getX(i));
      if (h > 0.955) out.copy(hair);
      else if (h > 0.82) out.copy(skin);
      else if (ax > 0.62 && h > 0.52) out.copy(skin);
      else if (h < 0.075) out.copy(boots);
      else if (h < 0.23) out.copy(socks);
      else if (h < 0.45) out.copy(secondary);
      else out.copy(primary);
      colors[i * 3] = out.r; colors[i * 3 + 1] = out.g; colors[i * 3 + 2] = out.b;
    }
    o.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    o.material = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.78, metalness: 0,
      normalMap: source.normalMap ?? null, normalScale: new THREE.Vector2(0.65, 0.65),
      envMapIntensity: 0.75
    });
  }

  create(spec) {
    const { model, scale, clipsByKind, manifest } = this.library;
    const pivot = cloneRig(model);
    pivot.scale.setScalar(scale * (spec.scale ?? 1));
    pivot.traverse((o) => {
      if (!o.isMesh && !o.isSkinnedMesh) return;
      o.castShadow = true; o.receiveShadow = true;
      o.frustumCulled = false;
      if (manifest.bodyMesh && normalizeName(o.name) === normalizeName(manifest.bodyMesh)) {
        this.applyKit(o, spec);
        return;
      }
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      o.material = mats.map((m) => {
        const copy = m.clone();
        const key = normalizeName(`${o.name} ${copy.name}`);
        if (/jersey|shirt|kit|top|uniform/.test(key)) copy.color.set(spec.kitPrimary ?? 0x2aa8e0);
        if (/shorts|pants/.test(key)) copy.color.set(spec.kitSecondary ?? 0x14283c);
        if (/boot|shoe/.test(key)) copy.color.set(spec.boot ?? 0x15191f);
        copy.envMapIntensity = 0.75;
        return copy;
      });
      if (o.material.length === 1) o.material = o.material[0];
    });
    const root = new THREE.Group();
    root.add(pivot);
    const box = new THREE.Box3().setFromObject(pivot);
    pivot.position.y -= box.min.y;

    const mixer = new THREE.AnimationMixer(pivot);
    const actions = {};
    for (const [kind, clip] of Object.entries(clipsByKind)) actions[kind] = mixer.clipAction(clip);
    const rig = new AthleteInstance(root, pivot, mixer, actions, manifest, this.library.football ?? null);
    root.userData.rig = rig;
    return rig;
  }
}

export class AthleteInstance {
  constructor(root, pivot, mixer, actions, manifest, football = null) {
    this.root = root; this.pivot = pivot; this.mixer = mixer; this.actions = actions; this.manifest = manifest;
    this.football = football;
    this.actionKind = null;
    this.actionSeq = -1;
    this.actionRemaining = 0;
    this.isAthlete = true;
    this.current = null;
    this.oneShot = false;
    // Unscaled, outside the mixer: body motion must not lift the turf markers.
    this.bodyOffset = new THREE.Group();
    root.add(this.bodyOffset);
    this.bodyOffset.add(pivot);
    this.ring = this.makeRing();
    root.add(this.ring);
    this.contactShadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1.05, 1.05),
      new THREE.MeshBasicMaterial({ map: getBlobShadowTexture(), transparent: true, depthWrite: false, opacity: 0.72 })
    );
    this.contactShadow.rotation.x = -Math.PI / 2;
    this.contactShadow.position.y = 0.012;
    root.add(this.contactShadow);
    this.bones = {};
    this.overlayBones = new Map();
    pivot.traverse((o) => {
      if (!o.isBone) return;
      this.bones[o.name] = o;
      this.overlayBones.set(o.name, { bone: o, base: o.quaternion.clone(), applied: false });
    });
    this.footPlanting = new FootPlanting(root, this.bones);
    this.poseTarget = new THREE.Vector3();
    this.poseAxis = new THREE.Vector3();
    this.poseRotation = new THREE.Quaternion();
    this.onFinished = ({ action }) => {
      // Keep the clamped action selected until the snapshot changes channels.
      if (action === this.current) this.oneShot = false;
    };
    mixer.addEventListener('finished', this.onFinished);
  }

  makeRing() {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.42, 0.54, 32),
      new THREE.MeshBasicMaterial({ color: 0x54f58a, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.025; ring.visible = false;
    return ring;
  }

  play(kind, fade = 0.16, once = false, timeScale = 1) {
    const clipAction = this.actions[kind];
    const locomotion = kind === 'walk' || kind === 'jog' || kind === 'sprint';
    // Missing football clips are procedural poses over idle, never a jogging dive.
    const next = clipAction ?? (locomotion ? this.actions.jog : null) ?? this.actions.idle;
    once = once && !!clipAction;
    if (!clipAction && !locomotion) timeScale = 1;
    if (!next) {
      this.mixer.stopAllAction();
      this.current = null;
      this.oneShot = false;
      return;
    }
    const loop = once ? THREE.LoopOnce : THREE.LoopRepeat;
    if (this.current === next && next.loop === loop) { next.timeScale = timeScale; return; }
    const previous = this.current;
    const previousKind = this.currentKind;
    next.reset();
    next.setLoop(loop, once ? 1 : Infinity);
    next.clampWhenFinished = once;
    next.timeScale = timeScale;
    // Keep the gait phase across walk/jog/sprint so the feet do not pop.
    if (previous && previous !== next && !once && previous.loop === THREE.LoopRepeat &&
      LOCOMOTION_CLIPS.has(previousKind) && LOCOMOTION_CLIPS.has(kind)) {
      const prevClip = previous.getClip();
      const nextClip = next.getClip();
      if (prevClip?.duration > 0 && nextClip?.duration > 0) {
        next.time = (previous.time / prevClip.duration) * nextClip.duration;
      }
    }
    if (previous && previous !== next) {
      previous.crossFadeTo(next, fade, false);
      next.play();
    } else next.fadeIn(fade).play();
    this.current = next;
    this.currentKind = kind;
    this.oneShot = once;
  }

  playAction(kind, immediate = false, timeScale = 1) {
    const action = this.actions[kind];
    if (!action) return false;
    const meta = this.football?.[kind] ?? null;
    if (this.current === action) {
      action.reset();
      action.play();
    } else {
      this.play(kind, 0.07, true, timeScale);
    }
    if (immediate && meta?.startAtOffset != null) {
      action.time = Math.max(0, Math.min(meta.startAtOffset, action.getClip().duration - 0.02));
    }
    const duration = action.getClip().duration;
    const remaining = immediate && meta?.startAtOffset != null
      ? Math.max(0.2, duration - meta.startAtOffset)
      : (meta?.contactOffset != null ? Math.min(duration, meta.contactOffset + 0.42) : duration);
    this.actionRemaining = Math.max(0.15, remaining);
    this.actionKind = kind;
    return true;
  }

  resetFootballAction() {
    for (const state of this.overlayBones.values()) {
      if (!state.applied) continue;
      state.bone.quaternion.copy(state.base);
      state.applied = false;
    }
    this.bodyOffset.position.y = 0;
  }

  overlayBone(name) {
    const state = this.overlayBones.get(name);
    if (!state) return null;
    if (!state.applied) state.base.copy(state.bone.quaternion);
    state.applied = true;
    return state.bone;
  }

  aimArm(name, childName, x, y, z) {
    const child = this.bones[childName];
    if (!child || child.position.lengthSq() === 0) return;
    const bone = this.overlayBone(name);
    if (!bone || child.parent !== bone) return;
    // Aim in body space, independent of the imported rig's local bone axes.
    this.poseTarget.set(x, y, z);
    this.bodyOffset.localToWorld(this.poseTarget);
    bone.parent.worldToLocal(this.poseTarget);
    this.poseTarget.sub(bone.position).normalize();
    this.poseAxis.copy(child.position).multiply(bone.scale).normalize().applyQuaternion(bone.quaternion);
    this.poseRotation.setFromUnitVectors(this.poseAxis, this.poseTarget);
    bone.quaternion.premultiply(this.poseRotation);
  }

  poseGoalkeeper(hold) {
    // Fixed procedural arm targets, not a captured goalkeeper clip. The held
    // ball is at y=1.08, +Z=0.42 in the model's forward-facing body space.
    for (const [side, sign] of [['l', 1], ['r', -1]]) {
      this.aimArm(`upperarm_${side}`, `lowerarm_${side}`, sign * (hold ? 0.28 : 0.38), 1.14, 0.13);
      this.aimArm(`lowerarm_${side}`, `hand_${side}`, sign * (hold ? 0.11 : 0.38), 1.08, hold ? 0.42 : 0.3);
    }
  }

  applyFootballAction(p) {
    const real = this.actionKind && this.actions[this.actionKind] ? this.actionKind : null;
    const rot = (name, x = 0, y = 0, z = 0) => {
      const bone = this.overlayBone(name);
      if (bone) { bone.rotation.x += x; bone.rotation.y += y; bone.rotation.z += z; }
    };
    if (p.shielded) {
      const side = (p.shieldSide ?? 1) >= 0 ? 1 : -1;
      const arm = side > 0 ? 'l' : 'r';
      rot('pelvis', 0, 0.25 * side, 0);
      rot('spine_01', 0.06, 0.32 * side, 0.14 * side);
      rot(`upperarm_${arm}`, 0, 0, side * 0.7);
      rot(`lowerarm_${arm}`, -0.35);
    }
    const jostle = Math.min(1, p.jostle ?? 0);
    if (jostle > 0.02) {
      const side = (p.shieldSide ?? 1) >= 0 ? 1 : -1;
      rot('spine_01', 0.1 * jostle, 0, 0.22 * jostle * side);
      rot('pelvis', 0, 0, 0.1 * jostle * side);
    }
    if (p.animMode === 'KICK' && p.kickTimer > 0 && !real) {
      const t = Math.max(0, Math.min(1, 1 - p.kickTimer / 0.32));
      const swing = Math.sin(t * Math.PI);
      const contact = Math.sin(Math.min(1, t * 1.45) * Math.PI);
      rot('thigh_r', -1.05 * swing + 0.2 * contact, 0, -0.08 * swing);
      rot('calf_r', 1.05 * (1 - swing) - 0.25 * contact);
      rot('foot_r', -0.35 * contact);
      rot('thigh_l', 0.2 * swing);
      rot('spine_01', -0.12 * swing, -0.18 * swing, 0.08 * swing);
      rot('upperarm_l', 0, 0, 0.45 * swing);
      rot('upperarm_r', 0, 0, -0.25 * swing);
    }
    if (p.animMode === 'SLIDE') {
      this.bodyOffset.position.y = -0.42;
      rot('pelvis', 0.15, 0, 0.85);
      rot('thigh_r', -1.1, 0, -0.25);
      rot('calf_r', 0.35);
      rot('thigh_l', 0.45, 0, 0.4);
      rot('upperarm_l', 0, 0, 0.65);
    } else if (p.animMode === 'DIVE') {
      if (real === 'dive') return;
      this.bodyOffset.position.y = -0.32;
      rot('pelvis', 0, 0, 1.1 * (p.diveSide ?? 1));
      rot('upperarm_l', 0, 0, 1.25);
      rot('upperarm_r', 0, 0, -1.25);
    } else if (p.animMode === 'BROKEN') {
      this.bodyOffset.position.y = -0.22;
      rot('pelvis', 0.45);
      rot('Head', 0.35);
    } else if (p.animMode === 'CELEBRATE') {
      if (real === 'celebrate') return;
      rot('upperarm_l', 0, 0, 1.75);
      rot('upperarm_r', 0, 0, -1.75);
      rot('lowerarm_l', -0.45);
      rot('lowerarm_r', -0.45);
    } else if (p.animMode === 'FEINT') {
      const side = p.diveSide ?? 1;
      const roll = p.skillKind === 'roll';
      rot('pelvis', 0.08, (roll ? 0.42 : 0.25) * side, (roll ? 0.5 : 0.32) * side);
      rot('thigh_l', -0.45);
      rot('thigh_r', 0.35);
      rot('upperarm_l', 0, 0, 0.45 + (roll ? 0.35 : 0));
      rot('spine_01', 0, (roll ? 0.3 : 0.18) * side, (roll ? 0.2 : 0.1) * side);
    } else if (p.animMode === 'THROW') {
      if (real === 'throwin') return;
      this.bodyOffset.position.y = 0.06;
      rot('upperarm_l', 0, 0, 2.55);
      rot('upperarm_r', 0, 0, -2.55);
      rot('lowerarm_l', -0.45);
      rot('lowerarm_r', -0.45);
      rot('spine_01', -0.2);
      rot('Head', -0.2);
      rot('thigh_l', -0.12);
      rot('thigh_r', -0.08);
    } else if (p.animMode === 'HEADER') {
      this.bodyOffset.position.y = p.jumpHeight ? Math.max(0.18, p.jumpHeight * 0.95) : 0.28;
      rot('pelvis', -0.18);
      rot('Head', 0.38);
      rot('thigh_l', -0.35);
      rot('thigh_r', -0.35);
      rot('calf_l', 0.55);
      rot('calf_r', 0.55);
    } else if (p.animMode === 'GK_HOLD' || p.animMode === 'GK_READY') {
      if (p.animMode === 'GK_READY') {
        this.bodyOffset.position.y = -0.06;
        rot('thigh_l', -0.12);
        rot('thigh_r', -0.12);
        rot('calf_l', 0.2);
        rot('calf_r', 0.2);
      }
      this.poseGoalkeeper(p.animMode === 'GK_HOLD');
    }
  }

  update(dt, p, ballPos) {
    // Restore before activating actions as well as sampling: new mixer bindings
    // must never capture the previous procedural pose as their original state.
    this.resetFootballAction();
    this.footPlanting.restore();
    const speed = p.speed ?? 0;
    if (p.animMode === 'GK_HOLD' || p.animMode === 'BROKEN' || p.animMode === 'SLIDE' ||
      p.animMode === 'HEADER' || p.animMode === 'FEINT') {
      this.actionKind = null;
      this.actionRemaining = 0;
    }
    let action = null;
    if (p.animMode === 'KICK' && p.kickTimer > 0 && p.role !== 'GK') {
      action = p.kickKind === 'shot' ? 'shot'
        : p.kickKind === 'penalty' ? 'penalty'
          : p.kickKind === 'pass' ? 'pass'
            : (this.actions.pass ? 'pass' : 'kick');
      if (!this.actions[action]) action = this.actions.kick ? 'kick' : null;
    } else if (p.animMode === 'DIVE') action = 'dive';
    else if (p.animMode === 'THROW' && p.role !== 'GK') action = 'throwin';
    else if (p.animMode === 'CELEBRATE') action = 'celebrate';
    else if (p.animMode === 'TACKLE') action = 'tackle';

    const seq = p.actionSeq ?? 0;
    if (action && this.actions[action] && (action !== this.actionKind || seq !== this.actionSeq)) {
      this.playAction(action, !!p.actionImmediate, action === 'kick' ? 1.15 : 1);
      this.actionSeq = seq;
    }

    if (this.actionKind && this.actionRemaining > 0) {
      // The mocap action owns the body until its contact/follow-through window ends.
    } else if (p.animMode === 'SLIDE') this.play('slide', 0.09, true);
    else if (p.animMode === 'BROKEN') this.play('stunned', 0.12, true);
    else if (p.animMode === 'KICK' && p.kickTimer > 0) this.play('kick', 0.07, true, 1.15);
    else if (p.animMode === 'DIVE') this.play('dive', 0.08, true);
    else if (p.animMode === 'CELEBRATE') this.play('celebrate', 0.15);
    else if (p.animMode === 'THROW') this.play('idle', 0.08);
    else if (p.animMode === 'HEADER' || p.animMode === 'FEINT' || p.animMode === 'GK_HOLD' || p.animMode === 'GK_READY') this.play('idle', 0.08);
    else {
      if (this.actionKind) this.actionKind = null;
      const loco = p.locoState ??
        (speed < 0.35 ? 'IDLE' : speed < 2.4 ? 'WALK' : speed < 5.7 ? 'RUN' : 'SPRINT');
      if (loco === 'TURN' && speed < 1.3 && this.actions.turnL && this.actions.turnR) {
        this.play((p.strafeSign ?? 0) < 0 ? 'turnL' : 'turnR', 0.14);
      } else if ((loco === 'STRAFE' || p.strafeSign) && speed > 0.4 &&
        (this.actions.strafeL || this.actions.strafeR)) {
        this.play((p.strafeSign ?? 0) > 0 ? 'strafeR' : 'strafeL', 0.14, false,
          Math.max(0.7, Math.min(1.3, speed / 3.2)));
      } else if (loco === 'IDLE' || ((loco === 'STOP' || loco === 'TURN' || loco === 'START') && speed < 0.35)) {
        this.play('idle', 0.2);
      } else if (loco === 'SPRINT') {
        this.play('sprint', 0.13, false, Math.max(0.8, Math.min(1.3, speed / 7.4)));
      } else if (loco === 'RUN' || (loco !== 'WALK' && speed >= 2.4)) {
        this.play('jog', 0.16, false, Math.max(0.75, Math.min(1.3, speed / 5.2)));
      } else {
        this.play('walk', 0.18, false, Math.max(0.7, Math.min(1.3, speed / 2.2)));
      }
      // Distance-driven phase lock: the authored contact at phase 0 stays on
      // the engine's contact window instead of drifting against ground travel.
      if ((this.currentKind === 'walk' || this.currentKind === 'jog' || this.currentKind === 'sprint') &&
        Number.isFinite(p.locoPhase)) {
        const duration = this.current?.getClip()?.duration ?? 0;
        if (duration > 0) {
          this.current.time = (((p.locoPhase % 1) + 1) % 1) * duration;
          this.current.timeScale = 0;
        }
      }
    }
    this.mixer.update(dt);
    this.footPlanting.update(dt, p);
    this.applyFootballAction(p);
    if (this.actionRemaining > 0) this.actionRemaining = Math.max(0, this.actionRemaining - dt);
    this.ring.position.y = 0.025;
    void ballPos;
  }

  dispose() {
    this.resetFootballAction();
    this.footPlanting.reset();
    this.mixer.removeEventListener('finished', this.onFinished);
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.pivot);
    const skeletons = new Set();
    this.pivot.traverse((o) => {
      if (o.skeleton) skeletons.add(o.skeleton);
      if (o.userData.ownedGeometry) o.geometry.dispose();
      if (o.material) for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
    });
    for (const skeleton of skeletons) skeleton.dispose();
    this.ring.geometry.dispose(); this.ring.material.dispose();
    this.contactShadow.geometry.dispose(); this.contactShadow.material.dispose();
    this.actions = {};
    this.current = null;
    this.oneShot = false;
    this.overlayBones.clear();
    this.bones = {};
    delete this.root.userData.rig;
    this.bodyOffset.clear();
    this.root.clear();
  }
}

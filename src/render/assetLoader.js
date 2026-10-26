import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';

const objLoader = new OBJLoader();
const texLoader = new THREE.TextureLoader();

// Extracted Unity ball: unit-diameter UV sphere + BallTex. Scaled to match the
// simulation's BALL_RADIUS. Falls back to null so callers keep a procedural ball.
export async function loadBallMesh(radius = 0.11) {
  try {
    const [objText, tex] = await Promise.all([
      fetch('/assets/meshes/ball_hi.obj')
        .then((r) => { if (!r.ok) throw new Error(r.status); return r.text(); })
        .catch(() => fetch('/assets/meshes/ball.obj').then((r) => { if (!r.ok) throw new Error(r.status); return r.text(); })),
      texLoader.loadAsync('/assets/textures/BallTex.png')
    ]);
    const group = objLoader.parse(objText);
    const mesh = group.children.find((c) => c.isMesh) ?? group;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    mesh.material = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.34, metalness: 0 });
    mesh.scale.setScalar(radius * 2); // OBJ is unit diameter
    mesh.castShadow = true;
    // wrap in a group so callers can transform without touching the baked scale
    const wrap = new THREE.Group();
    wrap.add(mesh);
    return wrap;
  } catch {
    return null;
  }
}

const AUDIO_MAP = {
  PlayerPass: 'PlayerPass1', PlayerShoot: 'PlayerShoot1', Goal: 'Goal1',
  Whistle: 'RefereeShortWhistle', FirstWhistle: 'RefereeShortWhistle', FinalWhistle: 'RefereeShortWhistle',
  PlayerTackled: 'PlayerSlideTackle1', PlayerSlideTackle: 'PlayerSlideTackle1',
  KeeperSavesTheBall: 'GoalKeeperHoldTheBall1', PlayerCross: 'PlayerCross',
  BallHitNet: 'BallHitTheGoalNet1', BallHitWoodwork: 'BallHitTheWoodWork1'
};

// Decodes the extracted REAL_AUDIO wavs into the SoundEngine; synth remains as fallback.
export async function loadAudioBuffers(sfx) {
  const ctx = await new Promise((res) => { sfx.init(); res(sfx.ctx); });
  if (!ctx) return 0;
  const entries = await Promise.all(Object.entries(AUDIO_MAP).map(async ([event, file]) => {
    try {
      const buf = await fetch(`/assets/audio/${file}.wav`).then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); });
      return [event, await ctx.decodeAudioData(buf)];
    } catch { return null; }
  }));
  const map = {};
  let n = 0;
  for (const e of entries) if (e) { map[e[0]] = e[1]; n++; }
  sfx.setBuffers(map);
  return n;
}

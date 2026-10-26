import * as THREE from 'three';

function canvasTexture(width, height, draw, srgb = true) {
  const c = document.createElement('canvas'); c.width = width; c.height = height;
  draw(c.getContext('2d'), width, height);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function noiseNormal(size = 256) {
  return canvasTexture(size, size, (g, w, h) => {
    const im = g.createImageData(w, h), heights = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      heights[y * w + x] = Math.sin(x * 0.31) * Math.cos(y * 0.27) + Math.sin(x * 0.07 + y * 0.11) * 0.6 + Math.random() * 0.35;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const dx = heights[y * w + ((x - 1 + w) % w)] - heights[y * w + ((x + 1) % w)];
      const dy = heights[((y - 1 + h) % h) * w + x] - heights[((y + 1) % h) * w + x];
      im.data[i] = 128 + dx * 38; im.data[i + 1] = 128 + dy * 38; im.data[i + 2] = 220; im.data[i + 3] = 255;
    }
    g.putImageData(im, 0, 0);
  }, false);
}

function turfTexture(halfX, halfZ, markings = {}) {
  const boxDepth = markings.boxDepth ?? 16.5;
  const boxWidth = markings.boxWidth ?? 40.32;
  const gaDepth = markings.goalAreaDepth ?? 5.5;
  const gaWidth = markings.goalAreaWidth ?? 18.32;
  const spot = markings.penaltySpot ?? 11;
  const circle = markings.circle ?? 9.15;
  const cornerArc = markings.cornerArc ?? 1;
  const S = 2048;
  return canvasTexture(S, S, (g) => {
    const px = (x) => ((x + halfX) / (2 * halfX)) * S;
    const pz = (z) => ((z + halfZ) / (2 * halfZ)) * S;
    const stripes = 16;
    for (let i = 0; i < stripes; i++) {
      g.fillStyle = i % 2 ? '#326f3d' : '#2c6738';
      g.fillRect(i * S / stripes, 0, S / stripes + 1, S);
    }
    for (let i = 0; i < 65000; i++) {
      const x = Math.random() * S, y = Math.random() * S;
      g.fillStyle = Math.random() > 0.5 ? 'rgba(220,240,190,.035)' : 'rgba(0,30,0,.045)';
      g.fillRect(x, y, 1 + Math.random() * 2, 1 + Math.random() * 3);
    }
    const worn = (x, z, r) => {
      const gr = g.createRadialGradient(px(x), pz(z), 0, px(x), pz(z), r);
      gr.addColorStop(0, 'rgba(128,125,65,.16)'); gr.addColorStop(1, 'rgba(128,125,65,0)');
      g.fillStyle = gr; g.fillRect(px(x) - r, pz(z) - r, r * 2, r * 2);
    };
    worn(0, 0, 100); worn(-halfX + 4, 0, 130); worn(halfX - 4, 0, 130);
    const lw = S * 0.0032;
    g.strokeStyle = '#eef3e8'; g.fillStyle = '#eef3e8'; g.lineWidth = lw;
    g.strokeRect(px(-halfX), pz(-halfZ), px(halfX) - px(-halfX), pz(halfZ) - pz(-halfZ));
    g.beginPath(); g.moveTo(px(0), pz(-halfZ)); g.lineTo(px(0), pz(halfZ)); g.stroke();
    g.beginPath(); g.arc(px(0), pz(0), circle / (2 * halfX) * S, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(px(0), pz(0), lw, 0, Math.PI * 2); g.fill();
    for (const s of [-1, 1]) {
      const gx = s * halfX;
      const rect = (depth, width) => {
        const x0 = px(gx), x1 = px(gx - s * depth);
        g.strokeRect(Math.min(x0, x1), pz(-width / 2), Math.abs(x1 - x0), pz(width / 2) - pz(-width / 2));
      };
      rect(boxDepth, boxWidth); rect(gaDepth, gaWidth);
      g.beginPath(); g.arc(px(gx - s * spot), pz(0), lw, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.arc(px(gx - s * spot), pz(0), circle / (2 * halfX) * S,
        s === 1 ? Math.PI * 0.63 : -Math.PI * 0.37, s === 1 ? Math.PI * 1.37 : Math.PI * 0.37); g.stroke();
      for (const zs of [-1, 1]) {
        g.beginPath(); g.arc(px(gx), pz(zs * halfZ), cornerArc / (2 * halfX) * S, 0, Math.PI * 2); g.stroke();
      }
    }
  });
}

function boardTexture(text, color) {
  return canvasTexture(1024, 96, (g, w, h) => {
    g.fillStyle = '#081326'; g.fillRect(0, 0, w, h);
    g.fillStyle = color; g.fillRect(0, 0, w, 5); g.fillRect(0, h - 5, w, 5);
    g.font = '700 32px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let x = 256; x < w + 256; x += 512) { g.fillStyle = '#e6f5ff'; g.fillText(text, x, h / 2); }
  });
}

function netTexture() {
  const t = canvasTexture(128, 128, (g, w, h) => {
    g.clearRect(0, 0, w, h); g.strokeStyle = 'rgba(245,250,255,.88)'; g.lineWidth = 2;
    for (let i = 0; i <= w; i += 16) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, h); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(w, i); g.stroke(); }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

export function buildStadium(cfg) {
  const group = new THREE.Group();
  const halfX = cfg.pitchLength / 2, halfZ = cfg.pitchWidth / 2;
  const disposables = new Set();
  const mat = (params) => { const m = new THREE.MeshStandardMaterial(params); disposables.add(m); return m; };
  const mesh = (geo, material, parent = group) => {
    disposables.add(geo);
    const m = new THREE.Mesh(geo, material);
    m.castShadow = false;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  const concrete = mat({ color: 0x56616c, roughness: 0.94 });
  const darkConcrete = mat({ color: 0x283442, roughness: 0.92 });
  const metal = mat({ color: 0xd9e0e5, metalness: 0.72, roughness: 0.32 });
  const seatMats = [0x173d68, 0x1e5b85, 0x263f58].map((c) => mat({ color: c, roughness: 0.8 }));

  const apron = mesh(new THREE.PlaneGeometry(cfg.pitchLength + 44, cfg.pitchWidth + 44), mat({ color: 0x283b32, roughness: 1 }));
  apron.rotation.x = -Math.PI / 2; apron.position.y = -0.025;
  const grassMap = turfTexture(halfX, halfZ, cfg.markings); disposables.add(grassMap);
  const normal = noiseNormal(); normal.wrapS = normal.wrapT = THREE.RepeatWrapping; normal.repeat.set(42, 32); disposables.add(normal);
  const turfMat = mat({ map: grassMap, normalMap: normal, normalScale: new THREE.Vector2(0.55, 0.55), roughness: 0.93 });
  const turf = mesh(new THREE.PlaneGeometry(cfg.pitchLength, cfg.pitchWidth), turfMat);
  turf.rotation.x = -Math.PI / 2;

  const netMap = netTexture();
  netMap.repeat.set(14, 9);
  netMap.needsUpdate = true;
  disposables.add(netMap);
  const netMat = mat({ map: netMap, color: 0xd7e0e8, transparent: true, opacity: 0.55, side: THREE.DoubleSide, roughness: 0.95, alphaTest: 0.08, depthWrite: false });
  const goalDepth = 1.8;
  for (const s of [-1, 1]) {
    const goal = new THREE.Group(); goal.position.x = s * halfX; group.add(goal);
    const postGeo = new THREE.CylinderGeometry(0.065, 0.065, cfg.goalH, 12); disposables.add(postGeo);
    for (const zs of [-1, 1]) {
      const p = mesh(postGeo, metal, goal); p.position.set(0, cfg.goalH / 2, zs * cfg.goalW / 2);
      const back = mesh(postGeo, metal, goal); back.position.set(s * goalDepth, cfg.goalH * 0.42, zs * cfg.goalW / 2); back.scale.y = 0.84;
      const support = mesh(new THREE.CylinderGeometry(0.035, 0.035, goalDepth, 8), metal, goal);
      support.rotation.z = Math.PI / 2; support.position.set(s * goalDepth / 2, cfg.goalH, zs * cfg.goalW / 2);
    }
    const bar = mesh(new THREE.CylinderGeometry(0.065, 0.065, cfg.goalW, 12), metal, goal);
    bar.rotation.x = Math.PI / 2; bar.position.y = cfg.goalH;
    const backBar = mesh(new THREE.CylinderGeometry(0.04, 0.04, cfg.goalW, 8), metal, goal);
    backBar.rotation.x = Math.PI / 2; backBar.position.set(s * goalDepth, cfg.goalH * 0.84, 0);
    const backNet = mesh(new THREE.PlaneGeometry(cfg.goalW, cfg.goalH), netMat, goal);
    backNet.rotation.y = Math.PI / 2; backNet.position.set(s * goalDepth, cfg.goalH / 2, 0);
    for (const zs of [-1, 1]) {
      const sideNet = mesh(new THREE.PlaneGeometry(goalDepth, cfg.goalH), netMat, goal);
      sideNet.position.set(s * goalDepth / 2, cfg.goalH / 2, zs * cfg.goalW / 2);
    }
    const roofNet = mesh(new THREE.PlaneGeometry(goalDepth, cfg.goalW), netMat, goal);
    roofNet.rotation.x = Math.PI / 2; roofNet.rotation.z = Math.PI / 2; roofNet.position.set(s * goalDepth / 2, cfg.goalH, 0);
  }

  const flagMat = mat({ color: 0xffd84a, side: THREE.DoubleSide, roughness: 0.7 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const pole = mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.5, 8), metal);
    pole.position.set(sx * halfX, 0.75, sz * halfZ);
    const flag = mesh(new THREE.PlaneGeometry(0.48, 0.32), flagMat);
    flag.position.set(sx * (halfX - 0.24), 1.32, sz * halfZ);
  }

  const crowdBases = [];
  const addSide = (x, z, rotY, length) => {
    const side = new THREE.Group(); side.position.set(x, 0, z); side.rotation.y = rotY; group.add(side);
    for (let r = 0; r < 8; r++) {
      const step = mesh(new THREE.BoxGeometry(length, 0.55, 1.35), r % 2 ? concrete : darkConcrete, side);
      step.position.set(0, 0.45 + r * 0.62, -r * 1.15);
      const seats = mesh(new THREE.BoxGeometry(length - 0.4, 0.32, 0.52), seatMats[r % seatMats.length], side);
      seats.position.set(0, 0.9 + r * 0.62, -r * 1.15 + 0.12);
      const n = Math.floor(length / 1.05);
      for (let k = 0; k < n; k++) {
        if ((k + 1) % 17 < 2) continue;
        crowdBases.push({
          side, x: (k / (n - 1) - 0.5) * (length - 1.4), y: 1.45 + r * 0.62,
          z: -r * 1.15 + 0.1, phase: Math.random() * 6.28,
          variant: (k * 7 + r * 3) % 10, row: r
        });
      }
    }
    for (let k = 8; k < Math.floor(length / 1.05); k += 17) {
      const aisle = mesh(new THREE.BoxGeometry(0.75, 0.08, 9.4), darkConcrete, side);
      aisle.position.set((k / (Math.floor(length / 1.05) - 1) - 0.5) * (length - 1.4), 1.02, -3.8);
    }
    const roof = mesh(new THREE.BoxGeometry(length + 2, 0.22, 9.8), darkConcrete, side);
    roof.position.set(0, 7.5, -3.5); roof.rotation.x = -0.08;
    for (const px of [-length / 2 + 1, 0, length / 2 - 1]) {
      const pillar = mesh(new THREE.CylinderGeometry(0.12, 0.16, 7.5, 8), metal, side);
      pillar.position.set(px, 3.75, -7.2);
    }
  };
  const runoff = cfg.runoff ?? 6;
  addSide(0, -halfZ - runoff, 0, cfg.pitchLength + 16);
  addSide(0, halfZ + runoff, Math.PI, cfg.pitchLength + 16);
  addSide(-halfX - runoff, 0, Math.PI / 2, cfg.pitchWidth + 16);
  addSide(halfX + runoff, 0, -Math.PI / 2, cfg.pitchWidth + 16);

  group.updateMatrixWorld(true);
  const crowdCount = crowdBases.length;
  const torsoGeo = new THREE.BoxGeometry(0.4, 0.48, 0.26, 1, 1, 1);
  const headGeo = new THREE.SphereGeometry(0.13, 7, 5);
  const legGeo = new THREE.BoxGeometry(0.34, 0.34, 0.25);
  const armGeo = new THREE.BoxGeometry(0.085, 0.34, 0.1);
  armGeo.translate(0, -0.17, 0);
  const body = new THREE.InstancedMesh(torsoGeo, mat({ roughness: 0.9 }), crowdCount);
  const heads = new THREE.InstancedMesh(headGeo, mat({ roughness: 0.9 }), crowdCount);
  const legs = new THREE.InstancedMesh(legGeo, mat({ color: 0x263142, roughness: 0.95 }), crowdCount);
  const leftArms = new THREE.InstancedMesh(armGeo, mat({ roughness: 0.9 }), crowdCount);
  const rightArms = new THREE.InstancedMesh(armGeo, mat({ roughness: 0.9 }), crowdCount);
  disposables.add(body.geometry).add(heads.geometry).add(legs.geometry).add(leftArms.geometry).add(rightArms.geometry);
  for (const m of [body, heads, legs, leftArms, rightArms]) { m.castShadow = false; m.receiveShadow = true; }
  const m4 = new THREE.Matrix4(), color = new THREE.Color(), world = new THREE.Vector3();
  const crowdPalette = [0x27384c, 0x45525f, 0x6f7780, 0xd7d9d5, 0x23364d, 0x5d3034, 0x2e5668, 0x8b7d67, 0x244b3b];
  const skinTones = [0xc89472, 0x9a6846, 0x6d472f, 0xd8ab88, 0x80543b];
  const homeColor = new THREE.Color(0x2aa8e0), awayColor = new THREE.Color(0xa63c35);
  crowdBases.forEach((b, i) => {
    world.set(b.x, b.y, b.z).applyMatrix4(b.side.matrixWorld);
    const homeStand = world.x < -halfX * 0.55;
    const awayStand = world.x > halfX * 0.55;
    // Spectators are deliberately neutral: team colour is reserved for scarves,
    // flags and seat blocks so crowd members are never mistaken for players.
    if ((homeStand && i % 13 < 3) || (awayStand && i % 13 === 0)) {
      color.copy(homeStand ? homeColor : awayColor).multiplyScalar(0.52);
    } else if ((awayStand && i % 13 < 3) || (homeStand && i % 13 === 0)) {
      color.copy(awayStand ? awayColor : homeColor).multiplyScalar(0.52);
    } else color.setHex(crowdPalette[(i * 7) % crowdPalette.length]);
    const shade = 0.58 + (i % 6) * 0.04;
    color.multiplyScalar(shade);
    b.tint = color.clone();
    m4.makeTranslation(world.x, world.y, world.z); body.setMatrixAt(i, m4);
    m4.makeTranslation(world.x, world.y + 0.39, world.z); heads.setMatrixAt(i, m4);
    m4.makeTranslation(world.x, world.y - 0.3, world.z + 0.04); legs.setMatrixAt(i, m4);
    body.setColorAt(i, color); leftArms.setColorAt(i, color); rightArms.setColorAt(i, color);
    heads.setColorAt(i, new THREE.Color(skinTones[(i * 3) % skinTones.length]).multiplyScalar(0.85 + (i % 4) * 0.04));
    b.wx = world.x; b.wy = world.y; b.wz = world.z;
    b.wave = (i % 13 === 0) || (b.variant === 8 && i % 3 === 0);
  });
  crowdBases.forEach((b, i) => {
    m4.makeTranslation(b.wx - 0.24, b.wy + 0.18, b.wz); leftArms.setMatrixAt(i, m4);
    m4.makeTranslation(b.wx + 0.24, b.wy + 0.18, b.wz); rightArms.setMatrixAt(i, m4);
  });
  for (const m of [body, heads, legs, leftArms, rightArms]) m.instanceMatrix.needsUpdate = true;
  for (const m of [body, heads, leftArms, rightArms]) if (m.instanceColor) m.instanceColor.needsUpdate = true;
  group.add(body, heads, legs, leftArms, rightArms);

  const flagCount = Math.max(24, Math.floor(crowdCount * 0.035));
  const flags = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(0.38, 0.26),
    new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.8, vertexColors: false }),
    flagCount
  );
  disposables.add(flags.geometry);
  const flagBases = [];
  for (let i = 0; i < flagCount; i++) {
    const b = crowdBases[Math.floor((i + 1) * crowdCount / (flagCount + 1))];
    const c = i % 4 === 0 ? awayColor : homeColor;
    flags.setColorAt(i, c);
    flagBases.push({ x: b.wx, y: b.wy + 0.7, z: b.wz, phase: i * 1.7 });
  }
  if (flags.instanceColor) flags.instanceColor.needsUpdate = true;
  group.add(flags);

  const adTexts = ['PITCHLINE', 'ONE PLAYER • ONE ROLE', 'PLAY BEAUTIFUL', 'THE BEAUTIFUL GAME'];
  const adMats = adTexts.map((t, i) => {
    const tex = boardTexture(t, i % 2 ? '#00e676' : '#00b0ff'); disposables.add(tex);
    return mat({ map: tex, emissiveMap: tex, emissive: 0x506070, emissiveIntensity: 0.65, roughness: 0.55 });
  });
  const addBoard = (x, z, rot, len, i) => {
    const b = mesh(new THREE.BoxGeometry(len, 0.62, 0.1), adMats[i % adMats.length]);
    b.position.set(x, 0.34, z); b.rotation.y = rot;
  };
  for (let x = -halfX + 7, i = 0; x < halfX - 3; x += 14, i++) {
    addBoard(x, -halfZ - 2.2, 0, 12, i); addBoard(x, halfZ + 2.2, Math.PI, 12, i + 1);
  }
  for (const s of [-1, 1]) for (const z of [-halfZ / 2, halfZ / 2]) addBoard(s * (halfX + 2.2), z, s * Math.PI / 2, 8, 2);

  const shelterMat = mat({ color: 0x26374b, metalness: 0.3, roughness: 0.5, transparent: true, opacity: 0.85 });
  for (const sx of [-1, 1]) {
    const bench = new THREE.Group(); bench.position.set(sx * 10, 0, halfZ + 3.2); group.add(bench);
    const roof = mesh(new THREE.BoxGeometry(7, 0.15, 2.2), shelterMat, bench); roof.position.y = 2.2;
    const back = mesh(new THREE.BoxGeometry(7, 1.7, 0.12), shelterMat, bench); back.position.set(0, 1.2, 0.9);
    for (let i = 0; i < 6; i++) { const seat = mesh(new THREE.BoxGeometry(0.7, 0.55, 0.65), seatMats[0], bench); seat.position.set(-2.8 + i * 1.1, 0.45, 0); }
  }

  const lampMat = mat({ color: 0xe9f2ff, emissive: 0xcfe2ff, emissiveIntensity: 2.4, roughness: 0.3 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const tower = mesh(new THREE.CylinderGeometry(0.18, 0.35, 24, 10), metal);
    tower.position.set(sx * (halfX + 12), 12, sz * (halfZ + 12));
    const head = mesh(new THREE.BoxGeometry(4.2, 1.8, 0.5), lampMat);
    head.position.set(sx * (halfX + 12), 24, sz * (halfZ + 12)); head.lookAt(0, 0, 0);
  }

  let crowdTime = 0;
  const armPos = new THREE.Vector3(), armScale = new THREE.Vector3(1, 1, 1);
  const leftQ = new THREE.Quaternion(), rightQ = new THREE.Quaternion(), flagQ = new THREE.Quaternion();
  const zAxis = new THREE.Vector3(0, 0, 1), yAxis = new THREE.Vector3(0, 1, 0);
  return {
    group, body, heads,
    setQuality(tier) {
      const count = tier === 'HIGH' ? crowdCount : Math.floor(crowdCount * 0.42);
      for (const m of [body, heads, legs, leftArms, rightArms]) m.count = count;
      flags.count = Math.max(8, Math.floor(flagCount * (tier === 'HIGH' ? 1 : 0.45)));
    },
    update(dt, excitement = 0.15) {
      crowdTime += dt;
      if (crowdTime < 0.11) return;
      crowdTime = 0;
      const t = performance.now() * 0.0024;
      const limit = body.count;
      for (let i = 0; i < limit; i++) {
        const b = crowdBases[i];
        const jump = Math.max(0, Math.sin(t * 1.7 + b.phase)) * (0.025 + excitement * 0.15);
        const y = b.wy + jump;
        m4.makeTranslation(b.wx, y, b.wz); body.setMatrixAt(i, m4);
        m4.makeTranslation(b.wx, y + 0.39, b.wz); heads.setMatrixAt(i, m4);
        const raised = excitement > 0.5 || b.wave;
        const sway = Math.sin(t * 1.1 + b.phase) * 0.12;
        const angle = raised ? 2.3 + sway : 0.1 + sway * 0.4;
        leftQ.setFromAxisAngle(zAxis, -angle);
        rightQ.setFromAxisAngle(zAxis, angle);
        armPos.set(b.wx - 0.24, y + 0.18, b.wz); m4.compose(armPos, leftQ, armScale); leftArms.setMatrixAt(i, m4);
        armPos.set(b.wx + 0.24, y + 0.18, b.wz); m4.compose(armPos, rightQ, armScale); rightArms.setMatrixAt(i, m4);
      }
      for (const m of [body, heads, leftArms, rightArms]) m.instanceMatrix.needsUpdate = true;
      if (flags.count) {
        for (let i = 0; i < flags.count; i++) {
          const f = flagBases[i];
          flagQ.setFromAxisAngle(yAxis, Math.sin(t + f.phase) * 0.6);
          armPos.set(f.x, f.y + (excitement > 0.5 ? 0.18 : 0), f.z);
          m4.compose(armPos, flagQ, armScale); flags.setMatrixAt(i, m4);
        }
        flags.instanceMatrix.needsUpdate = true;
      }
    },
    dispose() {
      group.traverse((o) => {
        if (o.geometry) disposables.add(o.geometry);
        if (o.material) for (const m of Array.isArray(o.material) ? o.material : [o.material]) disposables.add(m);
      });
      for (const d of disposables) {
        for (const k of ['map', 'normalMap', 'emissiveMap']) d[k]?.dispose?.();
        d.dispose?.();
      }
      group.clear();
    }
  };
}

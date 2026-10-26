import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const base = process.argv[2] ?? 'http://localhost:5210';
const outDir = process.argv[3] ?? 'artifacts';
const chromePath = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const port = 9340;
const profile = mkdtempSync(join(tmpdir(), 'pitchline-mocap-'));
const chrome = spawn(chromePath, [
  '--headless=new', '--no-sandbox', '--disable-gpu-sandbox',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=1600,900', 'about:blank'
], { stdio: 'ignore' });

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 60000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await delay(250);
  }
  throw new Error(`Timed out${last ? `: ${last.message}` : ''}`);
}

let ws;
try {
  mkdirSync(outDir, { recursive: true });
  await until(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let nextId = 1;
  const pending = new Map();
  const errors = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${base}/?mode=full11&autostart=1&cam=0&quality=light` });
  await until(() => evaluate('!!window.__pitchline?.host && !!window.__pitchline?.state?.athletes'), 90000);
  await delay(500);

  await evaluate(`(() => {
    const P = window.__pitchline;
    if (!P.host) document.getElementById('btn-start').click();
    const tutorial = document.getElementById('controls-panel');
    if (tutorial && !tutorial.classList.contains('hidden')) document.getElementById('btn-tutorial-close').click();
    P.host.lastHumanInputTime = performance.now() / 1000 + 9999;
    P.state.hud.setAfk(false);
    document.getElementById('hud').style.display = 'none';
    return true;
  })()`);

  const setupHuman = async () => evaluate(`(() => {
    const P = window.__pitchline;
    const m = P.host.match;
    P.host.setPaused(true);
    m.phase = 'LIVE'; m.setPiece = null; m.setPieceTeam = null; m.freezeUntil = 0;
    m.celebTimer = 0; m.score = [0, 0]; m.lastConcededTeam = null;
    m.penalty = null; m.freeKickInfo = null;
    const human = m.players.find(p => p.id === P.host.humanId);
    const goal = m.teams[human.team].attackGoal;
    const dir = m.dirFor(human.team);
    m.players.forEach((p, i) => {
      p.setInstantPosition(-m.fieldHalfX + 5 + i * 1.2, m.fieldHalfZ * 0.55);
      p.actionLockUntil = 0; p.pendingStrike = null; p.pendingDistribution = null;
      p.kickKind = null; p.actionImmediate = false; p.actionSeq = (p.actionSeq ?? 0) + 1;
      p.animMode = 'IDLE'; p.kickTimer = 0; p.diveTimer = 0; p.feintUntil = 0;
      p.jumpTimer = 0; p.jumpHeight = 0; p.bufferedAction = null;
      const rig = P.state.matchView.rigs.get(p.id);
      if (rig) { rig.actionKind = null; rig.actionSeq = -1; rig.actionRemaining = 0; }
    });
    human.setInstantPosition(goal.x - dir * 18, 0, dir > 0 ? 0 : Math.PI);
    const gk = m.teams[1 - human.team].players.find(p => p.isGoalKeeper);
    if (gk) gk.setInstantPosition(goal.x - dir * 0.6, 0, dir > 0 ? Math.PI : 0);
    m.ball.pos.x = human.pos.x + dir * 0.45;
    m.ball.pos.y = 0.11;
    m.ball.pos.z = human.pos.z;
    m.ball.hold(human);
    m.ball.pos.x = human.pos.x + dir * 0.45;
    m.ball.pos.z = human.pos.z;
    P.host.latestSnapshot = m.getSnapshot();
    P.host.prevSnapshot = P.host.latestSnapshot;
    if (P.__cap) P.__cap.updateNow(1 / 30, P.host.latestSnapshot, P.host.humanId);
    else P.state.matchView.update(1 / 30, P.host.latestSnapshot, P.host.humanId);
    P.state.scene.focusSetPiece('CARD', 120, { playerId: human.id });
    P.state.scene._forceCut = true;
    for (let i = 0; i < 20; i++) P.state.scene.updateCamera(1 / 30, P.host.latestSnapshot, P.host.humanId);
    P.state.scene.render();
    if (!P.__cap) {
      P.__cap = {
        mv: P.state.matchView, sv: P.state.scene,
        update: P.state.matchView.update, camera: P.state.scene.updateCamera
      };
      P.__cap.updateNow = (...args) => P.__cap.update.apply(P.__cap.mv, args);
      P.__cap.cameraNow = (...args) => P.__cap.camera.apply(P.__cap.sv, args);
      P.state.matchView.update = () => {};
      P.state.scene.updateCamera = () => {};
    }
    return { human: human.id, role: human.role, goal: goal.x, dir };
  })()`);

  const capture = async (name, playerId = null) => {
    const result = await evaluate(`(() => {
      const P = window.__pitchline;
      P.state.scene._forceCut = true;
      const snapshotPlayer = P.host.latestSnapshot.players.find(p => p.id === (${JSON.stringify(playerId)} || P.host.humanId));
      if (snapshotPlayer) {
        const dir = Math.sign(P.host.match.teams[snapshotPlayer.team].attackGoal.x - P.host.match.teams[snapshotPlayer.team].ownGoal.x) || 1;
        P.state.scene.camera.position.set(snapshotPlayer.x - dir * 5, 2.4, snapshotPlayer.z + 5.2);
        P.state.scene.camera.lookAt(snapshotPlayer.x + dir * 0.6, 1.0, snapshotPlayer.z);
      }
      P.state.scene.render();
      const targetId = ${JSON.stringify(playerId)} || P.host.humanId;
      const human = P.host.match.players.find(p => p.id === targetId);
      const rig = P.state.matchView.rigs.get(targetId);
      const bones = Object.fromEntries(Object.entries(rig?.bones ?? {}).map(([k, b]) => [k, b.position.toArray().every(Number.isFinite) && b.quaternion.toArray().every(Number.isFinite)]));
      return {
        data: P.state.scene.renderer.domElement.toDataURL('image/png'),
        probe: {
          clip: rig?.current?.getClip()?.name ?? null,
          time: rig?.current?.time ?? null,
          actionRemaining: rig?.actionRemaining ?? null,
          kickKind: human?.kickKind,
          pos: human ? [+human.pos.x.toFixed(2), +human.pos.z.toFixed(2)] : null,
          camera: P.state.scene.camera.position.toArray().map(n => +n.toFixed(2)),
          pending: !!human?.pendingStrike,
          ballHolder: P.host.match.ball.holder?.id ?? null,
          ballDistance: human ? +Math.hypot(P.host.match.ball.pos.x - human.pos.x, P.host.match.ball.pos.z - human.pos.z).toFixed(2) : null,
          carryMode: P.host.latestSnapshot?.players.find(p => p.id === targetId)?.carryMode ?? null,
          skillKind: human?.skillKind ?? null,
          locoState: human?.locoState ?? null,
          locoPhase: human?.locoPhase == null ? null : +human.locoPhase.toFixed(3),
          plantedFeet: rig?.footPlanting?.getDiagnostics?.().filter(leg => leg.planted).length ?? null,
          finiteBones: Object.values(bones).every(Boolean),
          boneCount: Object.keys(bones).length
        }
      };
    })()`);
    const path = join(outDir, `${name}.png`);
    writeFileSync(path, Buffer.from(result.data.split(',')[1], 'base64'));
    console.log(path, JSON.stringify(result.probe));
    return result.probe;
  };

  const info = await setupHuman();

  // Shot: wind-up and contact/follow-through.
  await evaluate(`(() => {
    const P = window.__pitchline;
    const m = P.host.match;
    const human = m.players.find(p => p.id === P.host.humanId);
    m.ball.hold(human);
    P.host.setPaused(false);
    P.host.receiveIntent({ shoot: true, shootPower: 0.9, moveX: 0, moveZ: 0, speedScale: 1 });
    P.host.tick(1 / 30);
    P.__cap.updateNow(1 / 30, P.host.latestSnapshot, P.host.humanId);
    for (let i = 0; i < 5; i++) { P.host.tick(1 / 30); P.__cap.updateNow(1 / 30, P.host.latestSnapshot, P.host.humanId); }
    P.host.setPaused(true);
    return true;
  })()`);
  const shotWindup = await capture('mocap-shot-windup');

  await evaluate(`(() => {
    const P = window.__pitchline;
    P.host.setPaused(false);
    for (let i = 0; i < 8; i++) { P.host.tick(1 / 30); P.__cap.updateNow(1 / 30, P.host.latestSnapshot, P.host.humanId); }
    P.host.setPaused(true);
    return true;
  })()`);
  const shotContact = await capture('mocap-shot-contact');

  // Pass.
  await setupHuman();
  await evaluate(`(() => {
    const P = window.__pitchline;
    const m = P.host.match;
    const human = m.players.find(p => p.id === P.host.humanId);
    const dir = m.dirFor(human.team);
    const mate = m.players.find(p => p.team === human.team && p !== human && !p.isGoalKeeper);
    if (mate) mate.setInstantPosition(human.pos.x + dir * 8, 4, 0);
    m.ball.hold(human);
    P.host.setPaused(false);
    P.host.receiveIntent({ pass: true, passPower: 0.5, moveX: 0, moveZ: 0, speedScale: 1 });
    P.host.tick(1 / 30);
    P.__cap.updateNow(1 / 30, P.host.latestSnapshot, P.host.humanId);
    for (let i = 0; i < 5; i++) { P.host.tick(1 / 30); P.__cap.updateNow(1 / 30, P.host.latestSnapshot, P.host.humanId); }
    P.host.setPaused(true);
    return true;
  })()`);
  const passProbe = await capture('mocap-pass');

  // Goalkeeper dive.
  const diveInfo = await evaluate(`(() => {
    const P = window.__pitchline;
    const m = P.host.match;
    const human = m.players.find(p => p.id === P.host.humanId);
    const ownGoal = m.teams[human.team].ownGoal;
    const gk = m.teams[1 - human.team].players.find(p => p.isGoalKeeper);
    gk.setInstantPosition(ownGoal.x + m.dirFor(1 - human.team) * 0.6, 0, 0);
    m.ball.reset({ x: gk.pos.x + 3, y: 0.11, z: 1.2 });
    P.host.setPaused(false);
    m.startGKDive(gk, { worldX: 0, worldZ: 1 });
    P.host.latestSnapshot = m.getSnapshot();
    for (let i = 0; i < 4; i++) { P.host.tick(1 / 30); P.host.latestSnapshot = m.getSnapshot(); P.__cap.updateNow(1 / 30, P.host.latestSnapshot, P.host.humanId); }
    P.host.setPaused(true);
    P.state.scene.focusSetPiece('CARD', 120, { playerId: gk.id });
    P.state.scene._forceCut = true;
    for (let i = 0; i < 12; i++) P.__cap.cameraNow(1 / 30, P.host.latestSnapshot, P.host.humanId);
    return { gk: gk.id };
  })()`);
  const diveProbe = await capture('mocap-gk-dive', diveInfo?.gk);

  // Celebration.
  await evaluate(`(() => {
    const P = window.__pitchline;
    const m = P.host.match;
    const human = m.players.find(p => p.id === P.host.humanId);
    human.animMode = 'CELEBRATE';
    human.kickKind = null;
    human.actionSeq = (human.actionSeq ?? 0) + 1;
    P.host.setPaused(true);
    P.host.latestSnapshot = m.getSnapshot();
    P.state.scene.focusSetPiece('CARD', 120, { playerId: human.id });
    P.state.scene._forceCut = true;
    for (let i = 0; i < 6; i++) P.__cap.updateNow(1 / 30, P.host.latestSnapshot, P.host.humanId);
    return true;
  })()`);
  const celebrationProbe = await capture('mocap-celebration', info?.human);

  await evaluate(`(() => { const P=window.__pitchline; if (P.__cap) { P.state.matchView.update=P.__cap.update; P.state.scene.updateCamera=P.__cap.camera; document.getElementById('hud').style.display=''; } return true; })()`);
  // Dribble: show the ball separated from the feet by a planned touch.
  await setupHuman();
  await evaluate(`(() => {
    const P = window.__pitchline;
    const m = P.host.match;
    const human = m.players.find(p => p.id === P.host.humanId);
    m.ball.hold(human);
    P.host.setPaused(false);
    P.host.receiveIntent({ moveX: 0, moveZ: 1, worldX: 1, worldZ: 0, speedScale: 0.85, sprint: false });
    for (let i = 0; i < 35; i++) {
      P.host.receiveIntent({ moveX: 0, moveZ: 1, worldX: 1, worldZ: 0, speedScale: 0.85, sprint: false });
      P.host.tick(1 / 30);
      P.__cap.updateNow(1 / 30, P.host.latestSnapshot, P.host.humanId);
    }
    P.host.setPaused(true);
    return true;
  })()`);
  const dribbleProbe = await capture('mocap-dribble', info?.human);

  // Shield: close control with the defender behind the ball.
  await setupHuman();
  await evaluate(`(() => {
    const P = window.__pitchline;
    const m = P.host.match;
    const human = m.players.find(p => p.id === P.host.humanId);
    const dir = m.dirFor(human.team);
    const opponent = m.teams[1 - human.team].players.find(p => !p.isGoalKeeper);
    opponent.setInstantPosition(human.pos.x - dir * 0.85, human.pos.z, dir > 0 ? 0 : Math.PI);
    opponent.tackleReadyAt = 1e9;
    m.ball.hold(human);
    m.ball.pos.x = human.pos.x + dir * 0.45;
    m.ball.pos.y = 0.11;
    m.ball.pos.z = human.pos.z;
    P.host.setPaused(false);
    for (let i = 0; i < 4; i++) {
      P.host.receiveIntent({ worldX: dir, worldZ: 0, speedScale: 0.4, closeControl: true });
      P.host.tick(1 / 30);
      P.__cap.updateNow(1 / 30, P.host.latestSnapshot, P.host.humanId);
    }
    P.host.setPaused(true);
    return true;
  })()`);
  const shieldProbe = await capture('feel-shield', info?.human);

  // Ball roll: skill + close control knocks the ball laterally.
  await setupHuman();
  await evaluate(`(() => {
    const P = window.__pitchline;
    const m = P.host.match;
    const human = m.players.find(p => p.id === P.host.humanId);
    const opponent = m.teams[1 - human.team].players.find(p => !p.isGoalKeeper);
    const dir = m.dirFor(human.team);
    opponent.setInstantPosition(human.pos.x + dir * 1.2, human.pos.z + 0.6, dir > 0 ? Math.PI : 0);
    opponent.tackleReadyAt = 1e9;
    m.ball.hold(human);
    P.host.setPaused(false);
    m.performSkill(human, { closeControl: true, worldX: 0, worldZ: 0 });
    for (let i = 0; i < 2; i++) {
      P.host.tick(1 / 30);
      P.__cap.updateNow(1 / 30, P.host.latestSnapshot, P.host.humanId);
    }
    P.host.setPaused(true);
    return true;
  })()`);
  const rollProbe = await capture('feel-ball-roll', info?.human);

  // Sprint carry: phase-locked gait with the ball ahead.
  await setupHuman();
  await evaluate(`(() => {
    const P = window.__pitchline;
    const m = P.host.match;
    const human = m.players.find(p => p.id === P.host.humanId);
    const dir = m.dirFor(human.team);
    m.players.filter(p => p !== human).forEach(p => p.setInstantPosition(-m.fieldHalfX + 2, m.fieldHalfZ - 2, 0));
    m.ball.hold(human);
    P.host.setPaused(false);
    for (let i = 0; i < 45; i++) {
      P.host.receiveIntent({ worldX: dir, worldZ: 0, speedScale: 1, sprint: true });
      P.host.tick(1 / 30);
      P.__cap.updateNow(1 / 30, P.host.latestSnapshot, P.host.humanId);
    }
    P.host.setPaused(true);
    return true;
  })()`);
  const sprintProbe = await capture('feel-sprint', info?.human);

  writeFileSync(join(outDir, 'mocap-captures.json'), JSON.stringify({
    info, shotWindup, shotContact, passProbe, diveProbe, celebrationProbe, dribbleProbe,
    shieldProbe, rollProbe, sprintProbe, errors
  }, null, 2));
  console.log(JSON.stringify({
    info, shotWindup, shotContact, passProbe, diveProbe, celebrationProbe, dribbleProbe,
    shieldProbe, rollProbe, sprintProbe, errors
  }, null, 2));
  if (errors.length) throw new Error(`${errors.length} browser exceptions recorded`);
} finally {
  ws?.close();
  chrome.kill();
  await delay(1000);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 }); } catch { /* deferred */ }
}

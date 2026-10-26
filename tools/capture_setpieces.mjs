import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const base = process.argv[2] ?? 'http://localhost:5210';
const outDir = process.argv[3] ?? 'artifacts';
const chromePath = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const port = 9337;
const profile = mkdtempSync(join(tmpdir(), 'pitchline-setpieces-'));
const glFlags = process.env.CHROME_GPU === '1'
  ? ['--use-angle=d3d11']
  : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const chrome = spawn(chromePath, [
  '--headless=new', '--no-sandbox', '--disable-gpu-sandbox', ...glFlags,
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=1600,900', 'about:blank'
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
  await send('Page.navigate', { url: `${base}/?mode=full11&quality=light` });
  await until(() => evaluate('!!window.__pitchline?.host || !document.querySelector(\'[data-screen="lobby"]\').classList.contains("hidden")'), 60000);
  await until(() => evaluate('!document.querySelector(\'[data-screen="lobby"]\').classList.contains("hidden")'), 60000);
  await delay(400);

  const probes = [];
  const shot = async (name, { canvas = false } = {}) => {
    if (canvas) {
      const result = await evaluate(`(() => {
        const P = window.__pitchline;
        const m = P.host.match;
        const cam = P.state.scene.camera;
        P.state.matchView.update(1 / 30, P.host.latestSnapshot, P.host.humanId);
        for (let i = 0; i < 20; i++) P.state.scene.updateCamera(1 / 30, P.host.latestSnapshot, P.host.humanId);
        P.state.scene.render();
        const probe = {
          shot: ${JSON.stringify(name)},
          camera: P.state.scene.cameraLabel,
          camPos: [cam.position.x, cam.position.y, cam.position.z].map((n) => +n.toFixed(2)),
          control: P.state.penaltyControl?.mode ?? null,
          paused: P.host.paused,
          cinema: document.getElementById('hud').classList.contains('penalty-cinema'),
          panel: P.state.setPieceOpen,
          score: m.score.slice(),
          setPiece: m.setPiece,
          engineTime: +m.time.toFixed(2),
          displayClock: Math.round(m.displayClockSec),
          penalty: m.penalty ? {
            team: m.penalty.team, taken: m.penalty.taken, waiting: m.penalty.waiting,
            waitUntil: +m.penalty.waitUntil.toFixed(2),
            taker: m.penalty.taker?.name ?? null, keeper: m.penalty.keeper?.name ?? null
          } : null,
          ball: [m.ball.pos.x, m.ball.pos.z].map((n) => +n.toFixed(2)),
          holder: m.ball.holder?.name ?? null,
          humanTeam: P.host.human?.team ?? null,
          marker: P.state.scene.penaltyMarker?.visible ?? false,
          takerDebug: m.penalty?.taker ? (() => {
            const id = m.penalty.taker.id;
            const snapP = P.host.latestSnapshot.players.find((q) => q.id === id);
            const rig = P.state.matchView.rigs.get(id);
            const localP = P.host.latestSnapshot.players.find((q) => q.id === P.host.humanId);
            const proj = (x, y, z) => {
              const v = P.state.scene._desired.clone().set(x, y, z).project(P.state.scene.camera);
              return [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)];
            };
            let parent = rig?.root;
            while (parent?.parent) parent = parent.parent;
            return {
              id,
              engine: [+m.penalty.taker.pos.x.toFixed(2), +m.penalty.taker.pos.z.toFixed(2)],
              snap: snapP ? [+snapP.x.toFixed(2), +snapP.z.toFixed(2)] : null,
              local: localP ? [+localP.x.toFixed(2), +localP.z.toFixed(2)] : null,
              rig: rig ? {
                at: [+rig.root.position.x.toFixed(2), +rig.root.position.z.toFixed(2)],
                visible: rig.root.visible, children: rig.root.children.length,
                parentType: rig.root.parent?.type ?? null,
                sceneRoot: parent?.type === 'Scene',
                scale: rig.root.scale.toArray().map((n) => +n.toFixed(2)),
                childWorld: rig.root.children.map((c) => {
                  const v = P.state.scene._desired.clone();
                  c.getWorldPosition(v);
                  return [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)];
                })
              } : null,
              projected: {
                head: proj(m.penalty.taker.pos.x, 1.8, m.penalty.taker.pos.z),
                feet: proj(m.penalty.taker.pos.x, 0, m.penalty.taker.pos.z),
                ball: proj(m.ball.pos.x, 0.11, m.ball.pos.z),
                goal: proj(snapP ? snapP.x + 12 : 0, 1.2, 0)
              },
              human: P.host.humanId
            };
          })() : null,
          tlog: window.__penTlog ?? []
        };
        return { probe, data: P.state.scene.renderer.domElement.toDataURL('image/png') };
      })()`);
      probes.push(result.probe);
      const path = join(outDir, `${name}.png`);
      writeFileSync(path, Buffer.from(result.data.split(',')[1], 'base64'));
      console.log(path, JSON.stringify(result.probe));
      return;
    }
    const probe = await evaluate(`(() => {
      const P = window.__pitchline;
      const m = P.host.match;
      const cam = P.state.scene.camera;
      return {
        shot: ${JSON.stringify(name)},
        camera: P.state.scene.cameraLabel,
        camPos: [cam.position.x, cam.position.y, cam.position.z].map((n) => +n.toFixed(2)),
        control: P.state.penaltyControl?.mode ?? null,
        paused: P.host.paused,
        cinema: document.getElementById('hud').classList.contains('penalty-cinema'),
        panel: P.state.setPieceOpen,
        score: m.score.slice(),
        setPiece: m.setPiece,
        engineTime: +m.time.toFixed(2),
        displayClock: Math.round(m.displayClockSec),
        penalty: m.penalty ? {
          team: m.penalty.team, taken: m.penalty.taken, waiting: m.penalty.waiting,
          waitUntil: +m.penalty.waitUntil.toFixed(2),
          taker: m.penalty.taker?.name ?? null, keeper: m.penalty.keeper?.name ?? null
        } : null,
        ball: [m.ball.pos.x, m.ball.pos.z].map((n) => +n.toFixed(2)),
        holder: m.ball.holder?.name ?? null,
        humanTeam: P.host.human?.team ?? null,
        tlog: window.__penTlog ?? []
      };
    })()`);
    probes.push(probe);
    const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const path = join(outDir, `${name}.png`);
    writeFileSync(path, Buffer.from(image.data, 'base64'));
    console.log(path, JSON.stringify(probe));
  };

  await evaluate(`(() => {
    const P = window.__pitchline;
    document.getElementById('btn-start').click();
    const tutorial = document.getElementById('controls-panel');
    if (tutorial && !tutorial.classList.contains('hidden')) document.getElementById('btn-tutorial-close').click();
    P.host.lastHumanInputTime = performance.now() / 1000 + 9999;
    P.state.hud.setAfk(false);
    for (let i = 0; i < 3; i++) P.host.tick(1 / 30);
    P.host.setPaused(true);
    P.state.scene.focusSetPiece('KICKOFF', 30);
    P.state.scene._forceCut = true;
    P.state.matchView.update(1 / 30, P.host.latestSnapshot, P.host.humanId);
    for (let i = 0; i < 20; i++) P.state.scene.updateCamera(1 / 30, P.host.latestSnapshot, P.host.humanId);
    P.state.scene.render();
    return true;
  })()`);
  await delay(300);
  await evaluate(`(() => {
    const P = window.__pitchline;
    window.__penTlog = [];
    const log = (kind, ev) => window.__penTlog.push({
      at: Math.round(performance.now()), kind,
      team: ev?.team ?? null, human: ev?.human ?? null,
      humanDefense: ev?.humanDefense ?? null, side: ev?.diveSide ?? null
    });
    for (const kind of ['PenaltyAwarded', 'PenaltyTaken', 'PenaltyCancelled', 'Goal']) {
      P.host.match.events.on(kind, (ev) => log(kind, ev));
    }
    return true;
  })()`);
  await shot('presentation-kickoff');

  await evaluate(`(() => {
    const P = window.__pitchline;
    const m = P.host.match;
    m.phase = 'LIVE'; m.freezeUntil = 0; m.setPiece = null; m.clockSec = 120;
    P.host.latestSnapshot = m.getSnapshot();
    P.host.prevSnapshot = P.host.latestSnapshot;
    P.state.hud.update(P.host.latestSnapshot, {
      camMode: P.state.scene.cameraLabel, shape: '4-4-2 · BALANCED', role: 'PLAYER · STRIKER',
      perf: 'LITE', stamina: 100, added: P.host.latestSnapshot.displayAdded
    });
    P.state.scene.render();
    return { clock: document.getElementById('hud-clock').textContent, added: document.getElementById('hud-phase').textContent };
  })()`);
  await delay(200);
  await shot('presentation-clock');

  await evaluate(`(() => {
    const P = window.__pitchline;
    const m = P.host.match;
    P.host.setPaused(false);
    m.phase = 'LIVE'; m.freezeUntil = 0; m.setPiece = null;
    const goal = m.teams[0].attackGoal;
    m.freeKick(0, { x: goal.x - m.dirFor(0) * 25, y: 0.11, z: 0 }, 'FOUL', false);
    return true;
  })()`);
  await delay(900);
  await evaluate(`(() => {
    const P = window.__pitchline;
    P.state.matchView.update(1 / 30, P.host.latestSnapshot, P.host.humanId);
    for (let i = 0; i < 20; i++) P.state.scene.updateCamera(1 / 30, P.host.latestSnapshot, P.host.humanId);
    P.state.scene.render();
    return { open: P.state.setPieceOpen, title: document.getElementById('setpiece-title').textContent };
  })()`);
  await delay(200);
  await shot('presentation-freekick');

  const penaltyState = await evaluate(`(() => {
    const P = window.__pitchline;
    const m = P.host.match;
    document.getElementById('btn-setpiece-cancel').click();
    m.freeKickInfo = null; m.setPiece = null; m.phase = 'LIVE'; m.freezeUntil = 0;
    P.host.setPaused(false);
    m.awardPenalty(0, { x: 0, y: 0, z: 0 });
    const pc = P.state.penaltyControl;
    if (pc) pc.startedAt = performance.now() + 60000;
    return { control: P.state.penaltyControl?.mode ?? null, cinema: document.getElementById('hud').classList.contains('penalty-cinema'), panel: P.state.setPieceOpen };
  })()`);
  await delay(500);
  const penaltyView = await evaluate(`(() => {
    const P = window.__pitchline;
    const pc = P.state.penaltyControl;
    if (pc) { pc.aimZ = -0.55; pc.aimY = 0.62; pc.power = 0.82; }
    P.penaltyTick(1 / 60);
    P.state.matchView.update(1 / 30, P.host.latestSnapshot, P.host.humanId);
    for (let i = 0; i < 20; i++) P.state.scene.updateCamera(1 / 30, P.host.latestSnapshot, P.host.humanId);
    P.state.scene.render();
    return { control: P.state.penaltyControl?.mode ?? null, cinema: document.getElementById('hud').classList.contains('penalty-cinema'), panel: P.state.setPieceOpen };
  })()`);
  await delay(200);
  await shot('presentation-penalty', { canvas: true });

  const keeperState = await evaluate(`(() => {
    const P = window.__pitchline;
    const m = P.host.match;
    m.penalty = null; m.setPiece = null; m.phase = 'LIVE'; m.freezeUntil = 0;
    P.penaltyTick(1 / 60);
    m.awardPenalty(1, { x: 0, y: 0, z: 0 });
    const pc = P.state.penaltyControl;
    if (pc) pc.startedAt = performance.now() + 60000;
    return { control: P.state.penaltyControl?.mode ?? null, cinema: document.getElementById('hud').classList.contains('penalty-cinema') };
  })()`);
  await delay(500);
  const keeperView = await evaluate(`(() => {
    const P = window.__pitchline;
    const m = P.host.match;
    if (m.penalty?.keeper) m.penalty.keeper.pos.z = 1.6;
    P.penaltyTick(1 / 60);
    P.state.matchView.update(1 / 30, P.host.latestSnapshot, P.host.humanId);
    for (let i = 0; i < 20; i++) P.state.scene.updateCamera(1 / 30, P.host.latestSnapshot, P.host.humanId);
    P.state.scene.render();
    return { control: P.state.penaltyControl?.mode ?? null, cinema: document.getElementById('hud').classList.contains('penalty-cinema'), camera: P.state.scene.cameraLabel };
  })()`);
  await delay(200);
  await shot('presentation-penalty-keeper', { canvas: true });

  const cornerState = await evaluate(`(() => {
    const P = window.__pitchline;
    const m = P.host.match;
    m.penalty = null; m.setPiece = null; m.phase = 'LIVE'; m.freezeUntil = 0;
    P.penaltyTick(1 / 60);
    m.restart(0, { x: m.goalNets[1].x, y: 0.11, z: m.fieldHalfZ }, 'CORNER');
    P.host.setPaused(true);
    P.state.scene.focusSetPiece('CORNER', 30);
    P.state.scene._forceCut = true;
    P.host.latestSnapshot = m.getSnapshot();
    P.host.prevSnapshot = P.host.latestSnapshot;
    P.state.matchView.update(1 / 30, P.host.latestSnapshot, P.host.humanId);
    for (let i = 0; i < 20; i++) P.state.scene.updateCamera(1 / 30, P.host.latestSnapshot, P.host.humanId);
    P.state.scene.render();
    return {
      piece: m.setPiece,
      taker: m.ball.holder?.name ?? null,
      attackersInBox: m.teams[0].players.filter((p) => p.pos.x > m.fieldHalfX - 20).length,
      defendersBack: m.teams[1].players.filter((p) => p.pos.x > m.fieldHalfX - 20).length,
      restDefence: m.teams[0].players.filter((p) => p.pos.x < 0).length,
      camera: P.state.scene.cameraLabel
    };
  })()`);
  await delay(200);
  await shot('presentation-corner');

  const stats = await evaluate('window.__pitchline.stats');
  const captured = { stats, penaltyState, penaltyView, keeperState, keeperView, cornerState, probes, errors };
  writeFileSync(join(outDir, 'presentation-captures.json'), JSON.stringify(captured, null, 2));
  console.log(JSON.stringify(captured, null, 2));
  if (errors.length) throw new Error(`${errors.length} browser exceptions recorded`);
  if (penaltyState.control !== 'taker' || !penaltyState.cinema || penaltyState.panel) {
    throw new Error(`taker penalty should be HUD-free in-world control: ${JSON.stringify(penaltyState)}`);
  }
  if (keeperState.control !== 'keeper' || !keeperState.cinema) {
    throw new Error(`keeper penalty should be HUD-free key control: ${JSON.stringify(keeperState)}`);
  }
  if (keeperView.camera !== 'CAM PENALTY_KEEPER') {
    throw new Error(`keeper camera missing: ${keeperView.camera}`);
  }
  const penaltyProbe = probes.find((p) => p.shot === 'presentation-penalty');
  const takerDebug = penaltyProbe?.takerDebug;
  if (!takerDebug?.rig?.sceneRoot || !Number.isFinite(takerDebug.projected?.head?.[0]) ||
    Math.abs(takerDebug.projected.head[1]) > 1 || !Number.isFinite(takerDebug.projected.head[1])) {
    throw new Error(`penalty taker rig is not on screen: ${JSON.stringify(takerDebug)}`);
  }
  if (cornerState.piece !== 'CORNER' || cornerState.attackersInBox < 5 || cornerState.defendersBack < 6) {
    throw new Error(`corner box shape is incomplete: ${JSON.stringify(cornerState)}`);
  }
} finally {
  ws?.close();
  chrome.kill();
  await delay(1000);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 }); }
  catch { /* Chrome may still hold a file handle on Windows; temp cleanup is safe to defer. */ }
}

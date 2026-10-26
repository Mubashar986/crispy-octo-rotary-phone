import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { verifyStage2InBrowser } from './stage2-browser-scenarios.js';

const url = process.argv[2] ?? 'http://localhost:5210/?autostart=1&cam=0';
const out = process.argv[3] ?? join(tmpdir(), 'pitchline-match.png');
const action = new URL(url).searchParams.get('action');
const piece = new URL(url).searchParams.get('piece');
const lobbyOnly = new URL(url).searchParams.get('lobby') === '1';
const verifyStage2 = new URL(url).searchParams.get('verify') === 'stage2';
const chromePath = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const port = 9333;
const profile = mkdtempSync(join(tmpdir(), 'pitchline-chrome-'));
const glFlags = process.env.CHROME_GPU === '1'
  ? ['--use-angle=d3d11']
  : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const chrome = spawn(chromePath, [
  '--headless=new', '--no-sandbox', '--disable-gpu-sandbox', ...glFlags,
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=1600,900', 'about:blank'
], { stdio: 'ignore' });

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 40000) {
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
  await send('Page.navigate', { url });
  await until(() => evaluate('!!window.__pitchline?.state?.athletes && !!window.__pitchline?.state?.input && document.querySelector(\'[data-screen="boot"]\').classList.contains("hidden")'), 60000);
  await evaluate(`(() => {
    const P = window.__pitchline;
    const lobbyOnly = ${JSON.stringify(lobbyOnly)};
    if (lobbyOnly) { P.state.scene.resetLobbyCamera(); P.state.scene.render(); return true; }
    if (!P.host) document.getElementById('btn-start').click();
    const tutorial = document.getElementById('controls-panel');
    if (tutorial && !tutorial.classList.contains('hidden')) document.getElementById('btn-tutorial-close').click();
    for (let i = 0; i < 150; i++) P.host.tick(1/30);
    P.host.retakeSlot();
    P.host.lastHumanInputTime = performance.now()/1000 + 9999;
    document.getElementById('afk').classList.add('hidden');
    const piece = ${JSON.stringify(piece)};
    if (piece) {
      const m = P.host.match;
      P.host.match.step = () => {};
      for (const p of m.players) p.setInstantPosition(4, 6);
      const kind = piece === 'corner' ? 'CORNER' : 'THROWIN';
      const spot = kind === 'CORNER'
        ? { x: m.goalNets[1].x, y: 0.11, z: m.fieldHalfZ }
        : { x: m.fieldHalfX - 12, y: 0.11, z: m.fieldHalfZ };
      m.phase = 'LIVE'; m.time = 2;
      m.restart(0, spot, kind);
      P.state.scene.focusSetPiece(kind, 10);
      P.host.latestSnapshot = m.getSnapshot(); P.host.prevSnapshot = P.host.latestSnapshot;
    }
    const action = ${JSON.stringify(action)};
    if (action) {
      const human = P.host.match.players.find(p => p.isHuman);
      P.host.match.step = () => {};
      human.kickTimer = action === 'kick' ? 0.2 : 0;
      human.animMode = action === 'kick' ? 'KICK' : action.toUpperCase();
      const snap = P.host.match.getSnapshot();
      P.state.matchView.update(1/30, snap, P.host.humanId);
    }
    P.state.matchView.update(1/30, P.snapshot, P.host.humanId);
    for (let i = 0; i < 90; i++) P.state.scene.updateCamera(1/30, P.snapshot, P.host.humanId);
    P.state.scene.render();
    return true;
  })()`);
  let touchVerification = null;
  if (verifyStage2) {
    await send('Emulation.setTouchEmulationEnabled', { enabled: true });
    const controls = await evaluate(`(() => {
      const P = window.__pitchline;
      document.activeElement?.blur();
      document.getElementById('touch-controls').classList.remove('hidden');
      P.host.retakeSlot(); P.state.input.resetAll();
      window.__pointerTrace = [];
      for (const type of ['pointerdown','pointerup','pointercancel','lostpointercapture']) {
        document.addEventListener(type, e => window.__pointerTrace.push({type,id:e.pointerId,target:e.target.id}), true);
      }
      const center = id => { const r = document.getElementById(id).getBoundingClientRect(); return { x:r.x+r.width/2, y:r.y+r.height/2 }; };
      return { stick:center('joystick-zone'), shoot:center('btn-act-B') };
    })()`);
    const stick = { id: 1, x: controls.stick.x + 20, y: controls.stick.y, radiusX: 5, radiusY: 5, force: 1 };
    const shoot = { id: 2, ...controls.shoot, radiusX: 5, radiusY: 5, force: 1 };
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [stick] });
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [stick, shoot] });
    const held = await evaluate(`({stick:window.__pitchline.state.input.joyActive,buttons:window.__pitchline.state.input.buttons.size})`);
    if (!held.stick || held.buttons !== 1) throw new Error('Real multitouch failed to capture stick and shoot independently');
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [shoot] });
    const released = await evaluate(`({stick:window.__pitchline.state.input.joyActive,buttons:window.__pitchline.state.input.buttons.size,events:window.__pointerTrace})`);
    if (!released.stick || released.buttons !== 0) throw new Error(`Touch release mismatch: ${JSON.stringify(released)}`);
    await send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    touchVerification = { held, released };
  }
  const verification = verifyStage2 ? await evaluate(`(${verifyStage2InBrowser.toString()})()`) : null;
  const stats = await evaluate('window.__pitchline.stats');
  const camera = await evaluate('({mode:window.__pitchline.state.scene.cameraMode,position:window.__pitchline.state.scene.camera.position.toArray(),rotation:window.__pitchline.state.scene.camera.rotation.toArray()})');
  const clip = await evaluate(`window.__pitchline.state.matchView ? [...window.__pitchline.state.matchView.rigs.values()].slice(0,4).map(r => r.current?.getClip().name) : []`);
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  const report = { out, stats, camera, clips: clip, verification, touchVerification, errors };
  writeFileSync(`${out}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (errors.length) throw new Error(`${errors.length} browser exceptions recorded`);
} finally {
  ws?.close();
  chrome.kill();
  await delay(1000);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 }); }
  catch { /* Chrome may still hold a file handle on Windows; temp cleanup is safe to defer. */ }
}

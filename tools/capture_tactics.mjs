import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const base = process.argv[2] ?? 'http://localhost:5210';
const outDir = process.argv[3] ?? 'artifacts';
const chromePath = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const port = 9336;
const profile = mkdtempSync(join(tmpdir(), 'pitchline-tactics-'));
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
  await until(() => evaluate('!!window.__pitchline?.state?.input && !document.querySelector(\'[data-screen="lobby"]\').classList.contains("hidden")'), 60000);
  await delay(500);

  const shot = async (name) => {
    const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const path = join(outDir, `${name}.png`);
    writeFileSync(path, Buffer.from(image.data, 'base64'));
    console.log(path);
  };

  await shot('tactics-lobby');

  await evaluate(`(() => {
    const P = window.__pitchline;
    document.getElementById('btn-start').click();
    const tutorial = document.getElementById('controls-panel');
    if (tutorial && !tutorial.classList.contains('hidden')) document.getElementById('btn-tutorial-close').click();
    P.host.lastHumanInputTime = performance.now() / 1000 + 9999;
    P.state.hud.setAfk(false);
    for (let i = 0; i < 60; i++) P.host.tick(1 / 30);
    P.state.matchView.update(1 / 30, P.host.latestSnapshot, P.host.humanId);
    P.state.scene.render();
    P.state.hud.update(P.host.latestSnapshot, {
      camMode: P.state.scene.cameraLabel, shape: '4-4-2 · BALANCED', role: 'PLAYER · STRIKER', perf: 'LITE', stamina: 100, added: 0
    });
    document.getElementById('btn-tactics').click();
    P.state.scene.render();
    return true;
  })()`);
  await delay(350);
  await shot('tactics-panel-out');

  await evaluate(`(() => {
    document.querySelector('#tactics-phase button[data-phase="in"]').click();
    return true;
  })()`);
  await delay(250);
  await shot('tactics-panel-in');

  await evaluate(`(() => {
    [...document.querySelectorAll('#tactics-formations .chip-btn')].find((b) => b.textContent === '4-3-3').click();
    return true;
  })()`);
  await delay(250);
  await shot('tactics-draft-433');

  const stats = await evaluate('window.__pitchline.stats');
  writeFileSync(join(outDir, 'tactics-captures.json'), JSON.stringify({ stats, errors }, null, 2));
  console.log(JSON.stringify({ stats, errors }, null, 2));
  if (errors.length) throw new Error(`${errors.length} browser exceptions recorded`);
} finally {
  ws?.close();
  chrome.kill();
  await delay(1000);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 }); }
  catch { /* Chrome may still hold a file handle on Windows; temp cleanup is safe to defer. */ }
}

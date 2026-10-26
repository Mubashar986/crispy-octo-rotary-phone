import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const url = process.argv[2] ?? 'http://localhost:5210/?autostart=1&quality=light&cam=0';
const chromePath = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const port = 9335;
const profile = mkdtempSync(join(tmpdir(), 'pitchline-perf-'));
const gpu = process.env.CHROME_GPU !== '0';
const chrome = spawn(chromePath, [
  '--headless=new', '--no-sandbox', '--disable-gpu-sandbox',
  ...(gpu ? ['--use-angle=d3d11'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
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
  await until(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let nextId = 1;
  const pending = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
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
  await until(() => evaluate('!!window.__pitchline?.state?.athletes && document.querySelector(\'[data-screen="boot"]\').classList.contains("hidden")'));
  await delay(800);
  await evaluate(`(() => {
    const P = window.__pitchline;
    if (!P.host) document.getElementById('btn-start').click();
    const tutorial = document.getElementById('controls-panel');
    if (tutorial && !tutorial.classList.contains('hidden')) document.getElementById('btn-tutorial-close').click();
    P.host.retakeSlot();
    P.host.lastHumanInputTime = performance.now() / 1000 + 9999;
    document.getElementById('afk').classList.add('hidden');
    return true;
  })()`);
  await until(() => evaluate('window.__pitchline.host?.match?.phase === "LIVE"'), 30000);
  if (process.env.PERF_HIDE_REF === '1') {
    await evaluate('window.__pitchline.state.matchView.referee.root.visible = false');
  }
  await delay(Number(process.env.PERF_WARMUP ?? 1000));
  const sampleMs = Math.max(2, Number(process.env.PERF_SECONDS ?? 5)) * 1000;
  const sample = await evaluate(`new Promise((resolve) => {
    let frames = 0;
    const start = performance.now();
    const limit = ${sampleMs};
    const tick = () => {
      frames++;
      const elapsed = performance.now() - start;
      if (elapsed < limit) requestAnimationFrame(tick);
      else resolve({ fps: frames / (elapsed / 1000), elapsed });
    };
    requestAnimationFrame(tick);
  })`);
  const stats = await evaluate(`(() => {
    const P = window.__pitchline;
    const s = P.stats;
    return {
      quality: P.state.scene.quality,
      hudFps: P.state.perf.fps,
      calls: s.calls,
      triangles: s.triangles,
      geometries: s.geometries,
      textures: s.textures,
      crowd: s.crowd,
      camera: P.state.scene.cameraMode,
      matchPhase: P.state.host?.match?.phase ?? null,
      players: P.state.host?.match?.players?.length ?? 0
    };
  })()`);
  console.log(JSON.stringify({ url, gpu, sample: { fps: +sample.fps.toFixed(1), seconds: +(sample.elapsed / 1000).toFixed(1) }, stats }, null, 2));
} finally {
  try { ws?.close(); } catch {}
  chrome.kill();
}

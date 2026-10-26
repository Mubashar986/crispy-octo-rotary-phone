import test from 'node:test';
import assert from 'node:assert/strict';
import { InputManager } from '../src/input/InputManager.js';
import { LocalMatchHost, AFK_SECONDS } from '../src/net/loopback.js';
import { CONTROL_SCHEMES, SCHEME_LIST, DEFAULT_SCHEME } from '../src/config/controls.js';

const CFG = { id: 'classic5', name: '5v5', teamSize: 6, pitchLength: 64, pitchWidth: 48, goalW: 6, goalH: 2.2, durationSec: 300, offside: false };
const NEUTRAL = { moveX: 0, moveZ: 0, sprint: false };
const ACTIONS = ['pass', 'shoot', 'through', 'tackle', 'slide'];
const hasAction = (intent) => ACTIONS.some((key) => intent?.[key]);

// Only the EventTarget/element surface used by InputManager; no DOM library.
class FakeTarget extends EventTarget {
  constructor(clock, captures, tagName = 'DIV') {
    super();
    this.clock = clock;
    this.captures = captures;
    this.tagName = tagName;
    this.parentElement = null;
    this.contentEditable = null;
    this.style = {};
    this.rect = { left: 0, top: 0, width: 100, height: 100 };
  }
  get isContentEditable() {
    return this.contentEditable === null ? !!this.parentElement?.isContentEditable : this.contentEditable !== 'false';
  }
  closest(selector) {
    const tags = selector.toUpperCase().split(',').map((tag) => tag.trim());
    return tags.includes(this.tagName) ? this : this.parentElement?.closest(selector) ?? null;
  }
  emit(type, props = {}) {
    const event = new Event(type, { cancelable: true });
    for (const [key, value] of Object.entries({ timeStamp: this.clock(), ...props })) {
      Object.defineProperty(event, key, { value, configurable: true });
    }
    this.dispatchEvent(event);
    return event;
  }
  getBoundingClientRect() { return this.rect; }
  setPointerCapture(id) { this.captures.set(id, this); }
  hasPointerCapture(id) { return this.captures.get(id) === this; }
  releasePointerCapture(id) {
    if (!this.hasPointerCapture(id)) return;
    this.captures.delete(id);
    this.emit('lostpointercapture', { pointerId: id });
  }
}

function setupInput(t, active = true) {
  let now = 0;
  const captures = new Map();
  const element = (tag) => new FakeTarget(() => now, captures, tag);
  const window = element();
  const document = element();
  document.hidden = false;
  document.activeElement = null;
  const originals = ['window', 'document'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  Object.defineProperty(globalThis, 'window', { value: window, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true });
  t.mock.method(performance, 'now', () => now);
  const refs = Object.fromEntries(['joystickZone', 'joystickKnob', 'btnA', 'btnB', 'btnC', 'btnD', 'btnSprint'].map((name) => [name, element()]));
  refs.scheme = 'homerow';
  const input = new InputManager(refs);
  if (active) input.setActive(true);
  t.after(() => {
    input.dispose();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  return {
    input, refs, window, document, captures, element,
    time(value) { now = value; },
    key(type, key, props = {}) { return window.emit(type, { key, ...props }); },
    pointer(el, type, pointerId, props = {}) {
      // Capture routes releases outside a button back to the owning control.
      const target = type === 'pointerdown' ? el : captures.get(pointerId) ?? el;
      return target.emit(type, { pointerId, button: 0, clientX: 50, clientY: 50, ...props });
    }
  };
}

function setupHost(t, mockStep = true) {
  const host = new LocalMatchHost(CFG, { seed: 123, humanSlot: 3, aiLevel: 2 });
  const player = host.match.players.find((p) => p.id === host.humanId);
  const intents = [];
  host.match.phase = 'LIVE';
  host.match.setPiece = null;
  if (mockStep) {
    t.mock.method(host.match, 'step', () => {
      intents.push(player.intent ? { ...player.intent } : null);
      player.intent = null; // The real engine consumes its intent in each step.
    });
  }
  t.after(() => host.dispose());
  return { host, player, intents };
}

for (const hz of [144, 60, 30]) {
  for (const [action, key, button, base, rate] of [
    ['pass', 'j', 'btnA', 0.35, 0.85],
    ['shoot', 'k', 'btnB', 0.25, 0.95],
    ['through', 'i', 'btnD', 0.25, 0.8]
  ]) {
    test(`${hz} Hz: ${action} keyboard/touch powers agree for taps, holds, and saturation`, (t) => {
      const env = setupInput(t);
      for (const durationMs of [0, 7, 137, 500, 2000]) {
        env.input.resetAll();
        env.time(1007);
        env.key('keydown', key);
        env.pointer(env.refs[button], 'pointerdown', 2);
        assert.ok(env.refs[button].hasPointerCapture(2));
        for (let elapsed = 1000 / hz; elapsed < durationMs; elapsed += 1000 / hz) {
          env.time(1007 + elapsed);
          assert.equal(hasAction(env.input.sample(1 / hz)), false);
        }
        env.time(1007 + durationMs);
        env.key('keyup', key);
        env.pointer(env.element(), 'pointerup', 2);
        env.time(9000); // Delayed sampling must not add power after release.
        const keyboard = env.input.sample(1 / hz);
        const touch = env.input.sample(1 / hz);
        const expected = Math.min(1, base + durationMs / 1000 * rate);
        assert.equal(keyboard[action], true);
        assert.equal(touch[action], true);
        assert.equal(keyboard[`${action}Power`], expected);
        assert.equal(touch[`${action}Power`], expected);
        assert.equal(env.captures.size, 0);
        assert.deepEqual(env.input.sample(1 / hz), NEUTRAL);
      }
    });
  }

  test(`${hz} Hz: host retains one shot through neutral frames and supplies every step with movement`, (t) => {
    const { host, intents } = setupHost(t);
    for (let frame = 0; frame < hz; frame++) {
      host.receiveIntent({ moveX: 0.4, moveZ: 1, sprint: true, ...(frame === 0 ? { shoot: true, shootPower: 0.73 } : {}) });
      host.tick(1 / hz);
    }
    host.tick(1 / 30);
    assert.ok(intents.length >= 30);
    assert.equal(intents.filter((intent) => intent.shoot).length, 1);
    assert.equal(intents[0].shootPower, 0.73);
    for (const intent of intents) {
      assert.equal(intent.moveX, 0.4);
      assert.equal(intent.moveZ, 1);
      assert.equal(intent.sprint, true);
    }
  });

  for (const source of ['keyboard', 'touch']) {
    test(`${hz} Hz: ${source} release produces exactly one actual PlayerShoot event`, (t) => {
      const env = setupInput(t);
      const { host, player } = setupHost(t, false);
      let shots = 0;
      host.events.on('PlayerShoot', ({ player: shooter }) => { if (shooter.id === player.id) shots++; });
      const step = host.match.step.bind(host.match);
      t.mock.method(host.match, 'step', (dt) => {
        // Regrant possession so engine ball ownership cannot conceal a replayed shot.
        host.match.ball.hold(player);
        step(dt);
      });
      if (source === 'keyboard') env.key('keydown', 'k');
      else env.pointer(env.refs.btnB, 'pointerdown', 1);
      env.time(7);
      if (source === 'keyboard') env.key('keyup', 'k');
      else env.pointer(env.element(), 'pointerup', 1);
      for (let frame = 0; frame < hz; frame++) {
        env.time(7 + frame * 1000 / hz);
        host.receiveIntent(env.input.sample(1 / hz));
        host.tick(1 / hz);
      }
      assert.equal(shots, 1);
    });
  }
}

test('skill commits once on release; repeated keydowns and duplicate ups do not fire', (t) => {
  const env = setupInput(t);
  env.pointer(env.refs.btnC, 'pointerdown', 1);
  assert.equal(hasAction(env.input.sample(1 / 60)), false);
  env.pointer(env.element(), 'pointerup', 1);
  env.refs.btnC.emit('pointerup', { pointerId: 1 });
  assert.deepEqual(env.input.sample(1 / 60), { ...NEUTRAL, tackle: true, slide: true });
  assert.deepEqual(env.input.sample(1 / 60), NEUTRAL);
  env.key('keydown', 'l');
  env.key('keydown', 'l', { repeat: true });
  env.key('keydown', 'l');
  assert.equal(hasAction(env.input.sample(1 / 60)), false);
  env.key('keyup', 'l');
  env.key('keyup', 'l');
  assert.deepEqual(env.input.sample(1 / 60), { ...NEUTRAL, tackle: true, slide: true });
  assert.deepEqual(env.input.sample(1 / 60), NEUTRAL);
});

test('repeat never restarts charging or toggles camera/ping/chat twice', (t) => {
  const env = setupInput(t);
  const calls = { q: 0, t: 0, v: 0 };
  env.input.onPing = () => calls.q++;
  env.input.onChat = () => calls.t++;
  env.input.onCameraCycle = () => calls.v++;
  for (const key of ['q', 't', 'v', 'k']) env.key('keydown', key);
  env.time(250);
  for (const key of ['q', 't', 'v', 'k']) {
    env.key('keydown', key, { repeat: true });
    env.key('keydown', key);
  }
  env.time(500);
  for (const key of ['q', 't', 'v', 'k']) env.key('keyup', key);
  assert.deepEqual(calls, { q: 1, t: 1, v: 1 });
  assert.equal(env.input.sample(1 / 60).shootPower, 0.25 + 0.5 * 0.95);
  env.window.emit('blur');
  env.key('keydown', 'k', { repeat: true });
  env.key('keyup', 'k');
  assert.deepEqual(env.input.sample(1 / 60), NEUTRAL);
});

for (const cancel of ['pointercancel', 'lostpointercapture']) {
  test(`${cancel} drops each button action and releases sprint without affecting other pointers`, (t) => {
    const env = setupInput(t);
    env.pointer(env.refs.joystickZone, 'pointerdown', 10, { clientX: 65 });
    env.pointer(env.refs.btnD, 'pointerdown', 11);
    for (const button of ['btnA', 'btnB', 'btnC', 'btnSprint']) {
      env.pointer(env.refs[button], 'pointerdown', 1);
      env.time(500);
      if (cancel === 'lostpointercapture') env.refs[button].releasePointerCapture(1);
      else env.pointer(env.refs[button], cancel, 1);
      env.pointer(env.refs[button], 'pointerup', 1);
      const intent = env.input.sample(1 / 30);
      assert.equal(hasAction(intent), false);
      assert.equal(intent.sprint, false);
      assert.ok(intent.moveX > 0);
      assert.ok(env.refs.btnD.hasPointerCapture(11));
    }
    env.pointer(env.refs.btnD, cancel, 11);
    env.pointer(env.refs.btnD, 'pointerup', 11);
    assert.equal(hasAction(env.input.sample(1 / 30)), false);
  });
}

test('pointer IDs isolate joystick/buttons and captured release outside fires exactly once', (t) => {
  const env = setupInput(t);
  env.pointer(env.refs.joystickZone, 'pointerdown', 1, { clientX: 65 });
  env.pointer(env.refs.joystickZone, 'pointerdown', 2, { clientX: 20 });
  env.refs.joystickZone.emit('pointermove', { pointerId: 2, clientX: 20, clientY: 50 });
  env.refs.joystickZone.emit('pointerup', { pointerId: 2 });
  env.pointer(env.refs.btnB, 'pointerdown', 2);
  env.pointer(env.refs.btnB, 'pointerdown', 3);
  env.pointer(env.refs.btnA, 'pointerdown', 2);
  env.refs.btnB.emit('pointerup', { pointerId: 3 });
  env.refs.btnB.emit('pointercancel', { pointerId: 1 });
  env.refs.btnA.emit('pointerup', { pointerId: 2 });
  env.pointer(env.refs.btnA, 'pointerdown', 1);
  assert.equal(env.captures.get(1), env.refs.joystickZone);
  assert.equal(env.captures.get(2), env.refs.btnB);
  assert.equal(env.captures.has(3), false);
  env.time(200);
  env.pointer(env.element(), 'pointerup', 2);
  const shot = env.input.sample(1 / 60);
  assert.equal(shot.shootPower, 0.25 + 0.2 * 0.95);
  assert.ok(shot.moveX > 0);
  assert.equal(hasAction(env.input.sample(1 / 60)), false);
  env.refs.joystickZone.releasePointerCapture(1);
  assert.deepEqual(env.input.sample(1 / 60), NEUTRAL);
});

test('stick auto-sprint clears, while sprint button and both Shift keys stay independent', (t) => {
  const env = setupInput(t);
  const sprint = () => env.input.sample(1 / 60).sprint;
  env.pointer(env.refs.joystickZone, 'pointerdown', 1, { clientX: 100 });
  assert.equal(sprint(), true);
  env.pointer(env.refs.joystickZone, 'pointermove', 1);
  assert.equal(sprint(), false);
  env.pointer(env.refs.btnSprint, 'pointerdown', 2);
  env.pointer(env.refs.joystickZone, 'pointerup', 1);
  assert.equal(sprint(), true);
  env.key('keydown', 'Shift', { code: 'ShiftLeft' });
  env.key('keydown', 'Shift', { code: 'ShiftRight' });
  env.pointer(env.refs.btnSprint, 'pointerup', 2);
  assert.equal(sprint(), true);
  env.key('keyup', 'Shift', { code: 'ShiftLeft' });
  assert.equal(sprint(), true);
  env.key('keyup', 'Shift', { code: 'ShiftRight' });
  assert.equal(sprint(), false);
  env.pointer(env.refs.btnSprint, 'pointerdown', 2);
  env.key('keydown', 'Shift');
  env.key('keyup', 'Shift');
  assert.equal(sprint(), true);
  env.pointer(env.refs.joystickZone, 'pointerdown', 1, { clientX: 100 });
  env.pointer(env.refs.btnSprint, 'pointercancel', 2);
  assert.equal(sprint(), true);
  env.pointer(env.refs.joystickZone, 'pointercancel', 1);
  assert.equal(sprint(), false);
  env.refs.joystickZone.rect.width = 0;
  env.pointer(env.refs.joystickZone, 'pointerdown', 1);
  assert.deepEqual(env.input.sample(1 / 60), NEUTRAL);
});

test('D/ArrowRight movement and independent J/Space pass holds retain their releases', (t) => {
  const env = setupInput(t);
  for (const key of ['d', 'ArrowRight']) {
    env.key('keydown', key);
    assert.equal(env.input.sample(1 / 60).moveX, 1);
    env.key('keyup', key);
  }
  env.key('keydown', 'j');
  env.time(100);
  env.key('keydown', ' ');
  env.time(200);
  env.key('keyup', 'j');
  env.time(500);
  env.key('keyup', ' ');
  assert.equal(env.input.sample(1 / 60).passPower, 0.35 + 0.2 * 0.85);
  assert.equal(env.input.sample(1 / 60).passPower, 0.35 + 0.4 * 0.85);
  assert.deepEqual(env.input.sample(1 / 60), NEUTRAL);
});

for (const reset of ['blur', 'hidden', 'inactive', 'editable focus', 'dispose']) {
  test(`${reset} drops queued/held actions, movement, sprint, and captures`, (t) => {
    const env = setupInput(t);
    env.key('keydown', 'j');
    env.key('keyup', 'j'); // Completed but not yet sampled.
    env.key('keydown', 'k');
    env.key('keydown', 'Shift');
    env.key('keydown', 'w');
    env.pointer(env.refs.joystickZone, 'pointerdown', 1, { clientX: 100 });
    env.pointer(env.refs.btnD, 'pointerdown', 2);
    env.pointer(env.refs.btnSprint, 'pointerdown', 3);
    env.pointer(env.refs.btnC, 'pointerdown', 4);
    if (reset === 'blur') env.window.emit('blur');
    if (reset === 'hidden') { env.document.hidden = true; env.document.emit('visibilitychange'); }
    if (reset === 'inactive') env.input.setActive(false);
    if (reset === 'editable focus') {
      env.document.activeElement = env.element('INPUT');
      env.document.emit('focusin', { target: env.document.activeElement });
    }
    if (reset === 'dispose') env.input.dispose();
    assert.equal(env.captures.size, 0);
    env.document.hidden = false;
    env.document.activeElement = null;
    env.input.setActive(true);
    env.key('keyup', 'j');
    env.key('keyup', 'k');
    env.pointer(env.refs.btnD, 'pointerup', 2);
    env.pointer(env.refs.btnC, 'pointerup', 4);
    env.key('keydown', 'k', { repeat: true });
    env.key('keyup', 'k');
    assert.deepEqual(env.input.sample(1 / 30), NEUTRAL);
    assert.equal(env.refs.joystickKnob.style.transform, 'translate(0,0)');
  });
}

test('inactive gameplay and editable targets/focus never intercept native controls or shortcuts', (t) => {
  const env = setupInput(t, false);
  let shortcuts = 0;
  env.input.onCameraCycle = env.input.onPing = env.input.onChat = () => shortcuts++;
  const ignoredKeys = (target) => {
    for (const key of ['w', 'ArrowRight', ' ', 'j', 'k', 'i', 'l', 'Shift', 'q', 't', 'v']) {
      const props = target ? { target } : {};
      assert.equal(env.key('keydown', key, props).defaultPrevented, false);
      assert.equal(env.key('keyup', key, props).defaultPrevented, false);
    }
    assert.deepEqual(env.input.sample(1 / 60), NEUTRAL);
    assert.equal(shortcuts, 0);
  };
  ignoredKeys();
  assert.equal(env.pointer(env.refs.btnB, 'pointerdown', 1).defaultPrevented, false);
  assert.equal(env.pointer(env.refs.joystickZone, 'pointerdown', 2).defaultPrevented, false);
  assert.equal(env.captures.size, 0);
  env.input.setActive(true);
  for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) ignoredKeys(env.element(tag));
  const editor = env.element();
  editor.contentEditable = 'true';
  const child = env.element('SPAN');
  child.parentElement = editor;
  ignoredKeys(child);
  env.document.activeElement = child;
  ignoredKeys();
  env.document.activeElement = null;
  env.key('keydown', 'k');
  env.key('keyup', 'k', { target: child });
  assert.deepEqual(env.input.sample(1 / 60), NEUTRAL);
  assert.equal(env.key('keydown', 'w').defaultPrevented, true);
  assert.equal(env.input.sample(1 / 60).moveZ, 1);
});

test('rapid input commands preserve FIFO order and per-release powers through a multi-step host tick', (t) => {
  const env = setupInput(t);
  const { host, intents } = setupHost(t);
  for (const [key, start, duration] of [['k', 0, 100], ['k', 110, 200], ['j', 320, 50], ['i', 380, 300], ['l', 700, 1], ['k', 710, 10]]) {
    env.time(start);
    env.key('keydown', key);
    env.time(start + duration);
    env.key('keyup', key);
  }
  env.key('keydown', 'w');
  for (let frame = 0; frame < 10; frame++) host.receiveIntent(env.input.sample(1 / 144));
  assert.equal(intents.length, 0);
  host.tick(0); // No step must mean no consumption.
  host.tick(0.25); // Clock cap: five commands consumed, one still queued.
  assert.equal(intents.length, 5);
  host.receiveIntent({ moveX: 0, moveZ: 1, sprint: false });
  host.tick(0.1);
  assert.deepEqual(intents.filter(hasAction).map(({ moveX, moveZ, sprint, ...action }) => action), [
    { shoot: true, shootPower: 0.25 + 0.1 * 0.95 },
    { shoot: true, shootPower: 0.25 + 0.2 * 0.95 },
    { pass: true, passPower: 0.35 + 0.05 * 0.85 },
    { through: true, throughPower: 0.25 + 0.3 * 0.8 },
    { tackle: true, slide: true },
    { shoot: true, shootPower: 0.25 + 0.01 * 0.95 }
  ]);
  assert.ok(intents.length > 6);
  for (const intent of intents) assert.equal(intent.moveZ, 1);
});

test('host snapshots caller state and supplies fresh movement on every catch-up step', (t) => {
  const { host, player, intents } = setupHost(t);
  const packet = { moveX: 0.5, moveZ: -0.75, sprint: true, shoot: true, shootPower: 0.82 };
  host.receiveIntent(packet);
  packet.moveX = -1;
  packet.shootPower = 0;
  t.mock.method(host.match, 'step', () => {
    intents.push({ ...player.intent });
    player.intent.moveX = 99;
    // Even an early-returning engine that leaves intent set cannot replay actions.
  });
  host.tick(0.1);
  host.tick(0.1);
  assert.equal(intents.length, 6);
  assert.equal(intents.filter((intent) => intent.shoot).length, 1);
  assert.equal(intents[0].shootPower, 0.82);
  assert.equal(player.intent, null);
  for (const intent of intents) {
    assert.equal(intent.moveX, 0.5);
    assert.equal(intent.moveZ, -0.75);
    assert.equal(intent.sprint, true);
  }
  host.receiveIntent(NEUTRAL);
  host.tick(1 / 30);
  assert.deepEqual(intents.at(-1), NEUTRAL);
});

test('simultaneous host action flags are serialized, with tackle/slide kept as one skill', (t) => {
  const { host, intents } = setupHost(t);
  host.receiveIntent({ pass: true, passPower: 0.4, shoot: true, shootPower: 0.5, through: true, throughPower: 0.6, tackle: true, slide: true });
  host.receiveIntent(null);
  host.tick(0.25);
  assert.deepEqual(intents, [
    { ...NEUTRAL, pass: true, passPower: 0.4 },
    { ...NEUTRAL, shoot: true, shootPower: 0.5 },
    { ...NEUTRAL, through: true, throughPower: 0.6 },
    { ...NEUTRAL, tackle: true, slide: true },
    NEUTRAL
  ]);
});

test('manual AFK retake resets idle time and stale input rather than immediately covering again', (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const { host, player, intents } = setupHost(t);
  let covered = 0, retaken = 0;
  host.events.on('SlotCoveredByBot', () => covered++);
  host.events.on('SlotRetaken', () => retaken++);
  host.receiveIntent({ moveX: 1, shoot: true, shootPower: 0.9 });
  now = (AFK_SECONDS + 1) * 1000;
  host.tick(0);
  assert.equal(covered, 1);
  assert.equal(player.isHuman, false);
  now += 20000;
  host.retakeSlot();
  assert.equal(player.isHuman, true);
  assert.equal(host.coveredByBot, false);
  assert.equal(host.lastHumanInputTime, now / 1000);
  host.tick(1 / 30);
  assert.equal(covered, 1);
  assert.equal(retaken, 1);
  assert.deepEqual(intents, [NEUTRAL]);
  now += AFK_SECONDS * 1000 - 1;
  host.tick(0);
  assert.equal(covered, 1);
  now += 2;
  host.tick(0);
  assert.equal(covered, 2);
});

test('new human activity retakes AFK slot and delivers the fresh command once', (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const { host, player, intents } = setupHost(t);
  now = (AFK_SECONDS + 1) * 1000;
  host.tick(0);
  assert.equal(host.coveredByBot, true);
  host.receiveIntent({ moveZ: 1, shoot: true, shootPower: 0.7 });
  host.receiveIntent({ moveZ: 1 });
  host.tick(0.1);
  assert.equal(player.isHuman, true);
  assert.equal(host.coveredByBot, false);
  assert.equal(host.lastHumanInputTime, now / 1000);
  assert.equal(intents.filter((intent) => intent.shoot).length, 1);
  for (const intent of intents) assert.equal(intent.moveZ, 1);
});

for (const activity of [{ sprint: true }, { slide: true }]) {
  test(`${Object.keys(activity)[0]} alone refreshes AFK activity`, (t) => {
    let now = 0;
    t.mock.method(performance, 'now', () => now);
    const { host } = setupHost(t);
    now = (AFK_SECONDS + 1) * 1000;
    host.tick(0);
    host.receiveIntent(activity);
    host.tick(1 / 30);
    assert.equal(host.coveredByBot, false);
    assert.equal(host.lastHumanInputTime, now / 1000);
  });
}

test('all five control schemes are complete and Arrow Classic is the default', () => {
  assert.equal(SCHEME_LIST.length, 5);
  assert.equal(DEFAULT_SCHEME, 'arrows');
  for (const scheme of SCHEME_LIST) {
    for (const action of ['pass', 'shoot', 'skill', 'through', 'sprint', 'camera']) {
      assert.ok(scheme.labels[action], `${scheme.id} missing ${action} label`);
    }
    assert.ok(scheme.keys.movement.length > 0, `${scheme.id} missing movement`);
  }
});

test('Arrow Classic binds arrows/WASD, Space, X, C and Z', (t) => {
  const env = setupInput(t);
  env.input.setScheme('arrows');
  env.key('keydown', 'ArrowUp');
  assert.equal(env.input.sample(1 / 60).moveZ, 1);
  env.key('keyup', 'ArrowUp');
  env.key('keydown', 'w');
  assert.equal(env.input.sample(1 / 60).moveZ, 1);
  env.key('keyup', 'w');
  env.time(100);
  env.key('keydown', ' ');
  env.time(500);
  env.key('keyup', ' ');
  assert.ok(env.input.sample(1 / 60).pass);
  env.time(1000);
  env.key('keydown', 'x');
  env.time(1500);
  env.key('keyup', 'x');
  assert.ok(env.input.sample(1 / 60).shoot);
});

test('Numpad preset accepts Numpad codes for actions', (t) => {
  const env = setupInput(t);
  env.input.setScheme('numpad');
  env.time(100);
  env.key('keydown', '2', { code: 'Numpad2' });
  env.time(400);
  env.key('keyup', '2', { code: 'Numpad2' });
  assert.ok(env.input.sample(1 / 60).shoot);
  env.key('keydown', 'ArrowDown');
  assert.equal(env.input.sample(1 / 60).moveZ, -1);
});

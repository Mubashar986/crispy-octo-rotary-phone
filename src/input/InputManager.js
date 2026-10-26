import { clamp } from '../core/math.js';
import { CONTROL_SCHEMES, DEFAULT_SCHEME } from '../config/controls.js';

const CHARGES = { pass: [0.35, 0.85], shoot: [0.25, 0.95], through: [0.25, 0.8] };
const IMMEDIATE = new Set(['camera', 'ping', 'chat', 'switch', 'call']);
const ACTIONS = ['pass', 'shoot', 'skill', 'through', 'switch', 'call', 'camera', 'ping', 'chat', 'closeControl', 'faceUp'];
const MODIFIERS = new Set(['closeControl', 'faceUp']);
const isEditable = (target) => !!(target?.isContentEditable || target?.closest?.('input, textarea, select'));
const eventTime = (e) => Number.isFinite(e.timeStamp) ? e.timeStamp : performance.now();

export class InputManager {
  constructor(refs) {
    this.refs = refs;
    this.active = false;
    this.scheme = CONTROL_SCHEMES[refs.scheme ?? DEFAULT_SCHEME] ?? CONTROL_SCHEMES[DEFAULT_SCHEME];
    this.keys = new Map();
    this.buttons = new Map();
    this.mousePresses = new Map();
    this.moveX = 0; this.moveZ = 0;
    this.joyActive = false; this.joyId = null; this.joySprint = false;
    this.queue = [];
    this.onCameraCycle = null;
    this.onPing = null;
    this.onChat = null;
    this.onSwitch = null;
    this.onCall = null;
    this.onSchemeChange = null;
    this._listeners = [];
    this.bind();
  }

  setScheme(id) {
    const next = CONTROL_SCHEMES[id];
    if (!next || next === this.scheme) return this.scheme;
    this.resetAll();
    this.scheme = next;
    this.onSchemeChange?.(next);
    return next;
  }

  setActive(active) {
    this.active = !!active;
    if (!this.active) this.resetAll();
  }

  isHeld(type) {
    return [...this.keys.values(), ...this.buttons.values(), ...this.mousePresses.values()]
      .some((press) => press.type === type);
  }

  heldSeconds(type) {
    const now = performance.now();
    let longest = 0;
    for (const press of [...this.keys.values(), ...this.buttons.values(), ...this.mousePresses.values()]) {
      if (press.type === type) longest = Math.max(longest, (now - press.startedAt) / 1000);
    }
    return longest;
  }

  canHandle(e) {
    return this.active && !document.hidden && !isEditable(e.target) && !isEditable(document.activeElement);
  }

  on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this._listeners.push([target, type, fn, opts]);
  }

  releaseCapture(el, id) {
    if (el?.hasPointerCapture?.(id)) el.releasePointerCapture(id);
  }

  actionFor(e) {
    const key = e.key?.toLowerCase();
    const code = e.code;
    for (const action of ACTIONS) {
      if (this.scheme.keys[action]?.includes(key)) return action;
      if (this.scheme.codes?.[action]?.includes(code)) return action;
    }
    if (this.scheme.keys.sprint.includes(key)) return 'sprint';
    if (this.scheme.keys.movement.includes(key)) return 'move';
    return null;
  }

  bind() {
    const r = this.refs;
    this.on(window, 'keydown', (e) => this.keydown(e));
    this.on(window, 'keyup', (e) => this.keyup(e));
    this.on(window, 'blur', () => this.resetAll());
    this.on(document, 'visibilitychange', () => { if (document.hidden) this.resetAll(); });
    this.on(document, 'focusin', (e) => { if (isEditable(e.target)) this.resetAll(); });

    const zone = r.joystickZone;
    if (zone) {
      this.on(zone, 'pointerdown', (e) => {
        if (!this.canHandle(e) || e.button > 0 || this.joyActive || this.buttons.has(e.pointerId)) return;
        e.preventDefault();
        this.joyId = e.pointerId; this.joyActive = true;
        zone.setPointerCapture?.(e.pointerId);
        this.updateJoystick(e);
      });
      this.on(zone, 'pointermove', (e) => {
        if (e.pointerId === this.joyId) this.updateJoystick(e);
      });
      const end = (e) => {
        if (e.pointerId !== this.joyId) return;
        this.joyId = null; this.joyActive = false; this.joySprint = false;
        this.moveX = 0; this.moveZ = 0;
        this.centerKnob();
        this.releaseCapture(zone, e.pointerId);
      };
      this.on(zone, 'pointerup', end);
      this.on(zone, 'pointercancel', end);
      this.on(zone, 'lostpointercapture', end);
    }

    const btn = (el, type) => {
      if (!el) return;
      this.on(el, 'pointerdown', (e) => {
        if (!this.canHandle(e) || e.button > 0 || e.pointerId === this.joyId || this.buttons.has(e.pointerId)) return;
        if ([...this.buttons.values()].some((press) => press.el === el)) return;
        e.preventDefault();
        this.buttons.set(e.pointerId, { el, type, startedAt: eventTime(e) });
        el.setPointerCapture?.(e.pointerId);
      });
      const end = (e, commit) => {
        const press = this.buttons.get(e.pointerId);
        if (!press || press.el !== el) return;
        this.buttons.delete(e.pointerId);
        if (commit && this.canHandle(e)) { e.preventDefault(); this.queueAction(press, e); }
        this.releaseCapture(el, e.pointerId);
      };
      this.on(el, 'pointerup', (e) => end(e, true));
      this.on(el, 'pointercancel', (e) => end(e, false));
      this.on(el, 'lostpointercapture', (e) => end(e, false));
    };
    btn(r.btnA, 'pass');
    btn(r.btnB, 'shoot');
    btn(r.btnC, 'skill');
    btn(r.btnD, 'through');
    btn(r.btnSprint, 'sprint');

    const canvas = r.canvas;
    if (canvas) {
      this.on(canvas, 'contextmenu', (e) => e.preventDefault());
      const actionForButton = (button) => {
        if (!this.scheme.mouse) return null;
        return Object.entries(this.scheme.mouse).find(([, b]) => b === button)?.[0] ?? null;
      };
      this.on(canvas, 'pointerdown', (e) => {
        if (!this.canHandle(e) || e.pointerType !== 'mouse') return;
        const type = actionForButton(e.button);
        if (!type) return;
        e.preventDefault();
        this.mousePresses.set(e.button, { type, startedAt: eventTime(e) });
      });
      const end = (e, commit) => {
        if (e.pointerType !== 'mouse') return;
        const press = this.mousePresses.get(e.button);
        if (!press) return;
        this.mousePresses.delete(e.button);
        if (commit && this.canHandle(e)) { e.preventDefault(); this.queueAction(press, e); }
      };
      this.on(canvas, 'pointerup', (e) => end(e, true));
      this.on(canvas, 'pointercancel', (e) => end(e, false));
    }
  }

  updateJoystick(e) {
    const rect = this.refs.joystickZone.getBoundingClientRect();
    const maxR = rect.width * 0.38;
    if (maxR <= 0) { this.moveX = 0; this.moveZ = 0; this.joySprint = false; this.centerKnob(); return; }
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    let dx = (e.clientX - cx) / maxR, dy = (e.clientY - cy) / maxR;
    const mag = Math.hypot(dx, dy);
    if (mag > 1) { dx /= mag; dy /= mag; }
    this.moveX = clamp(dx, -1, 1);
    this.moveZ = clamp(-dy, -1, 1);
    this.joySprint = mag > 0.92;
    const knob = this.refs.joystickKnob;
    if (knob) knob.style.transform = `translate(${dx * maxR}px, ${dy * maxR}px)`;
  }

  centerKnob() { if (this.refs.joystickKnob) this.refs.joystickKnob.style.transform = 'translate(0,0)'; }

  keydown(e) {
    const key = e.key.toLowerCase();
    const type = this.actionFor(e);
    if (!this.canHandle(e) || !type) return;
    if (type === 'move' || key === ' ' || MODIFIERS.has(type)) e.preventDefault();
    const id = e.code || key;
    if (e.repeat || this.keys.has(id)) return;
    this.keys.set(id, { key, type, startedAt: eventTime(e) });
    if (type === 'camera') this.onCameraCycle?.();
    else if (type === 'ping') this.onPing?.();
    else if (type === 'chat') this.onChat?.();
    else if (type === 'switch') this.onSwitch?.();
    else if (type === 'call') this.onCall?.();
  }

  keyup(e) {
    const key = e.key.toLowerCase();
    const id = e.code || key;
    const press = this.keys.get(id);
    this.keys.delete(id);
    if (!this.canHandle(e)) { this.resetAll(); return; }
    if (!press) return;
    if (press.type === 'move' || press.key === ' ') e.preventDefault();
    if (press.type && !['move', 'sprint', ...IMMEDIATE].includes(press.type) && !MODIFIERS.has(press.type)) this.queueAction(press, e);
  }

  queueAction(press, e) {
    if (press.type === 'skill') this.queue.push({ tackle: true, slide: true });
    else if (CHARGES[press.type]) {
      const [base, rate] = CHARGES[press.type];
      const seconds = Math.max(0, eventTime(e) - press.startedAt) / 1000;
      this.queue.push({ [press.type]: true, [`${press.type}Power`]: clamp(base + seconds * rate, base, 1) });
    }
  }

  resetAll() {
    const joyId = this.joyId;
    const buttons = [...this.buttons];
    this.keys.clear(); this.buttons.clear(); this.mousePresses.clear();
    this.moveX = 0; this.moveZ = 0;
    this.joyActive = false; this.joyId = null; this.joySprint = false;
    this.queue.length = 0;
    this.centerKnob();
    if (joyId !== null) this.releaseCapture(this.refs.joystickZone, joyId);
    for (const [id, press] of buttons) this.releaseCapture(press.el, id);
  }

  sample(_dt) {
    if (!this.active || document.hidden || isEditable(document.activeElement)) {
      this.resetAll();
      return { moveX: 0, moveZ: 0, sprint: false };
    }
    const held = new Set([...this.keys.values()].map((press) => press.key));
    const movement = this.scheme.keys.movement;
    let mx = 0, mz = 0;
    if (this.joyActive) { mx = this.moveX; mz = this.moveZ; }
    else {
      mz = (movement.includes('w') || movement.includes('arrowup')) && (held.has('w') || held.has('arrowup')) ? 1 : 0;
      mz += (movement.includes('s') || movement.includes('arrowdown')) && (held.has('s') || held.has('arrowdown')) ? -1 : 0;
      mx = (movement.includes('d') || movement.includes('arrowright')) && (held.has('d') || held.has('arrowright')) ? 1 : 0;
      mx += (movement.includes('a') || movement.includes('arrowleft')) && (held.has('a') || held.has('arrowleft')) ? -1 : 0;
    }
    const sprint = this.joySprint || this.scheme.keys.sprint.some((k) => held.has(k)) ||
      [...this.buttons.values()].some((press) => press.type === 'sprint');
    const closeControl = this.isHeld('closeControl');
    const faceUp = this.isHeld('faceUp');
    // One completed command per sample preserves rapid presses and their order.
    const result = { moveX: mx, moveZ: mz, sprint, ...this.queue.shift() };
    // Keep the legacy sample shape unless a modifier is actually held.
    if (closeControl) result.closeControl = true;
    if (faceUp) result.faceUp = true;
    return result;
  }

  dispose() {
    this.setActive(false);
    for (const [t, ty, fn, o] of this._listeners) t.removeEventListener(ty, fn, o);
    this._listeners.length = 0;
  }
}

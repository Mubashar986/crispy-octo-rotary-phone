// WebAudio engine. Synthesised placeholders for now; M2 injects the extracted
// REAL_AUDIO buffers via setBuffers() and play() prefers them.
export class SoundEngine {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.buffers = new Map();
    this.crowdGain = null;
  }

  init() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.8;
    this.master.connect(this.ctx.destination);
  }

  setBuffers(map) { for (const [k, b] of Object.entries(map)) this.buffers.set(k, b); }

  startCharge() {
    if (!this.ctx || this.chargeOsc) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = 240;
    gain.gain.value = 0.035;
    osc.connect(gain).connect(this.master);
    osc.start();
    this.chargeOsc = osc;
    this.chargeGain = gain;
  }

  setCharge(power) {
    if (!this.chargeOsc || !this.ctx) return;
    this.chargeOsc.frequency.setTargetAtTime(220 + power * 760, this.ctx.currentTime, 0.03);
  }

  stopCharge() {
    if (!this.chargeOsc) return;
    try { this.chargeOsc.stop(); } catch { /* already stopped */ }
    this.chargeOsc.disconnect();
    this.chargeGain?.disconnect();
    this.chargeOsc = null;
    this.chargeGain = null;
  }

  play(name, opts = {}) {
    if (!this.enabled || !this.ctx) return;
    const buf = this.buffers.get(name);
    if (buf) {
      const src = this.ctx.createBufferSource();
      const g = this.ctx.createGain();
      g.gain.value = opts.gain ?? 0.9;
      src.buffer = buf;
      src.connect(g).connect(this.master);
      src.start();
      return;
    }
    this.synth(name, opts);
  }

  synth(name, { gain = 0.5 } = {}) {
    const c = this.ctx, t = c.currentTime;
    const g = c.createGain();
    g.connect(this.master);
    const osc = c.createOscillator();
    const noise = () => {
      const len = c.sampleRate * 0.25;
      const b = c.createBuffer(1, len, c.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const s = c.createBufferSource(); s.buffer = b; return s;
    };
    switch (name) {
      case 'kick': case 'PlayerPass': case 'PlayerShoot': case 'PlayerTouchTheBall': {
        const n = noise(); const f = c.createBiquadFilter();
        f.type = 'lowpass'; f.frequency.value = name === 'PlayerShoot' ? 900 : 1600;
        g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
        n.connect(f).connect(g); n.start(t); return;
      }
      case 'Whistle': case 'FirstWhistle': case 'FinalWhistle': {
        osc.type = 'square'; osc.frequency.value = 2300;
        g.gain.setValueAtTime(0.16, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
        osc.connect(g); osc.start(t); osc.stop(t + 0.42); return;
      }
      case 'Goal': {
        osc.type = 'sawtooth'; osc.frequency.setValueAtTime(320, t);
        osc.frequency.exponentialRampToValueAtTime(660, t + 0.3);
        g.gain.setValueAtTime(0.25, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
        osc.connect(g); osc.start(t); osc.stop(t + 0.95); return;
      }
      case 'PlayerTackled': case 'PlayerSlideTackle': {
        const n = noise(); const f = c.createBiquadFilter();
        f.type = 'bandpass'; f.frequency.value = 500;
        g.gain.setValueAtTime(gain * 0.8, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
        n.connect(f).connect(g); n.start(t); return;
      }
      default: {
        osc.type = 'sine'; osc.frequency.value = 700;
        g.gain.setValueAtTime(0.1, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
        osc.connect(g); osc.start(t); osc.stop(t + 0.12);
      }
    }
  }

  startCrowd() {
    if (!this.ctx || this.crowdGain) return;
    const len = this.ctx.sampleRate * 2;
    const b = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = b.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { last = last * 0.97 + (Math.random() * 2 - 1) * 0.03; d[i] = last * 3; }
    const src = this.ctx.createBufferSource(); src.buffer = b; src.loop = true;
    const f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 800; f.Q.value = 0.6;
    this.crowdGain = this.ctx.createGain(); this.crowdGain.gain.value = 0.05;
    src.connect(f).connect(this.crowdGain).connect(this.master);
    src.start();
  }

  setCrowdLevel(x) { if (this.crowdGain) this.crowdGain.gain.value = 0.04 + x * 0.12; }

  toggle() { this.enabled = !this.enabled; if (this.master) this.master.gain.value = this.enabled ? 0.8 : 0; return this.enabled; }
}

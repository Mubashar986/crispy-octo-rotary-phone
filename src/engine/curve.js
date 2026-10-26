import { clamp } from '../core/math.js';

// Unity AnimationCurve semantics: cubic Hermite between keyframes using each
// key's outSlope (leaving) and the next key's inSlope (arriving).
// m_PreInfinity/m_PostInfinity: 0 Loop, 1 PingPong, 2 Constant, 3 Linear.
export class AnimCurve {
  constructor(keys, pre = 2, post = 2) {
    this.keys = keys.slice().sort((a, b) => a.time - b.time);
    this.pre = pre;
    this.post = post;
  }

  static fromUnity(json) {
    if (!json) return AnimCurve.constant(0);
    if (typeof json === 'number') return AnimCurve.constant(json);
    const keys = (json.m_Curve || json.keys || []).map((k) => ({
      time: k.time, value: k.value, inSlope: k.inSlope ?? 0, outSlope: k.outSlope ?? 0
    }));
    return new AnimCurve(keys, json.m_PreInfinity ?? 2, json.m_PostInfinity ?? 2);
  }

  static constant(v) { return new AnimCurve([{ time: 0, value: v, inSlope: 0, outSlope: 0 }], 2, 2); }

  get first() { return this.keys[0]; }
  get last() { return this.keys[this.keys.length - 1]; }

  evaluate(t) {
    const k = this.keys;
    if (k.length === 0) return 0;
    if (k.length === 1) return k[0].value;
    if (t <= k[0].time) return this._outside(t, this.pre, true);
    if (t >= k[k.length - 1].time) return this._outside(t, this.post, false);

    let i = 0;
    while (i < k.length - 2 && t > k[i + 1].time) i++;
    const k0 = k[i], k1 = k[i + 1];
    const h = k1.time - k0.time;
    if (h <= 1e-9) return k1.value;
    const x = (t - k0.time) / h;
    const x2 = x * x, x3 = x2 * x;
    const h00 = 2 * x3 - 3 * x2 + 1;
    const h10 = x3 - 2 * x2 + x;
    const h01 = -2 * x3 + 3 * x2;
    const h11 = x3 - x2;
    return h00 * k0.value + h10 * h * k0.outSlope + h01 * k1.value + h11 * h * k1.inSlope;
  }

  _outside(t, mode, isPre) {
    const k = this.keys;
    const edge = isPre ? k[0] : k[k.length - 1];
    if (mode === 2) return edge.value;                       // Constant
    if (mode === 3) {                                         // Linear
      const slope = isPre ? edge.inSlope : edge.outSlope;
      return edge.value + (t - edge.time) * slope;
    }
    const span = k[k.length - 1].time - k[0].time;
    if (span <= 1e-9) return edge.value;
    let u = (t - k[0].time) / span;
    if (mode === 0) u = u - Math.floor(u);                    // Loop
    else if (mode === 1) {                                    // PingPong
      u = u - Math.floor(u);
      const cycle = Math.floor((t - k[0].time) / span);
      if (cycle % 2 !== 0) u = 1 - u;
    }
    return this.evaluate(k[0].time + u * span + 1e-6);
  }
}

export const evalCurve = (curve, t) => (curve ? curve.evaluate(t) : 0);
export const clampCurveInput = (curve, t) => evalCurve(curve, clamp(t, curve.first.time, curve.last.time));

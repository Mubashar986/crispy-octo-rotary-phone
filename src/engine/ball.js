import { EngineSettings as S, GRAVITY } from './settings.js';
import { clamp, clamp01 } from '../core/math.js';
import * as V from './vec.js';

const DEG = Math.PI / 180;
const EPS = 1e-5;

export const BALL_RADIUS = 0.11;
const GROUND_RESTITUTION = 0.42;
const GROUND_FRICTION = 0.30;
const AIR_DRAG = 0.055;
const MAGNUS = 0.0016;
const SPIN_AIR_DECAY = 0.55;   // original only decayed spin on bounce (D16); decay in flight too
const SPIN_BOUNCE_DECAY = 0.92;

export class Ball {
  constructor(match) {
    this.match = match;
    this.pos = V.v3(0, BALL_RADIUS, 0);
    this.prevPos = V.copy(this.pos);
    this.vel = V.v3();
    this.spin = V.v3();
    this.holder = null;
    this.heldInHands = false;
    this.lastTouch = null;
    this.lastTouchTeam = -1;
    this.inCrossMode = false;
    this.crossTarget = null;
    this.nextCollisionTime = 0;
    this.nextDribbleTouch = 0;
    this.dribblePulse = 0;
    this.ignoreHitter = null;
    this.ignoreHitterUntil = 0;
    this.intendedReceiverId = null;
    this.intendedReceiverUntil = 0;
    this.lastPass = null;
    this.lastShot = null;
    this.lastShotXG = null;
    this.lastKickBy = null;
    this.lastKickAt = -10;
    this.lastKickKind = null;
  }

  reset(pos) {
    V.set(this.pos, pos.x, Math.max(BALL_RADIUS, pos.y ?? BALL_RADIUS), pos.z);
    this.prevPos = V.copy(this.pos);
    V.set(this.vel, 0, 0, 0);
    V.set(this.spin, 0, 0, 0);
    this.release();
    this.inCrossMode = false;
    this.crossTarget = null;
    this.lastTouch = null;
    this.lastTouchTeam = -1;
    this.ignoreHitter = null;
    this.ignoreHitterUntil = 0;
    this.intendedReceiverId = null;
    this.intendedReceiverUntil = 0;
    this.lastPass = null;
    this.lastShot = null;
    this.lastShotXG = null;
    this.lastKickBy = null;
    this.lastKickAt = -10;
    this.lastKickKind = null;
    this.nextDribbleTouch = 0;
    this.dribblePulse = 0;
    this.dribbleSide = 1;
    this.lastDribbleTouchAt = 0;
  }

  get speed() { return V.len(this.vel); }
  get isLoose() { return this.holder === null; }

  // Ball.calcBallisticVelocityVector — exact Ghidra form. The launch direction is
  // ELEVATED: unit dir = (dx, horiz*tan(a), dz) / slant, not normalize(target-source).
  calcBallisticVelocityVector(source, target, angleDeg) {
    const dx = target.x - source.x;
    const dz = target.z - source.z;
    const dy = target.y - source.y;
    const a = angleDeg * DEG;
    const tan = Math.tan(a);
    const sin2 = Math.sin(2 * a);
    if (Math.abs(sin2) < EPS || Math.abs(tan) < EPS) return V.v3();
    const horiz = Math.hypot(dx, dz);
    const rise = horiz * tan;
    const slant = Math.hypot(dx, dz, rise);
    if (slant < EPS) return V.v3();
    const inner = ((horiz + (dy * 0.5) / tan) * GRAVITY) / sin2;
    if (inner <= 0) return V.v3();
    const speed = Math.sqrt(inner);
    return V.v3(dx / slant * speed, rise / slant * speed, dz / slant * speed);
  }

  // Ball.GetDirectionError — two INDEPENDENT sign draws, applied to pitch AND yaw.
  getDirectionError(velocityMagnitude, skill, maxAngleError = 90) {
    if (!S.IsDirectionErrorEnabled) return { pitch: 0, yaw: 0 };
    const mag =
      S.DirectionErrorModByVelocityCurve.evaluate(velocityMagnitude) *
      S.DirectionErrorSkillModCurve.evaluate(skill / 100) *
      0.25;
    const capped = Math.min(mag, maxAngleError);
    return {
      pitch: this.match.rng.sign() * capped * DEG,
      yaw: this.match.rng.sign() * capped * DEG
    };
  }

  // Ball.ApplyError — rotates direction only, never range.
  applyError(target, skill) {
    const dir = V.sub(target, this.pos);
    const L = V.len(dir);
    if (L < EPS) return target;
    const n = V.normalize(dir);
    const err = this.getDirectionError(L, skill);
    const cy = Math.cos(err.yaw), sy = Math.sin(err.yaw);
    const yawed = V.v3(n.x * cy + n.z * sy, n.y, -n.x * sy + n.z * cy);
    const cp = Math.cos(err.pitch), sp = Math.sin(err.pitch);
    const rotated = V.v3(yawed.x, yawed.y * cp - yawed.z * sp, yawed.y * sp + yawed.z * cp);
    return V.add(this.pos, V.scale(rotated, L));
  }

  // Ball.ClampVelocity — a MINIMUM, not a maximum.
  clampVelocity(v) {
    const l = V.len(v);
    if (l < EPS) return V.withLength(V.v3(1, 0, 0), S.Ball_MinHitVelocity);
    return l < S.Ball_MinHitVelocity ? V.withLength(v, S.Ball_MinHitVelocity) : v;
  }

  ballHit(hitter, velocity, ignoreOffside = false) {
    this.vel = this.clampVelocity(velocity);
    this.intendedReceiverId = null;
    this.intendedReceiverUntil = 0;
    this.lastPass = null;
    this.spin = V.v3(this.match.rng.range(-3, 3), this.match.rng.range(-14, 14), this.match.rng.range(-3, 3));
    if (this.holder) this.release();
    this.lastTouch = hitter;
    this.lastTouchTeam = hitter ? hitter.team : -1;
    this.lastKickBy = hitter;
    this.lastKickAt = this.match.time;
    this.lastKickKind = 'kick';
    this.ignoreHitter = hitter;
    this.ignoreHitterUntil = this.match.time + 0.25;
    if (hitter) {
      if (hitter.kickTimer <= 0) {
        hitter.kickTimer = 0.32;
        hitter.animMode = 'KICK';
      }
      hitter.pendingStrike = null;
      hitter.ballContactReadyAt = this.match.time + 0.25;
      hitter.isThrowHolder = false;
      hitter.isGoalKickHolder = false;
    }
    if (hitter) this.match.events.emit('PlayerTouchTheBall', { player: hitter, speed: V.len(this.vel) });
    this.match.assignOffsides(hitter, ignoreOffside);
  }

  hold(player, inHands = false) {
    this.holder = player;
    this.heldInHands = inHands;
    this.lastTouch = player;
    this.lastTouchTeam = player.team;
    this.ignoreHitter = null;
    this.ignoreHitterUntil = 0;
    player.ballHoldTime = 0;
    player.holdWarned = false;
    player.pendingDistribution = null;
    this.inCrossMode = false;
    this.crossTarget = null;
    this.intendedReceiverId = null;
    this.intendedReceiverUntil = 0;
    this.nextDribbleTouch = this.match.time + 0.06;
    this.lastDribbleTouchAt = this.match.time;
    this.dribblePulse = 0;
    this.dribbleSide = 1;
    if (inHands) {
      V.set(this.vel, 0, 0, 0);
      V.set(this.spin, 0, 0, 0);
      this.pos = V.addScaled(player.pos, V.fromHeading(player.facing), 0.42);
      this.pos.y = 1.08;
    }
  }

  // The receiver owns the ball logically, but the ball rolls to a cushion point.
  // Control quality decides how close it settles and how much pace survives.
  firstTouch(player, quality = 0.8, pressure = 0, opponent = null) {
    const q = clamp01(quality);
    this.hold(player, false);
    const forward = V.fromHeading(player.facing);
    const right = V.v3(-forward.z, 0, forward.x);
    const mode = player.moveMode ?? 2;
    this.dribbleSide = -this.dribbleSide || 1;
    let distance = 0.26 + q * 0.2 + (mode === 3 ? 0.18 : mode === 1 ? -0.04 : 0);
    if (player.speed > 1.5) distance += Math.min(0.45, player.speed * 0.05) * (mode === 3 ? 1.35 : 1);
    const sideOffset = (mode === 0 ? 0.12 : 0.07) * this.dribbleSide;
    const error = (1 - q) * 0.45 + pressure * 0.1;
    let touchDir = forward;
    if (opponent) {
      const gap = V.distXZ(player.pos, opponent.pos);
      if (gap < 1.8) {
        const away = V.normalizeXZ(V.sub(player.pos, opponent.pos));
        const blend = player.speed < 0.6 ? 0.85 : 0.45;
        touchDir = V.normalizeXZ(V.addScaled(forward, away, blend));
        if (player.speed < 0.6) distance = Math.min(distance, 0.3);
      }
    }
    const target = V.addScaled(player.pos, touchDir, distance);
    target.x += right.x * sideOffset + this.match.rng.range(-error, error);
    target.z += right.z * sideOffset + this.match.rng.range(-error, error);
    target.y = BALL_RADIUS;
    const dx = target.x - this.pos.x;
    const dz = target.z - this.pos.z;
    const k = 2.8 + q * 2.6;
    this.vel.x = this.vel.x * 0.22 + dx * k + player.vx * 0.75;
    this.vel.z = this.vel.z * 0.22 + dz * k + player.vz * 0.75;
    const speed = Math.hypot(this.vel.x, this.vel.z);
    if (speed > 9) { this.vel.x *= 9 / speed; this.vel.z *= 9 / speed; }
    this.vel.y = 0;
    this.spin.y = this.match.rng.range(-1, 1) * error * 5;
    this.nextDribbleTouch = this.match.time + 0.16;
    this.lastDribbleTouchAt = this.match.time;
    this.dribblePulse = 1;
    return true;
  }

  release() { this.holder = null; this.heldInHands = false; }

  // A skill-move touch that rolls the ball sideways while keeping possession.
  nudge(player, dx, dz, speed = 3.4) {
    if (this.holder !== player) return false;
    const dir = V.normalizeXZ(V.v3(dx, 0, dz));
    if (V.lenXZ(dir) < 0.1) return false;
    this.vel.x = dir.x * speed + player.vx * 0.35;
    this.vel.z = dir.z * speed + player.vz * 0.35;
    this.vel.y = 0;
    this.spin.y = this.match.rng.range(-1, 1) * 2;
    this.nextDribbleTouch = this.match.time + 0.22;
    this.lastDribbleTouchAt = this.match.time;
    this.dribblePulse = 1;
    return true;
  }

  // Ball.Pass — distance-weighted Passing/LongBall blend, then power scale.
  pass(target, hitter, speedMod = 1, ignoreOffside = false) {
    this.inCrossMode = false;
    this.crossTarget = null;
    const d = V.dist(target, this.pos);
    const pct = Math.min(1, Math.max(0, (d - S.LongBallSkillActivationDistanceMin) /
      (S.LongBallSkillActivationDistanceMax - S.LongBallSkillActivationDistanceMin)));
    const skill = pct * hitter.skills.passing + (1 - pct) * hitter.skills.longBall;
    const aim = this.applyError(target, skill);
    const height = S.passHeightDistanceCurve.evaluate(d);
    let v = this.calcBallisticVelocityVector(this.pos, aim, height);
    v = V.scale(v, S.PassPowerDistanceCurve.evaluate(d) * speedMod);
    this.ballHit(hitter, v, ignoreOffside);
    this.lastPass = { team: hitter.team, passerId: hitter.id, at: this.match.time, kind: 'pass' };
    this.match.recordPassAttempt(hitter, 'pass');
    this.match.events.emit('PlayerPass', { player: hitter, power: V.len(v), kind: hitter.lastPassKind ?? 'pass' });
    this.match.delayBehaviourSelectionByReaction(hitter);
    return v;
  }

  velocityForFlightTime(target, flightTime) {
    // Invert the same damped, semi-implicit steps used by the 120 Hz ball simulation.
    const dt = 1 / 120;
    const steps = Math.max(1, Math.round(flightTime / dt));
    const decay = Math.exp(-AIR_DRAG * dt);
    const travelFactor = dt * decay * (1 - Math.pow(decay, steps)) / (1 - decay);
    const gravityDrop = GRAVITY * dt * decay / (1 - decay) * (steps * dt - travelFactor);
    return V.v3(
      (target.x - this.pos.x) / travelFactor,
      (target.y - this.pos.y + gravityDrop) / travelFactor,
      (target.z - this.pos.z) / travelFactor
    );
  }

  cross(target, hitter, ignoreOffside = false, requestedFlightTime = null) {
    const margin = 4;
    const aim = this.applyError(target, hitter.skills.longBall);
    aim.x = Math.max(-this.match.fieldHalfX + margin, Math.min(this.match.fieldHalfX - margin, aim.x));
    aim.z = Math.max(-this.match.fieldHalfZ + margin, Math.min(this.match.fieldHalfZ - margin, aim.z));
    aim.y = BALL_RADIUS;
    const flightTime = requestedFlightTime ?? Math.max(0.85, Math.min(2.6, 0.6 + V.distXZ(this.pos, aim) / 20));
    const v = this.velocityForFlightTime(aim, flightTime);
    this.inCrossMode = true;
    this.crossTarget = V.copy(aim);
    this.ballHit(hitter, v, ignoreOffside);
    this.spin.x = 0;
    this.spin.z = 0;
    this.lastPass = { team: hitter.team, passerId: hitter.id, at: this.match.time, kind: 'cross' };
    this.match.recordPassAttempt(hitter, 'cross');
    this.spin.y = 0;
    if (hitter.isGoalKeeper) this.ignoreHitterUntil = this.match.time + flightTime + 0.3;
    this.match.events.emit('PlayerCross', { player: hitter, target: V.copy(aim), flightTime });
    this.match.delayBehaviourSelectionByReaction(hitter);
    return v;
  }

  throwTo(target, hitter, power = 1, ignoreOffside = true) {
    this.inCrossMode = false;
    this.crossTarget = null;
    this.pos.x = Math.max(-this.match.fieldHalfX + BALL_RADIUS, Math.min(this.match.fieldHalfX - BALL_RADIUS, this.pos.x));
    this.pos.z = Math.max(-this.match.fieldHalfZ + BALL_RADIUS, Math.min(this.match.fieldHalfZ - BALL_RADIUS, this.pos.z));
    const aim = V.copy(target);
    aim.x = Math.max(-this.match.fieldHalfX + 2, Math.min(this.match.fieldHalfX - 2, aim.x));
    aim.z = Math.max(-this.match.fieldHalfZ + 2, Math.min(this.match.fieldHalfZ - 2, aim.z));
    aim.y = BALL_RADIUS;
    const distance = V.distXZ(this.pos, aim);
    const flightTime = Math.max(0.55, Math.min(1.8, distance / 15));
    const v = this.velocityForFlightTime(aim, flightTime);
    this.ballHit(hitter, V.scale(v, power), ignoreOffside);
    this.spin.x = 0;
    this.spin.z = 0;
    this.lastKickKind = 'throw';
    this.lastPass = null;
    this.spin.y = 0;
    if (hitter) {
      hitter.animMode = 'THROW';
      hitter.kickTimer = 0.5;
      hitter.ballContactReadyAt = this.match.time + 0.35;
    }
    this.match.events.emit('PlayerThrowIn', { player: hitter, target: aim, flightTime });
    return v;
  }

  shoot(velocity, hitter) {
    this.inCrossMode = false;
    this.crossTarget = null;
    this.ballHit(hitter, velocity, true);
    this.match.events.emit('PlayerShoot', { player: hitter, power: V.len(velocity), xg: hitter.lastShotXG ?? null });
    this.match.delayBehaviourSelectionByReaction(hitter);
  }

  // Ball.Predicter — where will the ball be when I can get there.
  predicter(requester, relaxation = 0) {
    const reach = requester.topSpeed * (1 + relaxation * 0.3);
    let p = V.copy(this.pos), v = V.copy(this.vel);
    const dt = 1 / 30;
    for (let t = 0; t < 2.5; t += dt) {
      const d = V.distXZ(p, requester.pos);
      if (d <= reach * t + 0.6) return { point: p, time: t };
      v.y -= GRAVITY * dt;
      v = V.scale(v, 1 - AIR_DRAG * dt);
      p = V.add(p, V.scale(v, dt));
      if (p.y < BALL_RADIUS) { p.y = BALL_RADIUS; v.y = -v.y * GROUND_RESTITUTION; v.x *= 0.8; v.z *= 0.8; }
    }
    return { point: p, time: 2.5 };
  }

  // Ball.HolderBehave — speed-dependent dribble touches with shielding and lag.
  // Possession is logical; the ball only moves on planned touches. This keeps
  // it loose enough to be poked away instead of being welded to a lead point.
  updateDribble(dt) {
    const p = this.holder;
    if (this.heldInHands) {
      this.pos = V.addScaled(p.pos, V.fromHeading(p.facing), 0.42);
      this.pos.y = 1.08;
      return;
    }
    if (p.stunned) { this.release(); return; }
    const time = this.match.time;
    this.dribblePulse = Math.max(0, this.dribblePulse - dt * 4.2);
    if (p.pendingStrike) {
      const lead = V.addScaled(p.pos, V.fromHeading(p.facing), 0.3);
      this.vel.x += (lead.x - this.pos.x) * 12 * dt;
      this.vel.z += (lead.z - this.pos.z) * 12 * dt;
      this.vel.x *= Math.exp(-2.2 * dt);
      this.vel.z *= Math.exp(-2.2 * dt);
      return;
    }
    const speed = p.speed ?? 0;
    const mode = p.moveMode ?? 2;
    const dist = V.distXZ(this.pos, p.pos);
    const controlRadius = 0.95 + speed * 0.16 + (mode === 3 ? 0.45 : mode === 1 ? -0.08 : mode === 0 ? 0.15 : 0);
    if (dist > controlRadius * 1.7 && time - this.lastDribbleTouchAt > 0.35) {
      const player = p;
      this.release();
      this.match.events.emit('PossessionLost', { player, ball: this });
      return;
    }
    const due = time >= this.nextDribbleTouch;
    const needsTouch = dist > 0.56 || speed > 0.35;
    if (due && needsTouch) this.dribbleTouch(p, speed, mode);
  }

  dribbleTouch(p, speed, mode) {
    const forward = speed > 0.6 ? V.normalizeXZ(V.v3(p.vx, 0, p.vz)) : V.fromHeading(p.facing);
    const right = V.v3(-forward.z, 0, forward.x);
    this.dribbleSide = -this.dribbleSide || 1;
    const pressure = this.match.nearestOpponentDistance(p);
    const pressured = pressure < 1.5;
    const modeFactor = mode === 3 ? 1.35 : mode === 1 ? 0.72 : mode === 0 ? 0.62 : 1;
    let distance = (0.24 + speed * 0.10) * modeFactor;
    if (pressured) distance *= 0.85;
    distance = clamp(distance, 0.24, 1.75);
    const skill = (p.skills.ballControl ?? 50) / 100;
    const error = (1 - skill) * 0.18 + (pressured ? 0.08 : 0);
    const target = V.addScaled(p.pos, forward, distance);
    target.x += right.x * (pressured && mode === 0 ? 0.14 : 0.06) * this.dribbleSide + this.match.rng.range(-error, error);
    target.z += right.z * (pressured && mode === 0 ? 0.14 : 0.06) * this.dribbleSide + this.match.rng.range(-error, error);
    const dx = target.x - this.pos.x;
    const dz = target.z - this.pos.z;
    const travel = clamp(distance / Math.max(3.5, 4 + speed * 0.6), 0.12, 0.3);
    const vx = dx / travel;
    const vz = dz / travel;
    const vlen = Math.hypot(vx, vz) || 1;
    const cap = 12;
    const scale = vlen > cap ? cap / vlen : 1;
    this.vel.x = p.vx + vx * scale;
    this.vel.z = p.vz + vz * scale;
    this.vel.y = 0;
    this.spin.y = this.match.rng.range(-1, 1) * error * 4;
    this.nextDribbleTouch = this.match.time + clamp(0.46 - speed * 0.02, 0.24, 0.4) *
      (mode === 1 ? 0.8 : mode === 0 ? 0.9 : 1);
    this.lastDribbleTouchAt = this.match.time;
    this.dribblePulse = 1;
    this.ignoreHitter = p;
    this.ignoreHitterUntil = this.match.time + 0.08;
    this.lastTouch = p;
    this.lastTouchTeam = p.team;
    this.lastKickBy = p;
    this.lastKickKind = 'dribble';
    this.lastKickAt = this.match.time;
    this.match.events.emit('PlayerDribbleTouch', { player: p, speed: Math.hypot(this.vel.x, this.vel.z) });
  }

  step(dt) {
    this.prevPos = V.copy(this.pos);
    if (this.holder) {
      this.updateDribble(dt);
      if (this.heldInHands) return;
    }

    // Magnus across all three spin axes (sidespin, topspin and backspin).
    const magnus = V.v3(
      this.vel.y * this.spin.z - this.vel.z * this.spin.y,
      this.vel.z * this.spin.x - this.vel.x * this.spin.z,
      this.vel.x * this.spin.y - this.vel.y * this.spin.x
    );
    this.vel = V.add(this.vel, V.scale(magnus, MAGNUS * 30 * dt));
    this.spin = V.scale(this.spin, Math.exp(-SPIN_AIR_DECAY * dt));

    this.vel.y -= GRAVITY * dt;
    this.vel = V.scale(this.vel, Math.exp(-AIR_DRAG * dt));
    this.pos = V.add(this.pos, V.scale(this.vel, dt));

    if (this.pos.y < BALL_RADIUS) {
      this.pos.y = BALL_RADIUS;
      if (this.vel.y < 0) this.vel.y = -this.vel.y * GROUND_RESTITUTION;
      if (Math.abs(this.vel.y) < 0.4) this.vel.y = 0;
      this.vel.x *= Math.exp(-GROUND_FRICTION * dt * 8);
      this.vel.z *= Math.exp(-GROUND_FRICTION * dt * 8);
      this.spin = V.scale(this.spin, Math.pow(SPIN_BOUNCE_DECAY, dt * 30));
      // Settle towards the rolling angular velocity; removes skating spin.
      const rollX = -this.vel.z / BALL_RADIUS;
      const rollZ = this.vel.x / BALL_RADIUS;
      const rollK = 1 - Math.exp(-5 * dt);
      this.spin.x += (rollX - this.spin.x) * rollK;
      this.spin.z += (rollZ - this.spin.z) * rollK;
      this.spin.y *= Math.exp(-1.6 * dt);
      this.inCrossMode = false;
    }
    if (!Number.isFinite(this.pos.x + this.pos.y + this.pos.z)) this.reset(V.v3(0, BALL_RADIUS, 0));
  }
}

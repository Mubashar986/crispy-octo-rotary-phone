import * as V from './vec.js';
import { clamp, clamp01 } from '../core/math.js';
import { EngineSettings as S } from './settings.js';

export const TeamBehaviour = { Defending: 0, Attacking: 1, BallChasing: 2, WaitingForTeamGK: 3, WaitingForOpponentGK: 4, TeamThrowIn: 5, OpponentThrowIn: 6 };

// BehaviourPreset knobs (recovered field set; values calibrated per tactic).
export const TACTIC_PRESETS = {
  ParkTheBus: { DefenceAttackSlider: 0.18, playCloseToBall: 0.58, chase: 1, press: 0.30, width: 0.74, depth: 0.78, lineHeight: 0.30 },
  Defensive: { DefenceAttackSlider: 0.34, playCloseToBall: 0.50, chase: 1, press: 0.40, width: 0.82, depth: 0.86, lineHeight: 0.38 },
  CounterAttack: { DefenceAttackSlider: 0.46, playCloseToBall: 0.42, chase: 2, press: 0.55, width: 0.88, depth: 0.92, lineHeight: 0.42 },
  Balanced: { DefenceAttackSlider: 0.50, playCloseToBall: 0.38, chase: 2, press: 0.60, width: 0.94, depth: 1.0, lineHeight: 0.48 },
  HighPressure: { DefenceAttackSlider: 0.66, playCloseToBall: 0.48, chase: 3, press: 0.82, width: 0.90, depth: 0.98, lineHeight: 0.60 },
  Offensive: { DefenceAttackSlider: 0.80, playCloseToBall: 0.45, chase: 3, press: 0.90, width: 1.04, depth: 1.06, lineHeight: 0.66 }
};

export class Team {
  constructor(match, id, opts = {}) {
    this.match = match;
    this.id = id;
    this.players = [];
    this.bench = [];
    this.subsUsed = 0;
    this.subWindowsUsed = 0;
    this.subWindowOpen = false;
    this.formationId = opts.formation ?? null;
    this.formation = null;
    this.tactic = opts.tactic ?? 'Balanced';
    this.behaviour = TeamBehaviour.BallChasing;
    this.ballProgress = 0.5;
    this.offsideLine = 0;
    this.chaser = null;
    this.pressers = [];
    this.presser = null;
    this.cover = null;
    this.phase = 'LOOSE';
    this.previousPhase = 'LOOSE';
    this.transitionUntil = -1;
    this.markUpdateAt = 0;
    this.oneTwo = null;
  }

  get preset() { return TACTIC_PRESETS[this.tactic]; }
  get ownGoal() { return this.match.goalNets[this.id]; }
  get attackGoal() { return this.match.goalNets[1 - this.id]; }
  get dir() { return Math.sign(this.attackGoal.x - this.ownGoal.x) || 1; }

  addPlayer(p) { p.team = this.id; p.match = this.match; this.players.push(p); return p; }
  get fielders() { return this.players.filter((p) => !p.isGoalKeeper && !p.sentOff); }

  // GameTeam.Behave: |ball.x - ownGoal.x| / fieldLength
  updateProgress() {
    const L = this.match.fieldLength;
    this.ballProgress = clamp01(Math.abs(this.match.ball.pos.x - this.ownGoal.x) / L);
    const holder = this.match.ball.holder;
    this.previousPhase = this.phase;
    this.phase = !holder ? 'LOOSE' : holder.team === this.id ? 'IN_POSSESSION' : 'OUT_OF_POSSESSION';
    if (this.phase !== this.previousPhase && (this.phase === 'IN_POSSESSION' || this.previousPhase === 'IN_POSSESSION')) {
      this.transitionUntil = this.match.time + 1.4;
    }
    this.behaviour = !holder ? TeamBehaviour.BallChasing
      : holder.team === this.id ? TeamBehaviour.Attacking
        : TeamBehaviour.Defending;
    this.pressers = this.computePressers();
    this.presser = this.pressers[0] ?? null;
    this.cover = this.pressers[1] ?? null;
    this.chaser = this.presser;
    this.offsideLine = this.match.computeOffsideLine(this);
    if (this.oneTwo && (this.phase !== 'IN_POSSESSION' || this.match.time > this.oneTwo.until)) this.oneTwo = null;
    if (this.match.time >= this.markUpdateAt) {
      this.assignMarking();
      this.markUpdateAt = this.match.time + 0.6;
    }
  }

  get inPossession() { return this.phase === 'IN_POSSESSION'; }
  get outOfPossession() { return this.phase === 'OUT_OF_POSSESSION'; }
  get inTransition() { return this.match.time < this.transitionUntil; }

  computePressers() {
    const quota = this.outOfPossession ? this.preset.chase : Math.max(1, this.preset.chase - 1);
    return this.fielders
      .filter((p) => this.match.time >= p.stunnedUntil)
      .map((p) => ({ p, d: V.distXZ(p.pos, this.match.ball.pos) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, quota)
      .map((entry) => entry.p);
  }

  computeChaser() { return this.computePressers()[0] ?? null; }

  assignMarking() {
    const opponents = this.match.teams[1 - this.id].fielders
      .slice()
      .sort((a, b) => Math.abs(a.pos.x - this.ownGoal.x) - Math.abs(b.pos.x - this.ownGoal.x));
    const defenders = this.fielders.slice().sort((a, b) => (a.anchor?.v ?? 0.5) - (b.anchor?.v ?? 0.5));
    const claimed = new Set();
    for (const defender of defenders) {
      let best = null, bestCost = Infinity;
      for (const opponent of opponents) {
        if (claimed.has(opponent.id)) continue;
        const distance = V.distXZ(defender.pos, opponent.pos);
        const danger = 1 - clamp01(Math.abs(opponent.pos.x - this.ownGoal.x) / this.match.fieldLength);
        const cost = distance - danger * 8;
        if (cost < bestCost) { bestCost = cost; best = opponent; }
      }
      if (best) claimed.add(best.id);
      defender.markingTarget = best;
    }
  }

  // TeamTactics.GetFieldPosition — phase shape first, then ball attraction and marking.
  getFieldPosition(p, globalBallProgress) {
    const m = this.match;
    const inPoss = this.inPossession;
    const base = (inPoss ? p.anchorIn : p.anchorOut) ?? p.anchor ?? { h: 0.5, v: 0.5, band: 'CM' };
    const preset = this.preset;
    const dir = this.dir;
    const ownX = this.ownGoal.x;

    const width = preset.width * (inPoss ? 1.05 : 0.88);
    const h = clamp01(0.5 + (base.h - 0.5) * width);
    let v = base.v;

    if (inPoss) {
      v += (preset.DefenceAttackSlider - 0.5) * 0.28 + (this.ballProgress - 0.5) * 0.20;
      if (base.band === 'CB') v = Math.min(v, 0.46 + this.ballProgress * 0.14);
      if (base.band === 'ST') v = Math.max(v, 0.56 + this.ballProgress * 0.12);
    } else if (this.outOfPossession) {
      v += (preset.DefenceAttackSlider - 0.5) * 0.16 - (this.ballProgress - 0.5) * 0.10;
      if (base.band === 'ST') v = Math.min(v, 0.60);
      if (base.band === 'CM') v = Math.min(v, 0.52);
    }
    v = clamp01(v);

    let x = ownX + dir * v * m.fieldLength;
    let z = (h - 0.5) * m.fieldWidth;

    // Ball-side shift keeps the block compact instead of spread across the full width.
    z += (m.ball.pos.z - z) * (inPoss ? 0.20 : 0.34);
    const attract = preset.playCloseToBall;
    x += (m.ball.pos.x - x) * attract * (inPoss ? 0.34 : 0.24);
    z += (m.ball.pos.z - z) * attract * (inPoss ? 0.48 : 0.36);

    if (p.markingTarget && this.outOfPossession) {
      const mt = p.markingTarget.pos;
      const goalSide = Math.sign(ownX - mt.x) || -dir;
      x += (mt.x + goalSide * 1.4 - x) * 0.30;
      z += (mt.z - z) * 0.38;
    }

    x = clamp(x, -m.fieldHalfX + 1, m.fieldHalfX - 1);
    z = clamp(z, -m.fieldHalfZ + 0.8, m.fieldHalfZ - 0.8);
    return V.v3(x, 0, z);
  }

  // BehaviourPreset.HowManyPlayersWillChaseTheBall
  chaseQuota() { return this.preset.chase; }
}

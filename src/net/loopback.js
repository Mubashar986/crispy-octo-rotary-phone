import { Match } from '../engine/match.js';
import { FixedClock } from '../core/clock.js';
import * as V from '../engine/vec.js';

export const AFK_SECONDS = 15;

// Owns the local Match and delivers input on its fixed-step clock.
export class LocalMatchHost {
  constructor(cfg, opts = {}) {
    this.cfg = cfg;
    this.opts = opts;
    this.match = new Match(cfg, opts);
    this.clock = new FixedClock(1 / 30);
    this.prevSnapshot = this.match.getSnapshot();
    this.latestSnapshot = this.prevSnapshot;
    this.alpha = 0;
    this.lastHumanInputTime = performance.now() / 1000;
    this.coveredByBot = false;
    this.controlMode = opts.controlMode === 'team' ? 'team' : 'player';
    this.autoSwitchReadyAt = 0;
    this.manualSwitchUntil = 0;
    this.pendingIntent = { moveX: 0, moveZ: 0, sprint: false };
    this.pendingActions = [];
    this.paused = false;
    this.spectating = false;
    this.humanId = this.match.players.find((p) => p.isHuman)?.id ?? null;
    this.match.events.on('Substitution', (ev) => {
      if (!ev.humanChanged) return;
      this.humanId = ev.incoming.id;
      this.spectating = false;
      this.resetInput();
    });
    this.match.events.on('PlayerSentOff', (ev) => {
      if (ev.player.id !== this.humanId) return;
      ev.player.isHuman = false;
      const teammates = this.match.teams[ev.player.team].players
        .filter((p) => !p.sentOff && p !== ev.player)
        .sort((a, b) => V.distXZ(a.pos, this.match.ball.pos) - V.distXZ(b.pos, this.match.ball.pos));
      const next = this.controlMode === 'team' ? teammates[0] : null;
      if (next) {
        next.isHuman = true;
        this.humanId = next.id;
        this.spectating = false;
        this.match.events.emit('PlayerSwitched', { playerId: next.id, role: next.role, manual: false });
      } else {
        this.humanId = null;
        this.spectating = true;
      }
      this.resetInput();
    });
  }

  setPaused(value) {
    this.paused = !!value;
    if (this.paused) this.resetInput();
  }

  startSecondHalf() {
    if (!this.match.startSecondHalf()) return false;
    this.setPaused(false);
    return true;
  }

  requestSubstitution(outId, inId) {
    const team = this.human?.team ?? this.match.players.find((p) => p.team === 0)?.team ?? 0;
    const result = this.match.substitute(team, outId, inId, this.match.phase === 'HALF_TIME');
    if (result.ok && result.humanChanged) this.humanId = this.match.players.find((p) => p.isHuman)?.id ?? this.humanId;
    return result;
  }

  requestFormation(formationId, rolePlan = null) {
    const team = this.human?.team ?? this.match.players.find((p) => p.team === 0)?.team ?? 0;
    return this.match.queueFormation(team, formationId, rolePlan);
  }

  requestTactic(tacticId) {
    const team = this.human?.team ?? this.match.players.find((p) => p.team === 0)?.team ?? 0;
    return this.match.setTeamTactic(team, tacticId);
  }

  requestGamePlan({ formationId, rolePlan = null, tactic }) {
    const tacticResult = tactic ? this.requestTactic(tactic) : { ok: true, unchanged: true };
    const shapeResult = formationId ? this.requestFormation(formationId, rolePlan) : { ok: true, applied: true };
    return { tactic: tacticResult, shape: shapeResult };
  }

  takeFreeKick(payload) { return this.match.takeFreeKick(payload); }

  takePenalty(payload) { return this.match.takePenalty(payload); }

  takePenaltyDefense(diveSide) { return this.match.takePenaltyDefense(diveSide); }

  cancelPenalty() { return this.match.cancelPenalty(); }

  get events() { return this.match.events; }

  get human() { return this.match.players.find((p) => p.id === this.humanId) ?? null; }

  switchTo(playerId, manual = false) {
    if (!playerId || playerId === this.humanId) return false;
    const current = this.human;
    const next = this.match.players.find((p) => p.id === playerId);
    if (!current || !next || next.team !== current.team || this.coveredByBot) return false;
    current.isHuman = false;
    current.intent = null;
    next.isHuman = true;
    next.intent = null;
    this.humanId = next.id;
    this.manualSwitchUntil = this.match.time + (manual ? 1.5 : 0);
    this.autoSwitchReadyAt = this.match.time + 0.8;
    this.lastHumanInputTime = performance.now() / 1000;
    this.resetInput();
    this.match.events.emit('PlayerSwitched', { playerId: next.id, role: next.role, manual });
    return true;
  }

  requestSwitch() {
    if (this.controlMode !== 'team' || this.coveredByBot) return false;
    const current = this.human;
    if (!current) return false;
    const ball = this.match.ball.pos;
    const sorted = this.match.teams[current.team].players
      .slice()
      .sort((a, b) => V.distXZ(a.pos, ball) - V.distXZ(b.pos, ball));
    const index = sorted.findIndex((p) => p.id === current.id);
    const next = sorted[(index + 1) % sorted.length];
    return next ? this.switchTo(next.id, true) : false;
  }

  requestCall() {
    const human = this.human;
    if (!human) return false;
    this.lastHumanInputTime = performance.now() / 1000;
    return this.match.callForPass(human);
  }

  autoSwitch() {
    if (this.controlMode !== 'team' || this.coveredByBot) return false;
    if (this.match.phase !== 'LIVE') return false;
    if (this.match.time < this.autoSwitchReadyAt || this.match.time < this.manualSwitchUntil) return false;
    const human = this.human;
    if (!human) return false;
    const team = this.match.teams[human.team];
    const holder = this.match.ball.holder;
    let target = null;
    if (holder && holder.team === team.id) {
      target = holder;
    } else {
      const nearOwnGoal = Math.abs(this.match.ball.pos.x - team.ownGoal.x) < this.match.fieldHalfX * 0.35;
      const candidates = team.players
        .filter((p) => p !== human && (nearOwnGoal || !p.isGoalKeeper))
        .sort((a, b) => V.distXZ(a.pos, this.match.ball.pos) - V.distXZ(b.pos, this.match.ball.pos));
      target = candidates[0] ?? null;
      if (target) {
        const dOld = V.distXZ(human.pos, this.match.ball.pos);
        const dNew = V.distXZ(target.pos, this.match.ball.pos);
        if (dOld - dNew < 3 && !(dOld > 8 && dNew < 4)) return false;
      }
    }
    if (!target || target.id === this.humanId) return false;
    return this.switchTo(target.id, false);
  }

  receiveIntent(intent) {
    const hasAction = intent && (intent.pass || intent.shoot || intent.tackle || intent.slide || intent.through || intent.sprint ||
      Math.abs(intent.moveX ?? 0) > 0.05 || Math.abs(intent.moveZ ?? 0) > 0.05);
    if (hasAction) {
      if (this.coveredByBot) this.retakeSlot();
      this.lastHumanInputTime = performance.now() / 1000;
    }
    // Continuous state is latest-wins; discrete commands survive neutral render frames.
    this.pendingIntent = { moveX: intent?.moveX ?? 0, moveZ: intent?.moveZ ?? 0, sprint: !!intent?.sprint };
    if (Number.isFinite(intent?.speedScale) && intent.speedScale !== 1) this.pendingIntent.speedScale = intent.speedScale;
    if (intent?.closeControl) this.pendingIntent.closeControl = true;
    if (intent?.faceUp) this.pendingIntent.faceUp = true;
    if (intent?.shield) this.pendingIntent.shield = true;
    if (Number.isFinite(intent?.worldX) && Number.isFinite(intent?.worldZ)) {
      this.pendingIntent.worldX = intent.worldX;
      this.pendingIntent.worldZ = intent.worldZ;
      if (Number.isFinite(intent.aimX) && Number.isFinite(intent.aimZ)) {
        this.pendingIntent.aimX = intent.aimX;
        this.pendingIntent.aimZ = intent.aimZ;
      }
    }
    for (const type of ['pass', 'shoot', 'through']) {
      if (intent?.[type]) this.pendingActions.push({ [type]: true, [`${type}Power`]: intent[`${type}Power`] });
    }
    // Tackle + slide are the two flags for a single skill command, not two commands.
    if (intent?.tackle || intent?.slide) this.pendingActions.push({ tackle: !!intent.tackle, slide: !!intent.slide });
  }

  resetInput() {
    this.pendingIntent = { moveX: 0, moveZ: 0, sprint: false };
    this.pendingActions.length = 0;
    const p = this.match.players.find((q) => q.id === this.humanId);
    if (p) p.intent = null;
  }

  retakeSlot() {
    const p = this.match.players.find((q) => q.id === this.humanId);
    if (p) p.isHuman = true;
    this.lastHumanInputTime = performance.now() / 1000;
    this.coveredByBot = false;
    this.resetInput();
    this.match.events.emit('SlotRetaken', { playerId: this.humanId });
  }

  tick(realDt) {
    if (this.paused) return this.latestSnapshot;
    const now = performance.now() / 1000;
    const idle = now - this.lastHumanInputTime;
    const human = this.match.players.find((q) => q.id === this.humanId);
    if (human && !this.coveredByBot && idle > AFK_SECONDS && this.match.phase !== 'ENDED') {
      this.coveredByBot = true;
      human.isHuman = false;
      this.resetInput();
      this.match.events.emit('SlotCoveredByBot', { playerId: this.humanId, seconds: AFK_SECONDS });
    }

    this.alpha = this.clock.advance(realDt, (dt) => {
      const humanPlayer = this.match.players.find((q) => q.id === this.humanId);
      if (humanPlayer?.isHuman) {
        // The engine consumes intent each step. Reapply movement, but dequeue each action once.
        humanPlayer.intent = { ...this.pendingIntent, ...this.pendingActions.shift() };
      }
      this.prevSnapshot = this.latestSnapshot;
      this.match.step(dt);
      this.autoSwitch();
      // Also clear intent when the engine skips input (countdown, stun, or match end).
      if (humanPlayer) humanPlayer.intent = null;
      this.latestSnapshot = this.match.getSnapshot();
    });
    return this.latestSnapshot;
  }

  dispose() { this.resetInput(); this.match.events.clear(); }
}

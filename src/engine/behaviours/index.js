import { EngineSettings as S } from '../settings.js';
import * as V from '../vec.js';
import { Acts, MovementType, MoveMode } from '../player.js';
import { roleMeta } from '../roles.js';
import { clamp, clamp01 } from '../../core/math.js';

export class BaseBehaviour {
  constructor(name) { this.name = name; this.force = false; }
  set(ctx) { Object.assign(this, ctx); }
  behave() { return false; }

  // shared helpers (BaseBehaviour.cs)
  isInField(p) {
    return Math.abs(p.x) < this.fieldHalfX + 1 && Math.abs(p.z) < this.fieldHalfZ + 1;
  }
  keepInField(p) {
    return V.v3(clamp(p.x, -this.fieldHalfX, this.fieldHalfX), 0, clamp(p.z, -this.fieldHalfZ, this.fieldHalfZ));
  }
  ballGoingOutside() {
    const b = this.ball;
    const t = 0.6;
    const px = b.pos.x + b.vel.x * t, pz = b.pos.z + b.vel.z * t;
    return Math.abs(px) > this.fieldHalfX || Math.abs(pz) > this.fieldHalfZ;
  }
}

// ---------------------------------------------------------------- input layer
export class InputPassBehaviour extends BaseBehaviour {
  constructor() { super('InputShortPass'); }
  behave() {
    const { player: p, intent, ball } = this;
    if (!p.isHuman || !intent?.pass) return false;
    if (p.isGoalKeeper && p.hasBall && ball.heldInHands) {
      this.match.gkDistribute(p);
      return true;
    }
    if (!p.hasBall && !this.match.canKickBall(p, 1.8)) {
      if (ball.holder && ball.holder.team !== p.team && this.time >= p.tackleReadyAt) {
        this.match.attemptTackle(p, false);
        return true;
      }
      return false;
    }
    const target = this.match.bestPassTarget(p, intent);
    if (target) {
      const point = this.match.leadPoint(target, Math.min(0.75, V.distXZ(p.pos, target.pos) / 22));
      const speed = 0.72 + (intent.passPower ?? 0.6) * 0.62;
      p.lastPassKind = 'pass';
      if (p.hasBall) {
        if (!this.match.scheduleStrike(p, { type: 'pass', point, speed, receiverId: target.id })) return false;
      } else {
        ball.pass(point, p, speed);
        ball.intendedReceiverId = target.id;
        ball.intendedReceiverUntil = this.time + 2.2;
      }
      p.currentAct = Acts.InputPass;
      p.passingTarget = target;
      return true;
    }
    return false;
  }
}

export class InputThroughBehaviour extends BaseBehaviour {
  constructor() { super('InputThroughtPass'); }
  behave() {
    const { player: p, intent, ball } = this;
    if (!p.isHuman || !intent?.through) return false;
    if (!p.hasBall && !this.match.canKickBall(p, 2.2)) return false;
    const runner = this.match.bestRunTarget(p);
    if (!runner) return false;
    const ahead = V.addScaled(runner.pos, V.fromHeading(runner.facing), 6 + runner.speed * 0.8);
    const point = this.keepInField(ahead);
    const lob = (intent.throughPower ?? 0.25) > 0.62;
    const speed = 1.05 + (intent.throughPower ?? 0.25) * 0.45;
    p.lastPassKind = 'pass';
    if (p.hasBall) {
      if (!this.match.scheduleStrike(p, { type: 'through', point, lob, speed, receiverId: runner.id })) return false;
    } else {
      if (lob) ball.cross(point, p);
      else ball.pass(point, p, speed);
      ball.intendedReceiverId = runner.id;
      ball.intendedReceiverUntil = this.time + 2.4;
    }
    p.currentAct = Acts.PassingToBehindDefenseLine;
    return true;
  }
}

export class InputCrossBehaviour extends BaseBehaviour {
  constructor() { super('InputCross'); }
  behave() {
    const { player: p, intent, ball } = this;
    if (!p.isHuman || !intent?.cross) return false;
    if (!p.hasBall && !this.match.canKickBall(p, 2.2)) return false;
    const target = this.match.bestCrossTarget(p);
    if (!target) return false;
    if (p.hasBall) {
      if (!this.match.scheduleStrike(p, { type: 'cross', point: target })) return false;
    } else ball.cross(target, p);
    p.currentAct = Acts.Crossing;
    return true;
  }
}

export class InputShootBehaviour extends BaseBehaviour {
  constructor() { super('InputShoot'); }
  behave() {
    const { player: p, intent, ball } = this;
    if (!p.isHuman || !intent?.shoot) return false;
    if (p.isGoalKeeper && p.hasBall && (p.isGoalKickHolder || ball.heldInHands)) {
      this.match.gkDistribute(p);
      return true;
    }
    if (!p.hasBall && !this.match.canKickBall(p, 2.2)) return false;
    if (!p.hasBall && ball.pos.y > 1.25) return this.match.performHeader(p, true);
    const power = clamp(intent.shootPower ?? 0.7, 0.15, 1);
    if (p.hasBall) {
      if (!this.match.scheduleStrike(p, { type: 'shoot', power, chip: !!intent.chip })) return false;
    } else this.match.shootAtGoal(p, power, intent.chip);
    p.currentAct = Acts.InputShoot;
    return true;
  }
}

export class InputTackleBehaviour extends BaseBehaviour {
  constructor() { super('InputTackle'); }
  behave() {
    const { player: p, intent } = this;
    if (!p.isHuman || !intent?.tackle) return false;
    if (p.hasBall) {
      if (intent.slide) this.match.performSkill(p, intent);
      return true;
    }
    if (p.isGoalKeeper && intent.slide) {
      this.match.startGKDive(p, intent);
      return true;
    }
    if (this.match.time < p.tackleReadyAt) return false;
    this.match.attemptTackle(p, intent.slide);
    return true;
  }
}

// ---------------------------------------------------------------- goalkeeping
export class GKBallHoldStay extends BaseBehaviour {
  constructor() { super('GKBallHoldStay'); }
  behave() {
    const { player: p, ball } = this;
    if (!p.isGoalKeeper || !p.hasBall) return false;
    p.stop(this.dt);
    p.animMode = this.ball.heldInHands ? 'GK_HOLD' : 'GK_READY';
    if (p.ballHoldTime > 2.2) this.match.gkDistribute(p);
    return true;
  }
}

export class GKShieldBehaviour extends BaseBehaviour {
  constructor() { super('GKShieldBehaviour'); }
  behave() {
    const { player: p, ball } = this;
    if (!p.isGoalKeeper || !ball.isLoose) return false;
    if (ball.ignoreHitter === p && this.time < ball.ignoreHitterUntil) return false;
    const goal = this.ownGoal;
    const dToBall = V.distXZ(p.pos, ball.pos);
    const inMyThird = Math.abs(ball.pos.x - goal.x) < this.fieldHalfX * 0.32;
    if (!inMyThird) return false;
    const ballComing = V.dotXZ(ball.vel, V.sub(goal, ball.pos)) > 0 || dToBall < 3;
    if (!ballComing && dToBall > 4) return false;
    const pred = ball.predicter(p, 0);
    if (dToBall < 3.6 && ball.speed > 10) this.match.startGKDive(p);
    else p.moveTo(this.dt, pred.point, ball.pos, MovementType.BestHeCanDo);
    p.animMode = dToBall < 2.4 && p.diveTimer <= 0 ? 'GK_SPREAD' : p.animMode;
    return true;
  }
}

export class GKPositioningBehaviour extends BaseBehaviour {
  constructor() { super('GKPositioning'); }
  behave() {
    const { player: p, ball } = this;
    if (!p.isGoalKeeper) return false;
    const goal = this.ownGoal;
    const toBall = V.sub(ball.pos, goal);
    const d = V.lenXZ(toBall);
    const line = clamp01(1 - d / (this.fieldHalfX * 1.4));
    const out = 1.2 + line * 3.4;
    const dir = V.normalizeXZ(toBall);
    const spot = V.addScaled(V.v3(goal.x, 0, goal.z), dir, out);
    spot.z = clamp(spot.z, -3.4, 3.4);
    p.moveTo(this.dt, spot, ball.pos, MovementType.Normal);
    p.animMode = 'GK_READY';
    return true;
  }
}

// ---------------------------------------------------------------- outfield AI
export class PassReceptionBehaviour extends BaseBehaviour {
  constructor() { super('PassReceptionBehaviour'); }
  behave() {
    const { player: p, ball } = this;
    if (!ball.isLoose || p.isGoalKeeper) return false;
    if (ball.intendedReceiverId !== p.id || this.time > ball.intendedReceiverUntil) return false;
    const pred = ball.predicter(p, 0.1);
    p.moveTo(this.dt, this.keepInField(pred.point), ball.pos, MovementType.BestHeCanDo);
    p.currentAct = Acts.GoingToGetTheBall_WithCaution;
    return true;
  }
}

export class BallChasingBehaviour extends BaseBehaviour {
  constructor() { super('BallChasingBehaviour'); }
  behave() {
    const { player: p, ball } = this;
    if (!ball.isLoose || p.isGoalKeeper) return false;
    if (this.match.chaserFor(p.team) !== p) return false;
    if (this.ballGoingOutside() && Math.abs(ball.pos.x) > this.fieldHalfX - 2) return false;
    const pred = ball.predicter(p, 0);
    p.moveTo(this.dt, this.keepInField(pred.point), ball.pos, MovementType.BestHeCanDo);
    p.currentAct = Acts.GoingToGetTheBall_BallChasing;
    return true;
  }
}

export class SecondBallBehaviour extends BaseBehaviour {
  constructor() { super('SecondBallBehaviour'); }
  behave() {
    const { player: p, ball } = this;
    if (!ball.isLoose || p.isGoalKeeper || p === this.team.chaser) return false;
    if (ball.pos.y < 1.1) return false;
    const pred = ball.predicter(p, 0.15);
    if (V.distXZ(p.pos, pred.point) > 16) return false;
    const rivals = [p, ...this.teammates]
      .filter((q) => !q.isGoalKeeper && q !== this.team.chaser)
      .sort((a, b) => V.distXZ(a.pos, pred.point) - V.distXZ(b.pos, pred.point));
    if (rivals[0] !== p) return false;
    p.moveTo(this.dt, this.keepInField(pred.point), ball.pos, MovementType.BestHeCanDo);
    p.currentAct = Acts.GoingToGetTheBall_BallChasing;
    return true;
  }
}

export class ShootingBehaviour extends BaseBehaviour {
  constructor() { super('ShootingBehaviour'); }
  behave() {
    const { player: p } = this;
    if (!p.hasBall || p.isGoalKeeper) return false;
    const decision = this.match.attackDecision(p);
    if (!decision || decision.action !== 'shoot') return false;
    const power = clamp(0.55 + decision.xg * 1.2, 0.55, 1);
    p.lastShotXG = decision.xg;
    this.match.shootAtGoal(p, power, false);
    p.currentAct = Acts.Shoot;
    return true;
  }
}

export class AnswerCallBehaviour extends BaseBehaviour {
  constructor() { super('AnswerCallBehaviour'); }
  behave() {
    const { player: p, ball } = this;
    if (!p.hasBall || p.isGoalKeeper) return false;
    const human = this.teammates.find((q) => q.isHuman);
    if (!human || this.time >= human.calledForPassUntil) return false;
    const d = V.distXZ(p.pos, human.pos);
    if (d < 3 || d > 28 || human.isInOffside) return false;
    const point = V.v3(human.pos.x, 0, human.pos.z);
    const lane = this.match.laneBlockers(p.pos, point, p.team);
    if (lane.tightest <= 1 || lane.blockers > 0) return false;
    if (this.match.nearestOpponentDistance(human) <= 1) return false;
    ball.pass(point, p, 0.95);
    ball.intendedReceiverId = human.id;
    ball.intendedReceiverUntil = this.time + 2.2;
    p.lastPassKind = 'pass';
    p.currentAct = Acts.PassingToBetterOpportunity;
    p.passingTarget = human;
    p.kickTimer = 0.28;
    return true;
  }
}

export class PassingBehaviour extends BaseBehaviour {
  constructor() { super('PassingBehaviour'); }
  behave() {
    const { player: p, ball } = this;
    if (!p.hasBall || p.isGoalKeeper) return false;
    if (p.ballHoldTime < 0.25) return false;
    const decision = this.match.attackDecision(p);
    if (!decision || !['pass', 'cross'].includes(decision.action) || !decision.target) return false;
    p.passingTarget = decision.target;
    p.lastPassValue = decision.passValue;
    p.lastPassKind = 'pass';
    if (decision.kind === 'cross') {
      ball.cross(decision.point ?? decision.target.pos, p);
      p.currentAct = Acts.Crossing;
    } else {
      ball.pass(decision.point ?? this.match.leadPoint(decision.target, 0.3), p, 0.88);
      p.currentAct = Acts.PassingToBetterOpportunity;
    }
    p.kickTimer = 0.28;
    return true;
  }
}

export class SendBallToSafeBehaviour extends BaseBehaviour {
  constructor() { super('SendBallToSafe'); }
  behave() {
    const { player: p, ball } = this;
    if (!p.hasBall || p.isGoalKeeper) return false;
    const pressure = this.match.nearestOpponentDistance(p);
    const space = this.match.spaceAhead(p);
    if (pressure > 2.0 || space > 4) return false;
    const dir = p.attackDir;
    const side = Math.sign(p.pos.z) || 1;
    const target = V.v3(
      p.pos.x + dir * 4,
      0,
      side * (this.fieldHalfZ - 4)
    );
    p.lastPassKind = 'clear';
    ball.pass(this.keepInField(target), p, 1.05);
    p.currentAct = Acts.LastThingToDoWhenWeHaveTheBall;
    p.kickTimer = 0.28;
    return true;
  }
}

export class DribblingBehaviour extends BaseBehaviour {
  constructor() { super('DribblingBehaviour'); }
  behave() {
    const { player: p } = this;
    if (!p.hasBall || p.isGoalKeeper) return false;
    const goal = this.attackGoal;
    const pressure = this.match.nearestOpponentDistance(p);
    if (pressure < 1.35) {
      // Put the body between the nearest defender and the ball, then escape
      // away from contact while still advancing toward goal.
      const opponent = this.opponents.reduce((best, q) =>
        !best || V.distXZ(p.pos, q.pos) < V.distXZ(p.pos, best.pos) ? q : best, null);
      p.moveMode = MoveMode.Shield;
      if (opponent) {
        const away = V.normalizeXZ(V.sub(p.pos, opponent.pos));
        const toGoal = V.normalizeXZ(V.sub(V.v3(goal.x, 0, goal.z), p.pos));
        const escape = V.normalizeXZ(V.addScaled(away, toGoal, 0.35));
        p.moveTo(this.dt, this.keepInField(V.addScaled(p.pos, escape, 4)), V.v3(goal.x, 0, goal.z),
          MovementType.Normal);
      }
      p.currentAct = Acts.Dribbling;
      p.animMode = 'RUN';
      return true;
    }
    p.moveMode = MoveMode.Normal;
    const space = this.match.spaceAhead(p);
    const target = V.addScaled(p.pos, V.fromHeading(V.headingOf(V.sub(V.v3(goal.x, 0, goal.z), p.pos))), 4 + space);
    p.moveTo(this.dt, this.keepInField(target), V.v3(goal.x, 0, goal.z), MovementType.BestHeCanDo);
    p.currentAct = Acts.Dribbling;
    p.animMode = 'RUN';
    return true;
  }
}

export class TryToTackleBehaviour extends BaseBehaviour {
  constructor() { super('TryToTackleBehaviour'); }
  behave() {
    const { player: p, ball } = this;
    if (p.hasBall || p.isGoalKeeper) return false;
    const carrier = ball.holder;
    if (!carrier || carrier.team === p.team) return false;
    if (this.match.chaserFor(p.team) !== p && V.distXZ(p.pos, carrier.pos) > 3.2) return false;
    if (this.match.time < p.tackleReadyAt) return false;
    const d = V.distXZ(p.pos, carrier.pos);
    if (d < 1.5) { this.match.attemptTackle(p, false); return true; }
    if (d < 7) {
      const lead = V.addScaled(carrier.pos, V.fromHeading(carrier.facing), 1.2);
      p.moveTo(this.dt, lead, carrier.pos, MovementType.BestHeCanDo);
      p.currentAct = Acts.GoingToTackle;
      return true;
    }
    return false;
  }
}

export class OneTwoBehaviour extends BaseBehaviour {
  constructor() { super('OneTwoBehaviour'); }
  behave() {
    const { player: p, ball } = this;
    if (!p.hasBall || p.isGoalKeeper || this.team.phase !== 'IN_POSSESSION') return false;
    if (this.time < p.oneTwoReadyAt || this.match.nearestOpponentDistance(p) > 3.0) return false;
    const mate = this.teammates
      .filter((q) => !q.isGoalKeeper)
      .map((q) => ({ q, d: V.distXZ(p.pos, q.pos) }))
      .filter(({ q, d }) => d > 4 && d < 18 && this.match.laneBlockers(p.pos, this.match.leadPoint(q, 0.25), p.team).tightest > 1.2)
      .sort((a, b) => (a.q.pos.x - p.pos.x) * p.attackDir - a.d * 0.2 -
        ((b.q.pos.x - p.pos.x) * p.attackDir - b.d * 0.2))[0]?.q;
    if (!mate) return false;
    ball.pass(this.match.leadPoint(mate, 0.25), p, 0.95);
    ball.intendedReceiverId = mate.id;
    ball.intendedReceiverUntil = this.time + 2.2;
    p.lastPassKind = 'pass';
    p.passingTarget = mate;
    p.oneTwoUntil = this.time + 1.7;
    p.oneTwoPartner = mate.id;
    p.oneTwoReadyAt = this.time + 5;
    this.team.oneTwo = { passerId: p.id, partnerId: mate.id, until: this.time + 1.9 };
    p.currentAct = Acts.PassAndRun;
    return true;
  }
}

export class OneTwoReturnBehaviour extends BaseBehaviour {
  constructor() { super('OneTwoReturnBehaviour'); }
  behave() {
    const { player: p, ball } = this;
    if (!p.hasBall || p.isGoalKeeper) return false;
    const link = this.team.oneTwo;
    if (!link || link.partnerId !== p.id || this.time > link.until) return false;
    if (p.ballHoldTime < 0.12) return false;
    const passer = this.teammates.find((q) => q.id === link.passerId);
    if (!passer) return false;
    const point = this.match.leadPoint(passer, 0.35);
    const lane = this.match.laneBlockers(p.pos, point, p.team);
    if (lane.blockers > 0 && lane.tightest < 1.0) return false;
    ball.pass(this.keepInField(point), p, 0.92);
    ball.intendedReceiverId = passer.id;
    ball.intendedReceiverUntil = this.time + 2.2;
    p.lastPassKind = 'pass';
    p.passingTarget = passer;
    p.currentAct = Acts.PassAndRun;
    p.oneTwoReadyAt = this.time + 5;
    this.team.oneTwo = null;
    return true;
  }
}

export class PassAndRunBehaviour extends BaseBehaviour {
  constructor() { super('PassAndRunBehaviour'); }
  behave() {
    const { player: p, ball } = this;
    if (p.hasBall || this.time >= p.oneTwoUntil || !this.team.inPossession) return false;
    const dir = p.attackDir;
    const target = V.v3(
      ball.pos.x + dir * 9,
      0,
      ball.pos.z + (p.pos.z - ball.pos.z) * 0.3
    );
    p.moveTo(this.dt, this.keepInField(target), ball.pos, MovementType.BestHeCanDo);
    p.currentAct = Acts.PassAndRun;
    return true;
  }
}

export class OverlapUnderlapBehaviour extends BaseBehaviour {
  constructor() { super('OverlapUnderlapBehaviour'); }
  behave() {
    const { player: p, ball } = this;
    if (!this.team.inPossession || p.hasBall || p.isGoalKeeper) return false;
    const group = roleMeta(p.role).group;
    const isBack = group === 'DEF';
    const isMid = group === 'MID';
    if (!isBack && !isMid) return false;
    if (isBack && !['FB', 'WB', 'DEF'].includes(p.role)) return false;
    if (p.duty === 'Hold') return false;
    if (isMid && !['CM', 'AM', 'MID'].includes(p.role)) return false;
    if (this.team.ballProgress < 0.45) return false;
    if (Math.abs(ball.pos.z) < this.fieldHalfZ * 0.30) return false;
    const bandMates = this.teammates.filter((q) =>
      roleMeta(q.role).group === group && !q.isGoalKeeper && !q.hasBall);
    const closest = [p, ...bandMates]
      .sort((a, b) => Math.abs(a.pos.z - ball.pos.z) - Math.abs(b.pos.z - ball.pos.z))[0];
    if (closest !== p) return false;
    const dir = p.attackDir;
    if ((p.pos.x - ball.pos.x) * dir > 2) return false;
    const side = Math.sign(ball.pos.z) || 1;
    const outside = V.v3(ball.pos.x + dir * 10, 0, side * (this.fieldHalfZ - 4));
    const inside = V.v3(ball.pos.x + dir * 8, 0, ball.pos.z - side * 6);
    const target = isBack && this.match.laneBlockers(ball.pos, outside, p.team).tightest > 2 ? outside : inside;
    if ((target.x - p.pos.x) * dir < 2) return false;
    p.moveTo(this.dt, this.keepInField(target), ball.pos, MovementType.BestHeCanDo);
    p.currentAct = Acts.JoinTheAttack;
    return true;
  }
}

export class BoxOverloadBehaviour extends BaseBehaviour {
  constructor() { super('BoxOverloadBehaviour'); }
  behave() {
    const { player: p, ball } = this;
    if (!this.team.inPossession || p.hasBall || p.isGoalKeeper) return false;
    if (this.team.ballProgress < 0.60) return false;
    const goal = this.attackGoal;
    const dir = p.attackDir;
    const group = roleMeta(p.role).group;
    if (p.duty === 'Hold') return false;
    if (group === 'FWD') {
      const near = (p.anchorIn?.h ?? p.anchor?.h ?? 0.5) < 0.5;
      const spot = V.v3(goal.x - dir * (near ? 5 : 8), 0, (near ? 1 : -1) * this.match.cfg.goalW * 0.36);
      p.moveTo(this.dt, this.keepInField(spot), ball.pos, MovementType.BestHeCanDo);
      p.currentAct = Acts.TargetMan;
      return true;
    }
    if (group === 'MID') {
      if (this.team.ballProgress < 0.68) return false;
      if (Math.abs(ball.pos.z) < this.fieldHalfZ * 0.30) return false;
      const mids = [p, ...this.teammates.filter((q) =>
        roleMeta(q.role).group === 'MID' && q.duty !== 'Hold' && !q.hasBall)];
      const closestMid = mids.slice().sort((a, b) => Math.abs(a.pos.z - ball.pos.z) - Math.abs(b.pos.z - ball.pos.z))[0];
      if (closestMid !== p) return false;
      const spot = V.v3(goal.x - dir * 17, 0, -Math.sign(ball.pos.z || 1) * this.fieldHalfZ * 0.28);
      p.moveTo(this.dt, this.keepInField(spot), ball.pos, MovementType.Normal);
      p.currentAct = Acts.JoinTheAttack;
      return true;
    }
    return false;
  }
}

export class AICrossingBehaviour extends BaseBehaviour {
  constructor() { super('AICrossingBehaviour'); }
  behave() {
    const { player: p, ball } = this;
    if (!p.hasBall || p.isGoalKeeper) return false;
    if (this.team.ballProgress < 0.55 || Math.abs(p.pos.z) < this.fieldHalfZ * 0.38) return false;
    const option = this.match.bestCrossOption(p);
    if (!option) return false;
    if (option.lane.blockers > 0 && option.lane.tightest < 1.0) return false;
    const dir = p.attackDir;
    const byline = (this.attackGoal.x - p.pos.x) * dir < 10;
    const cutback = byline ? this.match.bestCutbackTarget(p) : null;
    if (cutback) ball.pass(cutback.point, p, 1.08);
    else ball.cross(option.point, p, true);
    p.currentAct = Acts.Crossing;
    p.kickTimer = 0.3;
    return true;
  }
}

export class CounterAttackBehaviour extends BaseBehaviour {
  constructor() { super('CounterAttackBehaviour'); }
  behave() {
    const { player: p, ball } = this;
    if (!p.hasBall || !this.team.inTransition || !this.team.inPossession) return false;
    const runner = this.match.bestRunTarget(p);
    if (!runner) return false;
    const point = this.match.leadPoint(runner, 0.4);
    const lane = this.match.laneBlockers(p.pos, point, p.team);
    if (lane.blockers > 0 && lane.tightest < 1.1) return false;
    p.lastPassKind = 'pass';
    ball.pass(point, p, 0.95);
    p.currentAct = Acts.PassingToBehindDefenseLine;
    p.kickTimer = 0.3;
    return true;
  }
}

export class RunBehindDefenseLineBehaviour extends BaseBehaviour {
  constructor() { super('RunBehindDefenseLineBehaviour'); }
  behave() {
    const { player: p, ball } = this;
    if (!this.team.inPossession || p.hasBall || p.isGoalKeeper) return false;
    if (roleMeta(p.role).group !== 'FWD' || this.team.ballProgress < 0.45) return false;
    const dir = p.attackDir;
    const targetX = this.team.offsideLine - dir * 0.9;
    const clampedX = Math.max(-this.fieldHalfX + 3, Math.min(this.fieldHalfX - 3, targetX));
    if ((clampedX - p.pos.x) * dir < 1.5) return false;
    const target = V.v3(clampedX, 0, p.pos.z);
    p.moveTo(this.dt, target, V.v3(ball.pos.x, 0, ball.pos.z), MovementType.BestHeCanDo);
    p.currentAct = Acts.RunningBehindTheDefenseLine;
    return true;
  }
}

export class SupportPlayBehaviour extends BaseBehaviour {
  constructor() { super('SupportPlayBehaviour'); }
  behave() {
    const { player: p, ball } = this;
    if (!this.team.inPossession || p.hasBall || p.isGoalKeeper) return false;
    if (p.duty === 'Hold') return false;
    if (!['MID', 'FWD'].includes(roleMeta(p.role).group)) return false;
    if (V.distXZ(p.pos, ball.pos) > 24) return false;
    const goal = this.attackGoal;
    const toGoal = V.normalizeXZ(V.sub(goal, ball.pos));
    let side = p.pos.z >= ball.pos.z ? 1 : -1;
    let target = V.v3(ball.pos.x + toGoal.x * 5, 0, ball.pos.z + side * 7);
    const blocked = this.match.laneBlockers(ball.pos, target, p.team);
    if (blocked.tightest < 2.2) {
      side *= -1;
      target = V.v3(ball.pos.x + toGoal.x * 5, 0, ball.pos.z + side * 7);
    }
    p.moveTo(this.dt, this.keepInField(target), ball.pos, MovementType.Normal);
    p.currentAct = Acts.BecomeAPassOption;
    return true;
  }
}

export class PressingCoverBehaviour extends BaseBehaviour {
  constructor() { super('PressingCoverBehaviour'); }
  behave() {
    const { player: p, ball } = this;
    if (!this.team.outOfPossession || p.isGoalKeeper) return false;
    if (!this.team.cover || this.team.cover !== p || this.team.presser === p) return false;
    const goal = this.ownGoal;
    const toGoal = V.normalizeXZ(V.sub(goal, ball.pos));
    const pressSide = Math.sign((this.team.presser?.pos.z ?? ball.pos.z) - ball.pos.z) || 1;
    const target = V.v3(ball.pos.x + toGoal.x * 7, 0, ball.pos.z - pressSide * 4);
    p.moveTo(this.dt, this.keepInField(target), ball.pos, MovementType.BestHeCanDo);
    p.currentAct = Acts.MarkingTheOpponent;
    return true;
  }
}

export class MarkTheLastGuyBehaviour extends BaseBehaviour {
  constructor() { super('MarkTheLastGuyBehaviour'); }
  behave() {
    const { player: p } = this;
    if (!this.team.outOfPossession || p.isGoalKeeper || this.team.ballProgress < 0.35) return false;
    const deepest = this.team.fielders.slice().sort((a, b) => (a.anchor?.v ?? 0.5) - (b.anchor?.v ?? 0.5))[0];
    if (deepest !== p) return false;
    const target = this.opponents
      .filter((opponent) => !opponent.isGoalKeeper)
      .sort((a, b) => Math.abs(a.pos.x - this.ownGoal.x) - Math.abs(b.pos.x - this.ownGoal.x))[0];
    if (!target) return false;
    p.markingTarget = target;
    const goalSide = Math.sign(this.ownGoal.x - target.pos.x) || -1;
    const spot = V.v3(target.pos.x + goalSide * 1.3, 0, target.pos.z);
    p.moveTo(this.dt, this.keepInField(spot), target.pos, MovementType.BestHeCanDo);
    p.currentAct = Acts.MarkTheLastGuy;
    return true;
  }
}

export class RestDefenceBehaviour extends BaseBehaviour {
  constructor() { super('RestDefenceBehaviour'); }
  behave() {
    const { player: p, ball } = this;
    if (!this.team.inPossession || p.isGoalKeeper) return false;
    if (this.team.ballProgress < 0.50) return false;
    const holder = this.team.fielders.find((q) => q.role === 'DM' && q.duty === 'Hold');
    const rest = holder ?? this.team.fielders
      .filter((q) => q.anchor?.band === 'CB')
      .sort((a, b) => a.anchor.v - b.anchor.v)[0];
    if (rest !== p) return false;
    const dir = p.attackDir;
    const v = holder ? Math.min(p.anchorIn?.v ?? 0.40, 0.46) : 0.42;
    let x = this.ownGoal.x + dir * this.match.fieldLength * v;
    x = dir > 0 ? Math.min(x, ball.pos.x - 5) : Math.max(x, ball.pos.x + 5);
    const spot = V.v3(x, 0, ball.pos.z * 0.25);
    p.moveTo(this.dt, this.keepInField(spot), ball.pos, MovementType.Normal);
    p.currentAct = Acts.TacticalPositioning;
    return true;
  }
}

export class GKSweeperBehaviour extends BaseBehaviour {
  constructor() { super('GKSweeperBehaviour'); }
  behave() {
    const { player: p, ball } = this;
    if (!p.isGoalKeeper || !ball.isLoose) return false;
    const goal = this.ownGoal;
    const ballDistance = Math.abs(ball.pos.x - goal.x);
    if (ballDistance > this.fieldHalfX * 0.34) return false;
    const inBox = ballDistance <= 16.5 && Math.abs(ball.pos.z) <= 20.15;
    if (inBox) return false;
    let closest = Infinity;
    for (const teammate of this.team.fielders) closest = Math.min(closest, V.distXZ(teammate.pos, ball.pos));
    if (closest < V.distXZ(p.pos, ball.pos) - 2) return false;
    const pred = ball.predicter(p, 0);
    p.moveTo(this.dt, pred.point, ball.pos, MovementType.BestHeCanDo);
    p.animMode = 'GK_READY';
    if (this.match.canKickBall(p, 1.7)) {
      const target = V.v3(p.pos.x + p.attackDir * 18, 0, ball.pos.z * 0.3);
      ball.pass(this.keepInField(target), p, 1.2);
    }
    return true;
  }
}

export class TacticalPositioningBehaviour extends BaseBehaviour {
  constructor() { super('TacticalPositioningBehaviour'); }
  behave() {
    const { player: p } = this;
    if (p.hasBall) return false;
    const spot = this.team.getFieldPosition(p, this.ballProgressGlobal);
    p.moveTo(this.dt, spot, this.ball.pos, MovementType.Normal);
    p.currentAct = Acts.TacticalPositioning;
    return true;
  }
}

export function outfieldBehaviours() {
  return [
    new InputShootBehaviour(), new InputPassBehaviour(), new InputThroughBehaviour(),
    new InputCrossBehaviour(), new InputTackleBehaviour(),
    new ShootingBehaviour(), new AnswerCallBehaviour(), new OneTwoBehaviour(), new OneTwoReturnBehaviour(),
    new PassingBehaviour(), new SendBallToSafeBehaviour(), new PassAndRunBehaviour(),
    new RunBehindDefenseLineBehaviour(), new BoxOverloadBehaviour(), new OverlapUnderlapBehaviour(),
    new SupportPlayBehaviour(), new DribblingBehaviour(),
    new TryToTackleBehaviour(), new PressingCoverBehaviour(), new MarkTheLastGuyBehaviour(),
    new BallChasingBehaviour(), new PassReceptionBehaviour(), new SecondBallBehaviour(), new RestDefenceBehaviour(), new TacticalPositioningBehaviour()
  ];
}

export function keeperBehaviours() {
  return [
    new InputShootBehaviour(), new InputPassBehaviour(), new InputThroughBehaviour(),
    new InputCrossBehaviour(), new InputTackleBehaviour(),
    new GKBallHoldStay(), new GKSweeperBehaviour(), new GKShieldBehaviour(), new GKPositioningBehaviour()
  ];
}

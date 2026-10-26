import { EngineSettings as S, skillToMultiplier } from './settings.js';
import * as V from './vec.js';
import { clamp, clamp01, angleLerp } from '../core/math.js';

export const Acts = {
  Nothing: 0, GoingToGoal: 1, PassingToBetterOpportunity: 2, Crossing: 3,
  PassingToClosestTeammate: 4, PassingToAvailableClosestTeammate: 5, Shoot: 6,
  GoingToTackle: 7, LastThingToDoWhenWeHaveTheBall: 8, Tackling: 9, TacklingFailed: 10,
  Stunned: 11, MarkingTheOpponent: 12, ReachedGoalButCouldNotShoot: 13,
  NothingToDo_GoingToShoot: 14, InMarking_LookingForTeammateToPass: 15,
  NothingToDo_PassingToClosestTeammate: 16, GoingToGetTheBall_BallChasing: 17,
  GoingToGetTheBall_WithCaution: 18, RunningForward: 19, RunningBehindDefenseLine: 20,
  PassingToBehindDefenseLine: 21, ThrowIn: 22, StrikerTacticalBehaviour: 23,
  TacticalPositioning: 24, DefensiveTacticalPositioning: 25, BecomeAPassOption: 26,
  TargetMan: 27, JoinTheAttack: 28, PassAndRun: 29, MarkTheLastGuy: 30, Dribbling: 31,
  InputPass: 32, InputShoot: 33
};

// MovementType {Relax, Normal, BestHeCanDo} speed multipliers recovered from
// CodeBasedController__MoveTo.c (0.25 / 0.75 / 1.0).
export const MovementType = { Relax: 0, Normal: 1, BestHeCanDo: 2 };
const MOVEMENT_MULT = [0.25, 0.75, 1.0];

// Ball-carry modes. Speed is a multiplier on the MovementType base, so Sprint
// and Normal differ by intent (close control is slower, shield is slowest).
export const MoveMode = { Shield: 0, Close: 1, Normal: 2, Sprint: 3 };
const MOVE_MODES = [
  { speed: 0.42, accel: 1.20, turn: 0.88 }, // Shield
  { speed: 0.62, accel: 1.15, turn: 1.06 }, // Close
  { speed: 1.00, accel: 1.00, turn: 1.00 }, // Normal
  { speed: 1.00, accel: 0.92, turn: 0.82 }  // Sprint
];

export const LocoState = {
  Idle: 'IDLE', Start: 'START', Walk: 'WALK', Run: 'RUN', Sprint: 'SPRINT',
  Stop: 'STOP', Turn: 'TURN', Strafe: 'STRAFE'
};

// Metres travelled per full gait cycle. Calibrated to the authored loops so
// phase advance and clip playback stay ground-locked across speed changes.
const LOCO_STRIDE = {
  WALK: 2.4, RUN: 4.8, SPRINT: 5.0, START: 2.4, STRAFE: 1.9, TURN: 1.2, STOP: 2.4
};
const LOCO_CONTACT_FRACTION = 0.22;
const LOCO_RUN_ENTER = 2.4;
const LOCO_RUN_EXIT = 2.1;
const LOCO_SPRINT_ENTER = 5.7;
const LOCO_SPRINT_EXIT = 5.2;
const LOCO_START_SPEED = 0.6;
const LOCO_START_DONE = 1.5;
const LOCO_STOP_SPEED = 0.3;

// Calibrated feel constants. The recovered TopSpeedModifier/AccerelationModifier
// are *multipliers* applied to a per-player base that was never recovered, so the
// base values below are calibrated, the curve shapes are recovered.
const BASE_SPRINT = 7.6;      // m/s at 100 topSpeed, MovementType.BestHeCanDo
const BASE_ACCEL = 6.0;       // 1/s lerp rate at 100 acceleration
const BASE_TURN = 9.0;        // rad/s at 100 agility

// Curve names as shipped in PlayerSkillCurves (SpeedCurve=topSpeed, JumpingCurve=jump).
// Stats with no shipped curve fall back to a linear 0..1 mapping in skillToMultiplier.
export const SKILL_CURVE_MAP = {
  strength: 'StrengthCurve', topSpeed: 'SpeedCurve',
  dribbleSpeed: 'DribbleSpeedCurve', jump: 'JumpingCurve', tackling: 'TacklingCurve',
  passing: 'PassingCurve', agility: 'AgilityCurve', shooting: 'ShootingCurve',
  positioning: 'PositioningCurve', reaction: 'ReactionCurve', ballControl: 'BallControlCurve'
};

export class Player {
  constructor(opts) {
    this.id = opts.id;
    this.team = opts.team;
    this.role = opts.role;              // 'GK' | 'CB' | 'DM' | 'ST' | ...
    this.naturalRole = opts.role;
    this.duty = opts.duty ?? 'Hold';
    this.positionFlag = opts.positionFlag ?? 0;
    this.name = opts.name ?? `P${opts.id}`;
    this.isHuman = !!opts.isHuman;
    this.skills = { ...opts.skills };
    this.pos = V.v3(opts.x ?? 0, 0, opts.z ?? 0);
    this.facing = opts.facing ?? 0;
    this.speed = 0;
    this.vx = 0;
    this.vz = 0;
    this.moveMode = MoveMode.Normal;
    this.moveSpeedScale = 1;
    this.motionState = 'IDLE';
    this.locoState = LocoState.Idle;
    this.locoStateTime = 0;
    this.locoPhase = 0;
    this.locoFoot = null;
    this.locoContact = false;
    this.locoStride = LOCO_STRIDE.WALK;
    this.turnInPlace = false;
    this.strafeSign = 0;
    this.actionBuffer = null;
    this.currentAct = Acts.Nothing;
    this.activeBehaviour = null;
    this.nextBehaviourTime = 0;
    this.behaviours = [];
    this.markingTarget = null;
    this.passingTarget = null;
    this.isInOffside = false;
    this.isThrowHolder = false;
    this.isGoalKickHolder = false;
    this.isCornerHolder = false;
    this.stunnedUntil = 0;
    this.tackleReadyAt = 0;
    this.balance = 1;
    this.stumbleReadyAt = 0;
    this.duelReadyAt = 0;
    this.shieldActive = false;
    this.shieldSide = 0;
    this.shieldTargetId = null;
    this.jostle = 0;
    this.faceUp = false;
    this.skillKind = null;
    this.lastSkillSide = 0;
    this.diveTimer = 0;
    this.diveReadyAt = 0;
    this.diveVelocity = V.v3();
    this.diveSide = 1;
    this.gkState = 'SET';
    this.gkRecoverUntil = 0;
    this.feintReadyAt = 0;
    this.feintUntil = 0;
    this.feintImmuneUntil = 0;
    this.feintVelocity = V.v3();
    this.stamina = 100;
    this.sprinting = false;
    this.sprintExhausted = false;
    this.ballContactReadyAt = 0;
    this.pendingStrike = null;
    this.pendingDistribution = null;
    this.kickKind = null;
    this.actionSeq = 0;
    this.actionImmediate = false;
    this.actionLockUntil = 0;
    this.bufferedAction = null;
    this.jumpTimer = 0;
    this.jumpHeight = 0;
    this.oneTwoUntil = -1;
    this.oneTwoPartner = null;
    this.oneTwoReadyAt = 0;
    this.calledForPassUntil = 0;
    this.callReadyAt = 0;
    this.yellowCards = 0;
    this.redCard = false;
    this.sentOff = false;
    this.isBench = false;
    this.subbedOut = false;
    this.slotIndex = opts.slotIndex ?? null;
    this.anchor = null;
    this.anchorOut = null;
    this.anchorIn = null;
    this.kickoffFrom = null;
    this.kickoffTo = null;
    this.receptionQuality = 1;
    this.ballHoldTime = 0;
    this.holdWarned = false;
    this.intent = null;                 // human input for this tick
    this.animMode = 'RUN';
    this.kickTimer = 0;
  }

  mult(stat) { return skillToMultiplier(SKILL_CURVE_MAP[stat], this.skills[stat] ?? 50); }
  get topSpeed() { return BASE_SPRINT * this.mult('topSpeed'); }
  get accelRate() { return BASE_ACCEL * this.mult('acceleration'); }
  get turnRate() {
    const holding = this.match && this.match.ball.holder === this;
    return BASE_TURN * this.mult('agility') * (holding ? S.AgileToDirectionWhenHoldingBallModifier : 1);
  }
  get hasBall() { return !!this.match && this.match.ball.holder === this; }
  get attackDir() { return this.match ? this.match.dirFor(this.team) : (this.team === 0 ? 1 : -1); }
  get isGoalKeeper() { return this.role === 'GK'; }

  // field progress 0..1 from own goal line along X (PlayerBase.PlayerFieldProgress)
  get fieldProgress() { return this.match ? this.match.playerFieldProgress(this) : 0.5; }

  // Velocity-led controller. The old CodeBasedController moved *along facing*,
  // which made every reversal carve a circle. Movement now follows the input
  // direction; facing turns toward the movement (or an explicit face target)
  // at a limited rate, and speed is reduced when the desired direction is far
  // from the current velocity.
  move(dt, dirX, dirZ, movementType = MovementType.BestHeCanDo, faceTowards = null, speedScale = 1, mode = this.moveMode) {
    if (this.stamina <= 5) this.sprintExhausted = true;
    const effectiveType = this.sprintExhausted && movementType === MovementType.BestHeCanDo
      ? MovementType.Normal : movementType;
    const profile = MOVE_MODES[mode] ?? MOVE_MODES[MoveMode.Normal];
    this.moveMode = mode;
    const magnitude = Math.hypot(dirX, dirZ);
    if (magnitude < 0.001) { this.stop(dt); return; }
    const nx = dirX / magnitude;
    const nz = dirZ / magnitude;
    const desiredHeading = Math.atan2(nz, nx);

    const currentHeading = this.speed > 0.35 ? Math.atan2(this.vz, this.vx) : this.facing;
    let error = Math.atan2(Math.sin(desiredHeading - currentHeading), Math.cos(desiredHeading - currentHeading));
    const absError = Math.abs(error);
    const faceHeading = faceTowards
      ? Math.atan2(faceTowards.z - this.pos.z, faceTowards.x - this.pos.x)
      : desiredHeading;
    // With an explicit face target (keeper shuffle, face-up dribble) the feet
    // are allowed to move independently of the body; never freeze into a pivot.
    this.turnInPlace = !faceTowards && absError > 1.55 && this.speed < 1.1;
    this.strafeSign = faceTowards && absError > 0.55
      ? Math.sign(Math.sin(desiredHeading - this.facing)) || 0
      : 0;

    // Stop pushing forward while the body is still pivoting; otherwise the
    // player skates sideways during a hard reversal.
    const turnPenalty = 1 - 0.55 * clamp01((absError - 0.35) / 1.4);
    let targetSpeed = this.topSpeed * MOVEMENT_MULT[effectiveType] * profile.speed *
      clamp(speedScale, 0, 1) * turnPenalty;
    if (this.turnInPlace) targetSpeed = 0;

    const facingStep = clamp01(this.turnRate * profile.turn * dt);
    this.facing = angleLerp(this.facing, faceHeading, facingStep);
    if (this.kickTimer <= 0) {
      this.motionState = this.turnInPlace ? 'TURN'
        : this.strafeSign && this.speed > 0.4 ? 'STRAFE'
          : 'RUN';
    }

    const desiredVx = nx * targetSpeed;
    const desiredVz = nz * targetSpeed;
    const slowing = targetSpeed < this.speed;
    const k = clamp01(this.accelRate * (slowing ? 1.9 : profile.accel) * dt);
    this.vx += (desiredVx - this.vx) * k;
    this.vz += (desiredVz - this.vz) * k;
    const speed = Math.hypot(this.vx, this.vz);
    this.speed = speed < 0.02 ? 0 : speed;
    if (this.speed === 0) { this.vx = 0; this.vz = 0; }
    this.sprinting = effectiveType === MovementType.BestHeCanDo && this.speed > 2.5 &&
      mode !== MoveMode.Close && mode !== MoveMode.Shield;

    this.pos.x += this.vx * dt;
    this.pos.z += this.vz * dt;
    if (this.kickTimer <= 0) {
      this.animMode = this.turnInPlace ? 'TURN' : this.speed > 0.6 ? 'RUN' : 'IDLE';
      if (this.motionState !== 'TURN' && this.motionState !== 'STRAFE') {
        this.motionState = this.speed > 5.4 ? 'SPRINT' : this.speed > 0.6 ? 'RUN' : 'IDLE';
      }
    }
    this.updateLocomotion(dt, targetSpeed);
  }

  locoStrideFor(state) {
    let stride = LOCO_STRIDE[state] ?? LOCO_STRIDE.WALK;
    if (this.moveMode === MoveMode.Shield) stride *= 0.78;
    else if (this.moveMode === MoveMode.Close) stride *= 0.88;
    return stride;
  }

  syncLocoContact(active = this.locoState !== LocoState.Idle && this.speed > 0.2) {
    this.locoFoot = this.locoPhase < 0.5 ? 'L' : 'R';
    this.locoContact = active && this.locoPhase % 0.5 < LOCO_CONTACT_FRACTION;
  }

  // Hysteresis keeps the gait from flickering at threshold speeds; phase is
  // advanced by distance travelled, not wall time, so clips stay ground-locked.
  updateLocomotion(dt, targetSpeed = 0) {
    if (!Number.isFinite(dt) || dt <= 0) { this.syncLocoContact(); return; }
    this.locoStateTime += dt;
    const speed = this.speed;
    const previous = this.locoState;
    let state = previous;

    if (this.turnInPlace) state = LocoState.Turn;
    else if (this.strafeSign && speed > 0.4) state = LocoState.Strafe;
    else if (targetSpeed < 0.25 && speed > LOCO_STOP_SPEED && speed > 0.2) state = LocoState.Stop;
    else if (speed > LOCO_STOP_SPEED) {
      if (speed >= (previous === LocoState.Sprint ? LOCO_SPRINT_EXIT : LOCO_SPRINT_ENTER)) state = LocoState.Sprint;
      else if (previous === LocoState.Sprint) state = LocoState.Run;
      else if (speed >= (previous === LocoState.Run ? LOCO_RUN_EXIT : LOCO_RUN_ENTER)) state = LocoState.Run;
      else if (previous === LocoState.Run) state = LocoState.Walk;
      else if (previous === LocoState.Idle || previous === LocoState.Stop ||
        previous === LocoState.Turn || previous === LocoState.Strafe) {
        state = speed < LOCO_START_DONE && targetSpeed > LOCO_START_SPEED ? LocoState.Start : LocoState.Walk;
      } else if (previous === LocoState.Start) {
        if (speed >= LOCO_START_DONE || this.locoStateTime > 0.22) state = LocoState.Walk;
      }
    } else {
      state = previous === LocoState.Stop && this.locoStateTime < 0.18 ? LocoState.Stop : LocoState.Idle;
    }

    this.locoState = state;
    if (state !== previous) this.locoStateTime = 0;
    if (state === LocoState.Idle) this.locoPhase = 0;
    else if (state === LocoState.Start && previous !== LocoState.Start) this.locoPhase = 0;

    this.locoStride = this.locoStrideFor(state);
    const advancing = state !== LocoState.Idle;
    if (advancing && speed > 0.2) {
      this.locoPhase = (this.locoPhase + (speed * dt) / this.locoStride) % 1;
    }
    this.syncLocoContact(advancing && speed > 0.2);
  }

  // CodeBasedController.MoveTo compatibility: AI keeps calling this, but the
  // motion is now velocity-led and arrival-damped.
  moveTo(dt, to, faceTowards = null, movementType = MovementType.BestHeCanDo) {
    const dx = to.x - this.pos.x;
    const dz = to.z - this.pos.z;
    const distance = Math.hypot(dx, dz);
    if (distance < 0.08) {
      this.stop(dt);
      if (faceTowards) this.lookTo(dt, faceTowards);
      return;
    }
    const dirX = dx / distance;
    const dirZ = dz / distance;
    const arrival = clamp(distance / Math.max(0.25, this.speed * 0.45), 0.35, 1);
    this.move(dt, dirX, dirZ, movementType, faceTowards, arrival, this.moveMode);
    const stepX = this.vx * dt;
    const stepZ = this.vz * dt;
    if (Math.hypot(stepX, stepZ) >= distance) {
      this.pos.x = to.x;
      this.pos.z = to.z;
      this.vx = 0;
      this.vz = 0;
      this.speed = 0;
      this.motionState = 'IDLE';
      this.updateLocomotion(dt, 0);
    }
  }

  updateStamina(dt) {
    this.stamina = Math.max(0, Math.min(100, this.stamina + (this.sprinting ? -8 : 15) * dt));
    if (this.stamina <= 5) this.sprintExhausted = true;
    if (this.stamina >= 20) this.sprintExhausted = false;
  }

  updateStability(dt) {
    const resilience = 0.55 + this.skills.strength / 200 + this.skills.agility / 260;
    this.balance = Math.min(1, this.balance + resilience * dt);
    this.jostle = Math.max(0, this.jostle - 3.5 * dt);
  }

  stop(dt) {
    this.sprinting = false;
    const k = clamp01(this.accelRate * 2.2 * dt);
    this.vx += (0 - this.vx) * k;
    this.vz += (0 - this.vz) * k;
    this.speed = Math.hypot(this.vx, this.vz);
    if (this.speed < 0.05) { this.speed = 0; this.vx = 0; this.vz = 0; }
    this.turnInPlace = false;
    this.strafeSign = 0;
    if (this.kickTimer <= 0) { this.animMode = 'IDLE'; this.motionState = this.speed > 0.3 ? 'STOP' : 'IDLE'; }
    this.updateLocomotion(dt, 0);
  }

  lookTo(dt, to) {
    const heading = Math.atan2(to.z - this.pos.z, to.x - this.pos.x);
    const error = Math.abs(Math.atan2(Math.sin(heading - this.facing), Math.cos(heading - this.facing)));
    this.facing = angleLerp(this.facing, heading, clamp01(this.turnRate * dt));
    this.turnInPlace = error > 1.55 && this.speed < 1.1;
    if (this.turnInPlace && this.kickTimer <= 0) this.motionState = 'TURN';
  }

  setInstantPosition(x, z, facing = this.facing) {
    V.set(this.pos, x, 0, z);
    this.facing = facing;
    this.speed = 0;
    this.vx = 0;
    this.vz = 0;
    this.turnInPlace = false;
    this.strafeSign = 0;
    this.motionState = 'IDLE';
    this.locoState = LocoState.Idle;
    this.locoStateTime = 0;
    this.locoPhase = 0;
    this.locoFoot = null;
    this.locoContact = false;
    this.locoStride = LOCO_STRIDE.WALK;
  }

  get stunned() { return this.match && this.match.time < this.stunnedUntil; }
}

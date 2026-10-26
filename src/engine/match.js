import { Ball, BALL_RADIUS } from './ball.js';
import { createGoalFrame, sweepSphereCapsule, POST_RADIUS } from './ballCollision.js';
import { Player, Acts, MovementType, MoveMode } from './player.js';
import { Team, TACTIC_PRESETS } from './team.js';
import { outfieldBehaviours, keeperBehaviours } from './behaviours/index.js';
import { evaluateAttack } from './attackDecision.js';
import { shotGeometry, shotXG } from './analytics/xg.js';
import {
  getFormation, defaultFormationId, attackingFormationId, defensiveFormationId,
  applyRolePlan, benchSlots, makeAnchor, makePhaseAnchor
} from '../config/formations.js';
import { roleBand, roleMeta, defaultDuty, skillBiasForRole } from './roles.js';
import { EngineSettings as S } from './settings.js';
import { createSeededPRNG } from '../core/rng.js';
import { Emitter } from '../core/events.js';
import * as V from './vec.js';
import { clamp, clamp01, lerp, segDist2D } from '../core/math.js';
import positionProfiles from '../data/positionProfiles.json' with { type: 'json' };

export const MatchStatus = { NotPlaying: 1, WaitingForKickOff: 2, Playing: 4, Freeze: 8, Special: 16 };
export const Phase = { WARMUP: 'WARMUP', COUNTDOWN: 'COUNTDOWN', LIVE: 'LIVE', GOAL_CELEB: 'GOAL_CELEB', HALF_TIME: 'HALF_TIME', ENDED: 'ENDED' };

const SKIP_RATE_BY_AI_LEVEL = [0, 4, 8, 14, 22]; // Amateur..Legendary
const MIN_SEP = 0.72;
const CONTACT_RADIUS = 1.18;
const DUEL_COOLDOWN = 0.6;
const MAX_CONTACT_IMPULSE = 3.2;
const BEHAVIOUR_STICKY = 0.2; // BEHAVIOUR_CHANGE_OFFSET_AS_SECONDS
const ACTION_PRIORITY = { pass: 1, cross: 2, through: 2, shoot: 3, skill: 1, tackle: 1 };
const INPUT_BUFFER_SECONDS = 0.18;
const STRIKE_CANCEL_WINDOW = 0.05;

function makeAnchors(n) {
  const out = [{ role: 'GK', h: 0.5, v: 0.06, band: 'GK' }];
  const fielders = n - 1;
  const bands = [
    { v: 0.26, role: 'CB', band: 'CB' },
    { v: 0.52, role: 'CM', band: 'CM' },
    { v: 0.80, role: 'ST', band: 'ST' }
  ];
  const per = [Math.ceil(fielders / 3), Math.ceil(fielders / 3), fielders - 2 * Math.ceil(fielders / 3)];
  let i = 0;
  for (let b = 0; b < 3; b++) {
    const count = per[b];
    for (let k = 0; k < count && i < fielders; k++, i++) {
      const h = count === 1 ? 0.5 : 0.5 + (k / (count - 1) - 0.5) * 0.72;
      out.push({ role: bands[b].role, band: bands[b].band, h, v: bands[b].v });
    }
  }
  return out;
}

function skillsFor(band, rng) {
  const prof = positionProfiles[band] ?? positionProfiles.CM;
  const s = {};
  for (const [k, v] of Object.entries(prof.skills)) s[k] = clamp(Math.round(v + rng.range(-6, 6)), 20, 100);
  return s;
}

function roleSkills(band, role, rng) {
  const s = skillsFor(band, rng);
  for (const [key, value] of Object.entries(skillBiasForRole(role))) {
    if (s[key] != null) s[key] = clamp(s[key] + value, 20, 100);
  }
  return s;
}

function ratingFor(s) {
  const base = 6 + s.goals * 1.1 + s.assists * 0.7 + s.shots * 0.04 + s.passesCompleted * 0.012 +
    s.tackles * 0.12 + s.saves * 0.22 - s.fouls * 0.08 - s.yellow * 0.18 - s.red * 0.45;
  return Math.max(3.5, Math.min(10, Math.round(base * 10) / 10));
}

// Hungarian assignment (O(n^3)); returns the row assigned to each column.
function solveAssignment(cost) {
  const n = cost.length;
  if (!n) return [];
  const u = new Array(n + 1).fill(0);
  const v = new Array(n + 1).fill(0);
  const p = new Array(n + 1).fill(0);
  const way = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(n + 1).fill(Infinity);
    const used = new Array(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
        else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }
  const assignment = new Array(n).fill(null);
  for (let j = 1; j <= n; j++) if (p[j] > 0) assignment[j - 1] = p[j] - 1;
  return assignment;
}

export class Match {
  constructor(cfg, opts = {}) {
    this.cfg = cfg;
    this.rng = createSeededPRNG(opts.seed ?? 12345);
    this.events = new Emitter();
    this.fieldLength = cfg.pitchLength;
    this.fieldWidth = cfg.pitchWidth;
    this.fieldHalfX = cfg.pitchLength / 2;
    this.fieldHalfZ = cfg.pitchWidth / 2;
    this.goalNets = [V.v3(-this.fieldHalfX, 0, 0), V.v3(this.fieldHalfX, 0, 0)];
    this.goalFrame = createGoalFrame(this.fieldHalfX, cfg.goalW, cfg.goalH);
    this.ball = new Ball(this);
    this.teams = [new Team(this, 0, opts.teamOpts?.[0]), new Team(this, 1, opts.teamOpts?.[1])];
    this.score = [0, 0];
    this.time = 0;
    this.clockSec = 0;
    this.phase = Phase.COUNTDOWN;
    this.countdown = 3;
    this.celebTimer = 0;
    this.half = 1;
    this.halfDuration = cfg.durationSec / 2;
    this.matchMinutes = cfg.matchMinutes ?? 90;
    this.clockScale = (this.matchMinutes * 60) / Math.max(1, cfg.durationSec);
    this.walkIn = 0;
    this.walkInDuration = 1;
    this.addedTime = [0, 0];
    this.halfStoppage = 0;
    this.halftimeTimer = 0;
    this.sideSwapped = false;
    this.firstKickoffTeam = 0;
    this.advantage = null;
    this.pendingCard = null;
    this.cards = [{ yellow: 0, red: 0 }, { yellow: 0, red: 0 }];
    this.fouls = [0, 0];
    this.offsides = [0, 0];
    this.penalty = null;
    this.freeKickInfo = null;
    this.indirectFreeKick = false;
    this.cardCutscene = null;
    this.freezeUntil = 0;
    this.aiLevel = opts.aiLevel ?? 2;
    this.setPiece = null;
    this.setPieceTeam = -1;
    this.restrictedGoalBy = null;
    this.cornerKick = false;
    this.passStreak = [0, 0];
    this.players = [];
    this.teamOpts = opts.teamOpts ?? [{}, {}];
    this.pendingFormations = [null, null];
    this.aiTacticAt = 0;
    this.hasHuman = opts.humanSlot != null;
    this.stats = {
      possession: [0, 0], shots: [0, 0], onTarget: [0, 0], xg: [0, 0],
      passes: [0, 0], passesCompleted: [0, 0], crosses: [0, 0],
      corners: [0, 0], saves: [0, 0], tackles: [0, 0], throwIns: [0, 0], goalKicks: [0, 0],
      duels: [0, 0], duelsWon: [0, 0]
    };
    this.playerStats = new Map();
    this.lastAssistCandidate = null;
    this.aiSubCheckAt = 0;
    this.backpassCallAt = -10;
    this.buildRosters(opts);
    this.resetKickoff(0, true);
  }

  buildRosters(opts) {
    for (const team of this.teams) {
      const requested = this.teamOpts?.[team.id] ?? {};
      const requestedId = requested.formation ?? this.cfg.defaultFormation ?? defaultFormationId(this.cfg.id);
      let formation = getFormation(this.cfg.id, requestedId) ?? getFormation(this.cfg.id, defaultFormationId(this.cfg.id));
      let slots;
      if (formation && formation.slots.length === this.cfg.teamSize) {
        slots = formation.slots;
      } else {
        // Custom test/config fallback: keep the legacy band anchors.
        slots = makeAnchors(this.cfg.teamSize).map((a, i) => {
          const role = this.cfg.roles?.[i] ?? a.role;
          return { role, duty: defaultDuty(role), h: a.h, v: a.v };
        });
        formation = { id: 'custom', name: 'CUSTOM', style: 'balanced', description: '', slots };
      }
      team.formation = formation;
      team.formationId = formation.id;
      team.tactic = requested.tactic && TACTIC_PRESETS[requested.tactic] ? requested.tactic : 'Balanced';

      slots.forEach((slot, i) => {
        const isHuman = opts.humanSlot != null && team.id === 0 && i === opts.humanSlot;
        const band = roleBand(slot.role);
        const p = new Player({
          id: `${team.id}-${i}`, team: team.id, role: slot.role, duty: slot.duty,
          name: `${team.id === 0 ? 'H' : 'A'}${i}`,
          skills: roleSkills(band, slot.role, this.rng), isHuman, slotIndex: i
        });
        p.anchorOut = makeAnchor(slot);
        p.anchorIn = makePhaseAnchor(slot);
        p.anchor = p.anchorOut;
        p.behaviours = band === 'GK' ? keeperBehaviours() : outfieldBehaviours();
        p.match = this;
        team.addPlayer(p);
        this.players.push(p);
      });

      const benchSize = this.cfg.benchSize ?? 5;
      benchSlots(this.cfg.id, benchSize).forEach((slot, i) => {
        const band = roleBand(slot.role);
        const p = new Player({
          id: `${team.id}-b${i}`, team: team.id, role: slot.role, duty: slot.duty,
          name: `${team.id === 0 ? 'H' : 'A'}S${i + 1}`,
          skills: roleSkills(band, slot.role, this.rng)
        });
        p.anchorOut = makeAnchor(slot);
        p.anchorIn = makePhaseAnchor(slot);
        p.anchor = p.anchorOut;
        p.behaviours = band === 'GK' ? keeperBehaviours() : outfieldBehaviours();
        p.match = this;
        p.isBench = true;
        team.bench.push(p);
      });
    }
    this.assignMarking();
  }

  isDeadBall() {
    return this.phase !== Phase.LIVE || this.time < this.freezeUntil || this.setPiece !== null;
  }

  substitute(teamId, outId, inId, atHalftime = false) {
    const team = this.teams[teamId];
    if (!team) return { ok: false, reason: 'UNKNOWN_TEAM' };
    const out = team.players.find((p) => p.id === outId);
    const incoming = team.bench.find((p) => p.id === inId);
    if (!out || !incoming || incoming.subbedOut) return { ok: false, reason: 'UNKNOWN_PLAYER' };
    if (out.sentOff) return { ok: false, reason: 'SENT_OFF' };
    if (out.subbedOut) return { ok: false, reason: 'ALREADY_SUBBED' };
    if (out.isGoalKeeper && !incoming.isGoalKeeper) return { ok: false, reason: 'GK_NEEDS_KEEPER' };
    if (team.subsUsed >= 5) return { ok: false, reason: 'NO_SUBSTITUTIONS' };
    const halftime = atHalftime && this.phase === Phase.HALF_TIME;
    const deadBall = halftime || this.phase !== Phase.LIVE || this.time < this.freezeUntil || this.setPiece !== null;
    if (!deadBall) return { ok: false, reason: 'NOT_STOPPAGE' };
    if (!halftime && !team.subWindowOpen) {
      if (team.subWindowsUsed >= 3) return { ok: false, reason: 'NO_WINDOWS' };
      team.subWindowsUsed++;
      team.subWindowOpen = true;
    }
    team.subsUsed++;
    const wasHuman = out.isHuman;
    const outIndex = team.players.indexOf(out);
    team.players.splice(outIndex, 1, incoming);
    const matchIndex = this.players.indexOf(out);
    if (matchIndex >= 0) this.players.splice(matchIndex, 1, incoming);
    const benchIndex = team.bench.indexOf(incoming);
    if (benchIndex >= 0) team.bench.splice(benchIndex, 1);
    out.subbedOut = true;
    incoming.isBench = false;
    incoming.isHuman = wasHuman;
    incoming.ballContactReadyAt = 0;
    incoming.stamina = 100;
    incoming.pendingStrike = null;
    incoming.activeBehaviour = null;
    incoming.nextBehaviourTime = this.time;
    incoming.role = out.role;
    incoming.duty = out.duty;
    incoming.slotIndex = out.slotIndex;
    incoming.anchorOut = out.anchorOut ? { ...out.anchorOut } : incoming.anchorOut;
    incoming.anchorIn = out.anchorIn ? { ...out.anchorIn } : incoming.anchorIn;
    incoming.anchor = incoming.anchorOut;
    incoming.behaviours = out.isGoalKeeper ? keeperBehaviours() : outfieldBehaviours();
    incoming.setInstantPosition(out.pos.x, out.pos.z, out.facing);
    incoming.isThrowHolder = out.isThrowHolder;
    incoming.isGoalKickHolder = out.isGoalKickHolder;
    incoming.isCornerHolder = out.isCornerHolder;
    out.slotIndex = null;
    out.isBench = true;
    out.isHuman = false;
    out.activeBehaviour = null;
    out.intent = null;
    out.isThrowHolder = false;
    out.isGoalKickHolder = false;
    out.isCornerHolder = false;
    if (this.ball.holder === out) this.ball.hold(incoming);
    if (this.penalty?.taker === out) this.penalty.taker = incoming;
    if (!halftime) {
      this.addStoppage(10);
      this.freezeUntil = Math.max(this.freezeUntil, this.time + 1.2);
    }
    this.assignMarking();
    this.events.emit('Substitution', {
      team: teamId,
      out,
      incoming,
      humanChanged: wasHuman,
      atHalftime: halftime,
      subsUsed: team.subsUsed,
      windows: team.subWindowsUsed
    });
    return { ok: true, humanChanged: wasHuman };
  }

  aiSubstitutions(teamId, atHalftime = false) {
    const team = this.teams[teamId];
    if (!team || team.subsUsed >= 5) return 0;
    const out = team.players
      .filter((p) => !p.isGoalKeeper && !p.sentOff)
      .sort((a, b) => a.stamina - b.stamina)[0];
    if (!out || out.stamina > (atHalftime ? 72 : 46)) return 0;
    const bench = team.bench.filter((p) => !p.isGoalKeeper);
    const sameBand = bench.find((p) => p.anchor.band === out.anchor.band);
    const incoming = sameBand ?? bench[0];
    if (!incoming) return 0;
    const result = this.substitute(teamId, out.id, incoming.id, atHalftime);
    return result.ok ? 1 : 0;
  }

  considerAiSubs() {
    if (this.phase === Phase.ENDED || this.time < this.aiSubCheckAt) return;
    this.aiSubCheckAt = this.time + 25;
    for (const team of this.teams) {
      if (this.hasHuman && team.id === 0) continue;
      if (team.subsUsed < 5) this.aiSubstitutions(team.id, false);
    }
  }

  applySlotToPlayer(p, slot, slotIndex) {
    const wasKeeper = p.isGoalKeeper;
    p.role = slot.role;
    p.duty = slot.duty;
    p.slotIndex = slotIndex;
    p.anchorOut = makeAnchor(slot);
    p.anchorIn = makePhaseAnchor(slot);
    p.anchor = p.anchorOut;
    if (wasKeeper !== p.isGoalKeeper) p.behaviours = p.isGoalKeeper ? keeperBehaviours() : outfieldBehaviours();
    p.activeBehaviour = null;
    p.intent = null;
    p.nextBehaviourTime = this.time;
  }

  // Minimum-cost assignment keeps role groups and sides stable across a shape change.
  assignPlayersToSlots(players, formation) {
    const slots = formation.slots.slice(1).map((slot, i) => ({ slot, index: i + 1 }));
    const size = Math.max(players.length, slots.length);
    if (!size) return [];
    const matrix = Array.from({ length: size }, () => Array(size).fill(0));
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) {
        if (i >= players.length || j >= slots.length) {
          matrix[i][j] = i < players.length ? 25 : 0;
          continue;
        }
        const p = players[i];
        const entry = slots[j];
        const group = roleMeta(p.role).group;
        const target = roleMeta(entry.slot.role).group;
        const groupCost = group === target ? 0
          : (group === 'DEF' && target === 'FWD') || (group === 'FWD' && target === 'DEF') ? 6 : 2.5;
        const roleCost = p.role === entry.slot.role ? 0 : 0.5;
        const hCost = Math.abs((p.anchorOut?.h ?? 0.5) - entry.slot.h) * 2.4;
        const vCost = Math.abs((p.anchorOut?.v ?? 0.5) - entry.slot.v) * 0.8;
        const specialist = (entry.slot.role === 'DM' && group !== 'MID') ||
          (entry.slot.role === 'CB' && group !== 'DEF') ||
          (entry.slot.role === 'ST' && group !== 'FWD') ? 4 : 0;
        let cost = groupCost + roleCost + hCost + vCost + specialist;
        // Never turn the human's role group into a surprise unless it is unavoidable.
        if (p.isHuman && group !== target) cost += 6;
        matrix[i][j] = cost;
      }
    }
    const assigned = solveAssignment(matrix);
    const out = [];
    for (let j = 0; j < slots.length; j++) {
      const i = assigned[j];
      if (i == null || i >= players.length) continue;
      out.push({ player: players[i], slot: slots[j].slot, slotIndex: slots[j].index });
    }
    return out;
  }

  setTeamFormation(teamId, formationId, rolePlan = null, options = {}) {
    const team = this.teams[teamId];
    const base = getFormation(this.cfg.id, formationId);
    if (!team || !base) return { ok: false, reason: 'UNKNOWN_FORMATION' };
    if (base.slots.length !== this.cfg.teamSize) return { ok: false, reason: 'FORMATION_SIZE' };
    const formation = applyRolePlan(base, rolePlan);
    const active = team.players.filter((p) => !p.sentOff && !p.subbedOut);
    const keeper = active.find((p) => p.isGoalKeeper) ?? active[0];
    const outfield = active.filter((p) => p !== keeper);
    const preserve = options.preserveSlots === true;
    let assignments;
    if (preserve) {
      assignments = outfield.map((p) => {
        const index = Number.isInteger(p.slotIndex) && p.slotIndex > 0 && p.slotIndex < formation.slots.length
          ? p.slotIndex : 1;
        return { player: p, slot: formation.slots[index], slotIndex: index };
      });
    } else {
      assignments = this.assignPlayersToSlots(outfield, formation);
    }
    if (keeper) this.applySlotToPlayer(keeper, formation.slots[0], 0);
    for (const entry of assignments) this.applySlotToPlayer(entry.player, entry.slot, entry.slotIndex);
    team.formation = formation;
    team.formationId = formation.id;
    this.assignMarking();
    this.events.emit('FormationChanged', {
      team: teamId, formation: formation.id, name: formation.name, style: formation.style, preserve
    });
    return { ok: true, formation: formation.id };
  }

  setTeamRoles(teamId, rolePlan) {
    const team = this.teams[teamId];
    if (!team?.formation) return { ok: false, reason: 'NO_FORMATION' };
    const formation = applyRolePlan(team.formation, rolePlan);
    for (const p of team.players) {
      if (p.sentOff || p.subbedOut || p.isBench) continue;
      const slot = formation.slots[p.slotIndex ?? -1];
      if (slot) this.applySlotToPlayer(p, slot, p.slotIndex);
    }
    team.formation = formation;
    this.assignMarking();
    this.events.emit('FormationChanged', {
      team: teamId, formation: formation.id, name: formation.name, style: formation.style, rolesOnly: true
    });
    return { ok: true, formation: formation.id };
  }

  queueFormation(teamId, formationId, rolePlan = null) {
    const team = this.teams[teamId];
    const target = getFormation(this.cfg.id, formationId);
    if (!team || !target) return { ok: false, reason: 'UNKNOWN_FORMATION' };
    const sameShape = team.formationId === formationId;
    const apply = () => sameShape ? this.setTeamRoles(teamId, rolePlan) : this.setTeamFormation(teamId, formationId, rolePlan);
    if (this.isDeadBall()) return { ...apply(), applied: true, pending: false };
    this.pendingFormations[teamId] = { formationId, rolePlan };
    this.events.emit('GamePlanQueued', { team: teamId, formation: formationId });
    return { ok: true, applied: false, pending: true };
  }

  applyPendingFormations() {
    if (this.phase === Phase.ENDED || !this.isDeadBall()) return;
    for (const team of this.teams) {
      const plan = this.pendingFormations[team.id];
      if (!plan) continue;
      this.pendingFormations[team.id] = null;
      if (plan.formationId === team.formationId) this.setTeamRoles(team.id, plan.rolePlan);
      else this.setTeamFormation(team.id, plan.formationId, plan.rolePlan);
    }
  }

  setTeamTactic(teamId, tacticId) {
    const team = this.teams[teamId];
    if (!team || !TACTIC_PRESETS[tacticId]) return { ok: false, reason: 'UNKNOWN_TACTIC' };
    if (team.tactic === tacticId) return { ok: true, unchanged: true };
    team.tactic = tacticId;
    this.events.emit('TacticChanged', { team: teamId, tactic: tacticId });
    return { ok: true, unchanged: false };
  }

  updateAiTactics({ force = false, allowFormation = false } = {}) {
    if (this.phase === Phase.ENDED) return;
    if (!force && this.time < this.aiTacticAt) return;
    this.aiTacticAt = this.time + 6;
    const progress = clamp01(this.clockSec / Math.max(1, this.cfg.durationSec));
    for (const team of this.teams) {
      if (this.hasHuman && team.id === 0) continue;
      const diff = this.score[team.id] - this.score[1 - team.id];
      let tactic = null;
      if (this.phase === Phase.HALF_TIME && allowFormation) {
        if (diff <= -1) {
          tactic = 'Offensive';
          const attack = attackingFormationId(this.cfg.id);
          if (attack && team.formationId !== attack) this.setTeamFormation(team.id, attack);
        } else if (diff >= 1) {
          tactic = 'Defensive';
          const defend = defensiveFormationId(this.cfg.id);
          if (defend && team.formationId !== defend) this.setTeamFormation(team.id, defend);
        }
      } else if (diff <= -1) {
        tactic = progress > 0.70 ? 'Offensive' : progress > 0.50 ? 'HighPressure' : null;
      } else if (diff >= 1) {
        tactic = progress > 0.85 ? 'ParkTheBus' : progress > 0.70 ? 'Defensive' : null;
      }
      if (tactic) this.setTeamTactic(team.id, tactic);
    }
  }

  ensurePlayerStat(p) {
    if (!p) return null;
    let s = this.playerStats.get(p.id);
    if (!s) {
      s = {
        id: p.id, name: p.name, team: p.team, role: p.role,
        goals: 0, assists: 0, shots: 0, passes: 0, passesCompleted: 0,
        tackles: 0, saves: 0, fouls: 0, yellow: 0, red: 0
      };
      this.playerStats.set(p.id, s);
    }
    return s;
  }

  recordPassAttempt(hitter, kind = 'pass') {
    this.stats.passes[hitter.team]++;
    if (kind === 'cross') this.stats.crosses[hitter.team]++;
    const s = this.ensurePlayerStat(hitter);
    if (s) s.passes++;
    this.lastAssistCandidate = { passerId: hitter.id, team: hitter.team, at: this.time };
  }

  onBallControlled(p) {
    if (this.ball.lastShot && this.ball.lastShot.team !== p.team) this.ball.lastShot = null;
    const pass = this.ball.lastPass;
    this.ball.lastPass = null;
    if (!pass) return;
    if (pass.team === p.team) {
      this.stats.passesCompleted[p.team]++;
      const s = this.playerStats.get(pass.passerId);
      if (s) s.passesCompleted++;
      this.lastAssistCandidate = { passerId: pass.passerId, team: pass.team, at: this.time };
    } else {
      this.lastAssistCandidate = null;
      this.ball.lastKickBy = p;
      this.ball.lastKickAt = this.time;
      this.ball.lastKickKind = 'control';
      for (const q of this.players) q.isInOffside = false;
    }
  }

  isBackpass(p) {
    const b = this.ball;
    return !!b.lastKickBy && b.lastKickBy.id !== p.id && b.lastKickBy.team === p.team &&
      b.lastKickKind === 'kick' && this.time - b.lastKickAt < 4;
  }

  get status() {
    if (this.phase === Phase.LIVE) return this.time < this.freezeUntil ? MatchStatus.Freeze : MatchStatus.Playing;
    if (this.phase === Phase.COUNTDOWN) return MatchStatus.WaitingForKickOff;
    return MatchStatus.NotPlaying;
  }

  dirFor(teamId) {
    return Math.sign(this.goalNets[1 - teamId].x - this.goalNets[teamId].x) || 1;
  }

  playerFieldProgress(p) {
    const own = this.teams[p.team].ownGoal.x;
    return clamp01(Math.abs(p.pos.x - own) / this.fieldLength);
  }

  computeOffsideLine(team) {
    const defs = this.teams[1 - team.id].players.slice().sort((a, b) =>
      Math.abs(a.pos.x - this.goalNets[1 - team.id].x) - Math.abs(b.pos.x - this.goalNets[1 - team.id].x));
    return defs[1] ? defs[1].pos.x : defs[0]?.pos.x ?? 0;
  }

  assignMarking() {
    for (const team of this.teams) {
      const opp = this.teams[1 - team.id].fielders.slice()
        .sort((a, b) => b.anchor.v - a.anchor.v);
      const defs = team.fielders.slice().sort((a, b) => a.anchor.v - b.anchor.v);
      defs.forEach((d, i) => { d.markingTarget = opp[i] ?? null; });
    }
  }

  resetKickoff(kickingTeam, initial = false) {
    for (const team of this.teams) team.subWindowOpen = false;
    this.freezeUntil = 0;
    this.ball.reset(V.v3(0, BALL_RADIUS, 0));
    const kicker = this.teams[kickingTeam].players.find((p) => p.anchor.v > 0.7 && !p.isGoalKeeper && !p.sentOff)
      ?? this.teams[kickingTeam].players.find((p) => !p.isGoalKeeper && !p.sentOff);

    for (const team of this.teams) {
      const dir = team.dir;
      const ownX = this.goalNets[team.id].x;
      for (const p of team.players) {
        if (p.sentOff) continue;
        p.stunnedUntil = 0;
        p.ballHoldTime = 0;
        p.activeBehaviour = null;
        p.isThrowHolder = false;
        p.isGoalKickHolder = false;
        p.isInOffside = false;
        p.intent = null;
        p.kickTimer = 0;
        p.diveTimer = 0;
        p.feintUntil = 0;
        p.feintImmuneUntil = 0;
        p.ballContactReadyAt = 0;
        p.pendingStrike = null;
        p.oneTwoUntil = -1;
        p.oneTwoPartner = null;
        p.jumpTimer = 0;
        p.jumpHeight = 0;
        p.animMode = 'IDLE';

        if (p === kicker) {
          const x = -dir * 0.5;
          p.setInstantPosition(x, 0, dir > 0 ? 0 : Math.PI);
          p.kickoffFrom = { x, z: 0 };
          p.kickoffTo = { x, z: 0 };
          continue;
        }

        const hRaw = team.id === 0 ? p.anchor.h : 1 - p.anchor.h;
        const h = 0.5 + (hRaw - 0.5) * 0.88;
        const targetV = p.isGoalKeeper ? 0.06 : clamp(0.12 + p.anchor.v * 0.40, 0.10, 0.47);
        let targetX = clamp(ownX + dir * targetV * this.fieldLength, -this.fieldHalfX + 1, this.fieldHalfX - 1);
        let targetZ = clamp((h - 0.5) * this.fieldWidth, -this.fieldHalfZ + 1, this.fieldHalfZ - 1);
        if (Math.hypot(targetX, targetZ) < 9.2) {
          targetX = -dir * 9.2;
          targetZ = clamp(targetZ, -this.fieldHalfZ + 2, this.fieldHalfZ - 2);
        }
        const fromV = p.isGoalKeeper ? targetV : Math.max(0.05, targetV - 0.08);
        const fromX = clamp(ownX + dir * fromV * this.fieldLength, -this.fieldHalfX + 1, this.fieldHalfX - 1);
        const fromZ = clamp((h - 0.5) * this.fieldWidth * 1.04, -this.fieldHalfZ + 1, this.fieldHalfZ - 1);
        p.setInstantPosition(fromX, fromZ, dir > 0 ? 0 : Math.PI);
        p.kickoffFrom = { x: fromX, z: fromZ };
        p.kickoffTo = { x: targetX, z: targetZ };
      }
    }

    if (kicker) this.ball.hold(kicker);
    this.walkInDuration = initial ? 1.6 : 1.1;
    this.walkIn = this.walkInDuration;
    this.setPiece = 'KICKOFF';
    this.phase = Phase.COUNTDOWN;
    this.countdown = initial ? 3 : 2;
    if (initial) this.firstKickoffTeam = kickingTeam;
    this.events.emit('KickOff', { team: kickingTeam });
  }

  addStoppage(seconds) {
    this.halfStoppage += seconds;
  }

  beginHalfTime() {
    this.phase = Phase.HALF_TIME;
    this.halftimeTimer = 8;
    this.addedTime[0] = this.currentAdded(1);
    for (const p of this.players) { p.intent = null; p.stop(0.1); }
    this.updateAiTactics({ force: true, allowFormation: true });
    for (const team of this.teams) {
      if (this.hasHuman && team.id === 0) continue;
      let guard = 0;
      while (guard++ < 2 && this.aiSubstitutions(team.id, true)) { /* use the interval */ }
    }
    this.events.emit('HalfTime', {
      half: 1,
      score: [...this.score],
      clockSec: this.clockSec,
      addedTime: [...this.addedTime],
      stats: this.statsSnapshot()
    });
  }

  startSecondHalf() {
    if (this.phase !== Phase.HALF_TIME) return false;
    const first = this.goalNets[0];
    this.goalNets[0] = this.goalNets[1];
    this.goalNets[1] = first;
    for (const p of this.players) {
      const facing = Math.atan2(Math.sin(Math.PI - p.facing), Math.cos(Math.PI - p.facing));
      p.setInstantPosition(-p.pos.x, p.pos.z, facing);
    }
    this.half = 2;
    this.sideSwapped = true;
    this.halfStoppage = 0;
    this.addedTime[1] = 0;
    this.resetKickoff(1 - this.firstKickoffTeam);
    this.events.emit('SecondHalf', { half: 2, goalX: this.goalNets.map((g) => g.x) });
    return true;
  }

  currentAdded(half = this.half) {
    const maxByDisplay = (5 * 60) / this.clockScale;
    const maxAdded = Math.max(10, Math.min(this.cfg.durationSec * 0.12, maxByDisplay));
    const value = Math.min(maxAdded, Math.round(this.halfStoppage * 0.6));
    if (half === 1) this.addedTime[0] = value;
    else this.addedTime[1] = value;
    return value;
  }

  get displayClockSec() {
    const halfMatch = this.matchMinutes * 30;
    const fullMatch = this.matchMinutes * 60;
    if (this.phase === Phase.HALF_TIME) return halfMatch;
    if (this.phase === Phase.ENDED) return fullMatch;
    if (this.half === 1) return Math.min(halfMatch, this.clockSec * this.clockScale);
    const secondStartReal = this.halfDuration + this.addedTime[0];
    return Math.min(fullMatch, halfMatch + Math.max(0, this.clockSec - secondStartReal) * this.clockScale);
  }

  get displayAddedMinutes() {
    const index = this.phase === Phase.ENDED ? 1 : this.half - 1;
    const realAdded = this.addedTime[index] ?? 0;
    if (!realAdded) return 0;
    if (this.phase !== Phase.HALF_TIME && this.phase !== Phase.ENDED) {
      const halfEndReal = this.half === 1 ? this.halfDuration : this.cfg.durationSec;
      const showWindow = Math.min(90, this.halfDuration * 0.25);
      if (this.clockSec < halfEndReal - showWindow) return 0;
    }
    return Math.max(1, Math.min(5, Math.ceil((realAdded * this.clockScale) / 60)));
  }

  // ------------------------------------------------------------- main step
  step(dt) {
    this.time += dt;
    if (this.phase === Phase.ENDED) return;
    if (this.pendingFormations.some(Boolean) && this.isDeadBall()) this.applyPendingFormations();

    if (this.phase === Phase.COUNTDOWN) {
      this.countdown -= dt;
      this.walkIn = Math.max(0, this.walkIn - dt);
      const progress = clamp01(1 - this.walkIn / Math.max(0.001, this.walkInDuration));
      const eased = 1 - Math.pow(1 - progress, 3);
      for (const p of this.players) {
        if (p.sentOff || !p.kickoffTo) { p.stop(dt); continue; }
        const to = p.kickoffTo;
        const from = p.kickoffFrom ?? to;
        const distance = Math.hypot(to.x - p.pos.x, to.z - p.pos.z);
        if (this.walkIn > 0 && distance > 0.05) {
          p.pos.x = lerp(from.x, to.x, eased);
          p.pos.z = lerp(from.z, to.z, eased);
          p.speed = 3.2;
          p.sprinting = false;
          p.animMode = 'RUN';
          p.facing = p === this.ball.holder
            ? (p.attackDir > 0 ? 0 : Math.PI)
            : Math.atan2(this.ball.pos.z - p.pos.z, this.ball.pos.x - p.pos.x);
        } else {
          p.pos.x = to.x;
          p.pos.z = to.z;
          p.speed = 0;
          p.sprinting = false;
          p.animMode = 'IDLE';
          p.facing = p === this.ball.holder
            ? (p.attackDir > 0 ? 0 : Math.PI)
            : Math.atan2(this.ball.pos.z - p.pos.z, this.ball.pos.x - p.pos.x);
        }
      }
      if (this.countdown <= 0) {
        this.walkIn = 0;
        this.phase = Phase.LIVE;
        this.setPiece = null;
        this.events.emit('FirstWhistle', {});
      }
      return;
    }
    if (this.phase === Phase.GOAL_CELEB) {
      this.celebTimer -= dt;
      for (const p of this.players) p.stop(dt);
      if (this.celebTimer <= 0) {
        this.flushPendingCard();
        this.considerAiSubs();
        this.resetKickoff(this.lastConcededTeam);
      }
      return;
    }
    if (this.phase === Phase.HALF_TIME) {
      this.halftimeTimer -= dt;
      for (const p of this.players) p.stop(dt);
      this.clockSec = Math.max(this.clockSec, this.halfDuration + this.addedTime[0]);
      if (this.halftimeTimer <= 0) this.startSecondHalf();
      return;
    }
    if (this.cardCutscene && this.time > this.cardCutscene.until) this.cardCutscene = null;

    if (this.advantage && this.time >= this.advantage.until) {
      this.resolveAdvantage();
      if (this.phase === Phase.ENDED) return;
      if (this.freezeUntil > this.time) return;
    }

    this.clockSec += dt;
    const currentAdded = this.currentAdded(this.half);
    const endAt = this.half === 1
      ? this.halfDuration + this.addedTime[0]
      : this.cfg.durationSec + this.addedTime[0] + this.addedTime[1];
    if (this.clockSec >= endAt) {
      if (this.half === 1) this.beginHalfTime();
      else {
        this.phase = Phase.ENDED;
        this.events.emit('FinalWhistle', { score: [...this.score], half: this.half, addedTime: [...this.addedTime] });
      }
      return;
    }
    if (this.time < this.freezeUntil) {
      for (const p of this.players) { p.intent = null; p.stop(dt); p.updateStamina(dt); }
      return;
    }
    for (const team of this.teams) team.subWindowOpen = false;
    this.updateAiTactics();
    if (this.ball.holder) this.stats.possession[this.ball.holder.team] += dt;
    if (this.setPiece && (this.setPiece === 'THROWIN' || this.setPiece === 'CORNER' || this.setPiece === 'PENALTY')) this.executeSetPiece();
    this.setPiece = null;
    this.resolvePendingDistributions();
    this.resolvePendingStrikes();
    for (const t of this.teams) t.updateProgress();
    for (const p of this.players) {
      p.sprinting = false;
      p.kickTimer = Math.max(0, p.kickTimer - dt);
      p.jumpTimer = Math.max(0, p.jumpTimer - dt);
      if (p.jumpTimer === 0) p.jumpHeight = 0;
      this.processBehaviours(p, dt);
      p.updateStamina(dt);
    }
    this.updateSpecialActions(dt);
    this.updateGoalkeeperStates();
    for (const p of this.players) p.updateStability(dt);
    this.updateDuelContext();
    this.separatePlayers(dt);
    for (const p of this.players) {
      if (p.sentOff) continue;
      p.pos.x = clamp(p.pos.x, -this.fieldHalfX + 0.4, this.fieldHalfX - 0.4);
      p.pos.z = clamp(p.pos.z, -this.fieldHalfZ + 0.4, this.fieldHalfZ - 0.4);
    }
    this.handleTouches(0);
    const substeps = Math.ceil(dt * 120);
    for (let i = 0; i < substeps && this.phase === Phase.LIVE && this.time >= this.freezeUntil; i++) {
      this.ball.step(dt / substeps);
      this.checkGoal();
      if (this.phase !== Phase.LIVE || this.time < this.freezeUntil) break;
      this.checkOut();
      if (this.time >= this.freezeUntil) this.handleTouches(0);
    }
    if (this.ball.holder) this.ball.holder.ballHoldTime += dt;
  }

  // PlayerBase.ProcessBehaviours — sticky active behaviour, first-true-wins, AILevel skip roll.
  processBehaviours(p, dt) {
    if (p.sentOff) { p.stop(dt); return; }
    if (p.stunned) { p.stop(dt); p.intent = null; p.currentAct = Acts.Stunned; p.animMode = 'BROKEN'; return; }
    if (p.diveTimer > 0 || this.time < p.feintUntil) { p.intent = null; return; }
    if (this.time < p.actionLockUntil) {
      // Humans may still cancel/replace the pending action during the wind-up;
      // they just cannot move. AI holds its committed action.
      if (p.isHuman) this.applyHumanControl(p, dt);
      else { p.stop(dt); p.intent = null; }
      return;
    }
    if (p.hasBall && this.ball.heldInHands) {
      const holdLimit = p.isHuman ? 5.8 : 2.2;
      if (p.ballHoldTime >= holdLimit) { this.gkDistribute(p); p.intent = null; return; }
      if (p.isHuman && p.ballHoldTime > 4.5 && !p.holdWarned) {
        p.holdWarned = true;
        this.events.emit('KeeperHoldWarning', { player: p });
      }
    }
    if (p.isHuman) { this.applyHumanControl(p, dt); return; }

    if (this.rng.range(0, 100) < SKIP_RATE_BY_AI_LEVEL[this.aiLevel]) return;

    const ctx = this.behaviourContext(p, dt);
    const run = (b, already) => { b.set(ctx); return b.behave(already); };

    const active = p.activeBehaviour;
    if (active && this.time <= p.nextBehaviourTime) {
      if (run(active, true)) { p.aiBehaviour = active.name; return; }
      p.activeBehaviour = null;
    }
    for (const b of p.behaviours) {
      if (run(b, b === p.activeBehaviour)) {
        p.activeBehaviour = b;
        p.aiBehaviour = b.name;
        p.nextBehaviourTime = this.time + BEHAVIOUR_STICKY;
        return;
      }
    }
    p.stop(dt);
  }

  behaviourContext(p, dt) {
    const team = this.teams[p.team];
    return {
      player: p, dt, time: this.time, ball: this.ball, match: this, team,
      teammates: team.players.filter((q) => q !== p),
      opponents: this.teams[1 - p.team].players,
      attackGoal: team.attackGoal, ownGoal: team.ownGoal,
      fieldHalfX: this.fieldHalfX, fieldHalfZ: this.fieldHalfZ,
      teamBallProgress: team.ballProgress, ballProgressGlobal: this.ball.pos.x / this.fieldLength + 0.5,
      intent: p.intent
    };
  }

  humanActionType(intent) {
    if (!intent) return null;
    if (intent.shoot) return 'shoot';
    if (intent.through) return 'through';
    if (intent.cross) return 'cross';
    if (intent.pass) return 'pass';
    if (intent.tackle || intent.slide || intent.skill) return 'skill';
    return null;
  }

  bufferHumanAction(p, intent) {
    const type = this.humanActionType(intent);
    if (!type) return null;
    const expiresAt = Math.max(this.time + INPUT_BUFFER_SECONDS, p.actionLockUntil + INPUT_BUFFER_SECONDS);
    p.bufferedAction = { type, intent: { ...intent }, at: this.time, expiresAt };
    return p.bufferedAction;
  }

  applyHumanControl(p, dt) {
    const it = p.intent;
    p.faceUp = p.hasBall && !!it?.faceUp;
    if (this.humanActionType(it)) this.bufferHumanAction(p, it);
    if (p.bufferedAction && this.time > p.bufferedAction.expiresAt) p.bufferedAction = null;

    const work = !this.humanActionType(it) && p.bufferedAction
      ? {
        ...p.bufferedAction.intent,
        moveX: it?.moveX ?? 0, moveZ: it?.moveZ ?? 0,
        worldX: it?.worldX, worldZ: it?.worldZ,
        speedScale: it?.speedScale, sprint: it?.sprint,
        closeControl: it?.closeControl || p.bufferedAction.intent.closeControl,
        faceUp: it?.faceUp || p.bufferedAction.intent.faceUp
      }
      : it;

    for (const b of p.behaviours) {
      if (!b.name.startsWith('Input')) continue;
      const context = this.behaviourContext(p, dt);
      context.intent = work;
      b.set(context);
      if (b.behave(false)) {
        p.bufferedAction = null;
        p.intent = null;
        if (this.time < p.actionLockUntil) p.stop(dt);
        return;
      }
    }
    p.intent = null;
    if (p.hasBall && this.ball.heldInHands) { p.stop(dt); p.animMode = 'GK_HOLD'; return; }
    if (this.time < p.actionLockUntil) { p.stop(dt); return; }
    if (!it || (Math.hypot(it.moveX ?? 0, it.moveZ ?? 0) < 0.05 && Math.hypot(it.worldX ?? 0, it.worldZ ?? 0) < 0.05)) { p.stop(dt); return; }
    // Screen-relative clients send a world vector; legacy attack-relative axes remain the fallback.
    const dir = p.attackDir;
    let dirX, dirZ;
    if (Number.isFinite(it.worldX) && Number.isFinite(it.worldZ)) {
      dirX = it.worldX; dirZ = it.worldZ;
    } else {
      dirX = it.moveZ * dir; dirZ = it.moveX * dir;
    }
    const type = it.sprint ? MovementType.BestHeCanDo : MovementType.Normal;
    const pressure = p.hasBall ? this.nearestOpponentDistance(p) : Infinity;
    const shielding = p.hasBall && (it.shield || (it.closeControl && pressure < 1.6));
    const faceUp = p.hasBall && !!it.faceUp;
    const mode = shielding ? MoveMode.Shield
      : (it.closeControl || faceUp) ? MoveMode.Close
        : it.sprint ? MoveMode.Sprint : MoveMode.Normal;
    const faceTowards = faceUp ? this.teams[p.team].attackGoal : null;
    p.move(dt, dirX, dirZ, type, faceTowards, it.speedScale ?? 1, mode);
  }

  playerMass(p) { return 0.55 + (p.skills.strength ?? 50) / 125; }

  playerStability(p) {
    return 0.55 + (p.skills.strength ?? 50) / 180 + (p.skills.agility ?? 50) / 300;
  }

  // A shield only counts when the carrier's body is actually between the
  // opponent and the ball; turning into the defender exposes the ball again.
  isShieldedFrom(carrier, opponent) {
    if (!carrier?.shieldActive || !opponent) return false;
    const toOpponent = V.normalizeXZ(V.sub(opponent.pos, carrier.pos));
    const toBall = V.normalizeXZ(V.sub(this.ball.pos, carrier.pos));
    return V.dotXZ(toOpponent, toBall) < 0.2;
  }

  updateDuelContext() {
    for (const p of this.players) {
      p.shieldActive = false;
      p.shieldTargetId = null;
      if (!p.hasBall && p.moveMode === MoveMode.Shield) p.moveMode = MoveMode.Normal;
      if (!p.hasBall || p.stunned || this.ball.heldInHands || p.moveMode !== MoveMode.Shield) continue;
      let opponent = null;
      let best = Infinity;
      for (const q of this.teams[1 - p.team].players) {
        if (q.sentOff || q.stunned) continue;
        const d = V.distXZ(p.pos, q.pos);
        if (d < best) { best = d; opponent = q; }
      }
      if (!opponent || best > 2.0) continue;
      const toOpponent = V.normalizeXZ(V.sub(opponent.pos, p.pos));
      const toBall = V.normalizeXZ(V.sub(this.ball.pos, p.pos));
      if (V.dotXZ(toOpponent, toBall) >= 0.2) continue;
      p.shieldActive = true;
      p.shieldTargetId = opponent.id;
      const forward = V.fromHeading(p.facing);
      p.shieldSide = Math.sign(forward.x * toOpponent.z - forward.z * toOpponent.x) || 0;
    }
  }

  drainBalance(p, impact) {
    const resistance = this.playerStability(p) + (p.shieldActive ? 0.4 : 0);
    p.balance = Math.max(0, p.balance - (impact * 0.05) / resistance);
    p.jostle = Math.min(1, p.jostle + impact * 0.12);
  }

  stumblePlayer(p, opponent, impact) {
    p.stumbleReadyAt = this.time + 2;
    p.balance = 0.16;
    p.stunnedUntil = Math.max(p.stunnedUntil, this.time + 0.55);
    p.pendingStrike = null;
    p.actionLockUntil = 0;
    const away = opponent
      ? V.normalizeXZ(V.sub(p.pos, opponent.pos))
      : V.fromHeading(p.facing);
    if (this.ball.holder === p) {
      this.ball.release();
      this.ball.vel = V.scale(away, 2.2 + impact);
      this.ball.vel.y = 0.4;
      this.ball.spin.y = this.rng.range(-2, 2);
      this.ball.lastKickBy = opponent ?? p;
      this.ball.lastKickTeam = opponent?.team ?? p.team;
      this.ball.lastKickAt = this.time;
      this.ball.lastKickKind = 'duel';
    }
    if (opponent) {
      this.stats.duelsWon[opponent.team]++;
      const stat = this.ensurePlayerStat(opponent);
      if (stat) stat.duelsWon = (stat.duelsWon ?? 0) + 1;
    }
    this.events.emit('PlayerStumbled', { player: p, by: opponent ?? null, impact });
  }

  separatePlayers(dt) {
    const ps = this.players;
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i], b = ps[j];
        if (a.sentOff || b.sentOff) continue;
        let dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
        let d = Math.hypot(dx, dz);
        if (d >= CONTACT_RADIUS) continue;
        if (d < 1e-3) { dx = this.rng.range(-1, 1); dz = this.rng.range(-1, 1); d = Math.hypot(dx, dz) || 1; }
        const nx = dx / d, nz = dz / d;
        const keeperA = a.isGoalKeeper && this.ball.holder === a && this.ball.heldInHands;
        const keeperB = b.isGoalKeeper && this.ball.holder === b && this.ball.heldInHands;
        const massA = this.playerMass(a) * (keeperA ? 4 : 1);
        const massB = this.playerMass(b) * (keeperB ? 4 : 1);
        const total = massA + massB;
        const shareA = massB / total, shareB = massA / total;

        if (d < MIN_SEP) {
          const push = Math.min(MIN_SEP - d, 0.12);
          a.pos.x -= nx * push * shareA; a.pos.z -= nz * push * shareA;
          b.pos.x += nx * push * shareB; b.pos.z += nz * push * shareB;
        }

        const closing = Math.max(0, -((b.vx - a.vx) * nx + (b.vz - a.vz) * nz));
        const impulse = Math.min(MAX_CONTACT_IMPULSE, closing * 0.55);
        if (impulse > 0.12) {
          const k = 0.5;
          a.vx -= nx * impulse * shareA * k;
          a.vz -= nz * impulse * shareA * k;
          b.vx += nx * impulse * shareB * k;
          b.vz += nz * impulse * shareB * k;
          a.speed = Math.hypot(a.vx, a.vz);
          b.speed = Math.hypot(b.vx, b.vz);
          if (!keeperA) this.drainBalance(a, impulse);
          if (!keeperB) this.drainBalance(b, impulse);
          if (!keeperA && a.balance <= 0.16 && this.time >= a.stumbleReadyAt) this.stumblePlayer(a, b, impulse);
          else if (!keeperB && b.balance <= 0.16 && this.time >= b.stumbleReadyAt) this.stumblePlayer(b, a, impulse);
        }

        if (a.team !== b.team && impulse > 0.5 &&
          this.time >= a.duelReadyAt && this.time >= b.duelReadyAt) {
          a.duelReadyAt = b.duelReadyAt = this.time + DUEL_COOLDOWN;
          this.stats.duels[a.team]++;
          this.stats.duels[b.team]++;
          const carrier = this.ball.holder === a ? a : this.ball.holder === b ? b : null;
          this.events.emit('PlayerDuel', {
            a, b, carrier,
            shielding: carrier ? carrier.shieldActive : false,
            impact: impulse
          });
        }
      }
    }
  }

  handleTouches(dt) {
    const ball = this.ball;
    if (ball.holder) {
      if (ball.holder.stunned) ball.release();
      return;
    }
    if (Math.abs(ball.pos.x) > this.fieldHalfX + BALL_RADIUS || Math.abs(ball.pos.z) > this.fieldHalfZ + BALL_RADIUS) return;
    const near = this.players
      .filter((p) => !p.sentOff && !p.stunned && this.time >= p.ballContactReadyAt && (p !== ball.ignoreHitter || this.time > ball.ignoreHitterUntil))
      .map((p) => ({ p, d: V.distXZ(p.pos, ball.pos) }))
      .sort((a, b) => a.d - b.d);

    if (ball.pos.y > 1.25 && ball.pos.y <= 2.7 && ball.vel.y < 2.2) {
      const keeper = near.find(({ p, d }) =>
        p.isGoalKeeper && d <= (p.diveTimer > 0 ? 1.35 : 1.3) && this.time >= p.ballContactReadyAt);
      if (keeper && this.canHandleBall(keeper.p) && this.gkContact(keeper.p)) return;
      const contenders = near
        .filter(({ p, d }) => d < 1.75 && !p.isGoalKeeper)
        .map(({ p, d }) => ({
          p,
          score: p.skills.jump * 0.45 + p.skills.strength * 0.25 + p.skills.reaction * 0.30 - d * 30 + this.rng.range(-4, 4)
        }))
        .sort((a, b) => b.score - a.score);
      if (contenders.length) {
        const winner = contenders[0].p;
        winner.jumpHeight = 0.28 + winner.skills.jump / 260;
        winner.jumpTimer = 0.38;
        this.performHeader(winner, false, contenders.length > 1);
      }
      return;
    }

    for (const { p, d } of near) {
      const r = (p.isGoalKeeper ? 1.3 : 0.82) + p.skills.ballControl / 420;
      if (d > r) continue;
      if (p.isInOffside) {
        p.isInOffside = false;
        this.offsides[p.team]++;
        this.events.emit('Offside', { player: p, team: p.team });
        this.freeKick(1 - p.team, V.copy(p.pos), 'OFFSIDE', true);
        return;
      }
      if (!p.isGoalKeeper && p.team !== ball.lastTouchTeam && this.insidePenaltyArea(p.team, p.pos) &&
        ball.speed > 12 && d < 0.9 && this.rng() < 0.02) {
        this.events.emit('PlayerHandball', { player: p, team: p.team });
        this.awardFoul(1 - p.team, V.copy(p.pos), p, false, false, false, p);
        return;
      }
      if (ball.pos.y > 2.55) continue;
      if (this.restrictedGoalBy && p.id !== this.restrictedGoalBy) this.restrictedGoalBy = null;
      if (p.isGoalKeeper && this.isBackpass(p) && this.canHandleBall(p, true) && d < 1.3 &&
        this.time >= this.backpassCallAt) {
        this.backpassCallAt = this.time + 3;
        this.events.emit('Backpass', { player: p });
      }
      if (p.isGoalKeeper && this.canHandleBall(p)) { if (this.gkContact(p)) return; continue; }
      if (ball.pos.y > 1.25) {
        if (!p.isHuman && ball.pos.y <= 2.2 && ball.vel.y < 1.5 && this.performHeader(p)) return;
        continue;
      }
      if (ball.speed < 4.2) {
        const closest = this.teams[1 - p.team].players.reduce((best, opp) =>
          !best || V.distXZ(p.pos, opp.pos) < V.distXZ(p.pos, best.pos) ? opp : best, null);
        const controlPressure = this.nearestOpponentDistance(p) < 1.6 ? 0.14 : 0;
        const controlQuality = clamp(0.62 + p.skills.ballControl / 300 - controlPressure, 0.35, 0.98);
        p.receptionQuality = controlQuality;
        ball.firstTouch(p, controlQuality, controlPressure, closest);
        this.onBallControlled(p);
        this.events.emit('PlayerControlBall', { player: p, quality: controlQuality });
        return;
      }
      const toBall = V.normalizeXZ(V.sub(ball.pos, p.pos));
      const facing = Math.max(0, V.dotXZ(V.fromHeading(p.facing), toBall));
      const pressure = this.nearestOpponentDistance(p) < 1.6 ? 0.14 : 0;
      const quality = Math.max(0.04, Math.min(0.96,
        0.35 + p.skills.ballControl / 125 + facing * 0.18 - ball.speed / 62 - pressure +
        (p.isHuman ? 0.12 : 0)));
      if (this.rng() < quality) {
        const nearestOpponent = this.teams[1 - p.team].players.reduce((best, opp) =>
          !best || V.distXZ(p.pos, opp.pos) < V.distXZ(p.pos, best.pos) ? opp : best, null);
        p.receptionQuality = quality;
        if (nearestOpponent && !p.isHuman && V.distXZ(p.pos, nearestOpponent.pos) < 3.2) {
          const away = V.normalizeXZ(V.sub(p.pos, nearestOpponent.pos));
          const forward = V.fromHeading(p.facing);
          p.facing = V.headingOf(V.normalizeXZ(V.addScaled(away, forward, 0.35)));
        }
        ball.firstTouch(p, quality, pressure, nearestOpponent);
        this.onBallControlled(p);
        this.events.emit('PlayerControlBall', { player: p, quality });
      } else {
        const away = V.normalizeXZ(V.sub(ball.pos, p.pos));
        const impact = V.dotXZ(ball.vel, away);
        if (impact < 0) ball.vel = V.addScaled(ball.vel, away, -1.25 * impact);
        ball.vel = V.scale(ball.vel, 0.7);
        ball.lastTouch = p; ball.lastTouchTeam = p.team;
        ball.lastKickBy = p; ball.lastKickAt = this.time; ball.lastKickKind = 'control';
        p.ballContactReadyAt = this.time + 0.25;
        this.events.emit('PlayerTouchTheBall', { player: p, speed: ball.speed, miskick: true });
      }
      return;
    }
  }

  performHeader(p, shoot = false, contested = false) {
    if (!this.canKickBall(p, 2.2) || this.ball.pos.y < 1.25) return false;
    if (p.jumpTimer <= 0) {
      p.jumpHeight = 0.24 + p.skills.jump / 280;
      p.jumpTimer = 0.34;
    }
    const goal = this.teams[p.team].attackGoal;
    const ownGoal = this.teams[p.team].ownGoal;
    let target;
    let intended = null;
    if (V.distXZ(p.pos, ownGoal) < this.fieldLength * 0.34) {
      // Defensive headers clear away from danger rather than passing across the box.
      const dir = this.dirFor(p.team);
      target = V.v3(
        clamp(p.pos.x + dir * 30, -this.fieldHalfX + 4, this.fieldHalfX - 4),
        0.8,
        clamp(p.pos.z * -0.5, -this.fieldHalfZ + 5, this.fieldHalfZ - 5)
      );
    } else if (shoot || (V.distXZ(p.pos, goal) < 17 && this.rng() < 0.55)) target = V.v3(goal.x, 0.8, 0);
    else {
      const teammate = this.bestPassTarget(p);
      if (!teammate) return false;
      target = this.leadPoint(teammate, 0.25);
      target.y = 0.8;
      intended = teammate;
    }
    this.ball.ballHit(p, V.withLength(V.sub(target, this.ball.pos), 13 + p.skills.strength / 30 + p.jumpHeight * 4));
    this.ball.lastKickKind = 'header';
    if (intended) {
      this.ball.intendedReceiverId = intended.id;
      this.ball.intendedReceiverUntil = this.time + 2.2;
    }
    p.animMode = 'HEADER';
    p.kickTimer = 0.34;
    this.events.emit('PlayerHeader', { player: p, contested });
    return true;
  }

  checkGoal() {
    if (this.phase !== Phase.LIVE || this.time < this.freezeUntil) return;
    const b = this.ball;
    let collision = null;
    for (const bar of this.goalFrame) {
      const hit = sweepSphereCapsule(b.prevPos, b.pos, bar.start, bar.end, BALL_RADIUS + POST_RADIUS);
      if (hit && (!collision || hit.t < collision.t)) collision = { ...hit, part: bar.part };
    }
    if (collision) {
      const { point, normal, part } = collision;
      if (b.holder) b.vel = V.scale(V.fromHeading(b.holder.facing), b.holder.speed);
      b.release();
      b.pos = V.addScaled(point, normal, 0.001);
      const impact = V.dot(b.vel, normal);
      if (impact < 0) b.vel = V.addScaled(b.vel, normal, -1.62 * impact);
      b.lastShot = null;
      this.events.emit('BallHitWoodwork', { part, ...point });
      return;
    }
    const dx = b.pos.x - b.prevPos.x;
    if (Math.abs(dx) < 1e-8) return;
    for (let net = 0; net < 2; net++) {
      const outward = net === 0 ? -1 : 1;
      const plane = this.goalNets[net].x + outward * BALL_RADIUS;
      const t = (plane - b.prevPos.x) / dx;
      if (t < 0 || t > 1 || dx * outward <= 0) continue;
      const y = b.prevPos.y + (b.pos.y - b.prevPos.y) * t;
      const z = b.prevPos.z + (b.pos.z - b.prevPos.z) * t;
      if (Math.abs(z) + BALL_RADIUS <= this.cfg.goalW / 2 && y + BALL_RADIUS <= this.cfg.goalH) {
        if (this.restrictedGoalBy && b.lastTouch?.id === this.restrictedGoalBy) {
          this.restrictedGoalBy = null;
          this.endlineRestart(net);
          return;
        }
        const scoringTeam = 1 - net;
        const scorer = b.lastTouch;
        const ownGoal = !!scorer && scorer.team !== scoringTeam;
        this.score[scoringTeam]++;
        this.passStreak = [0, 0];
        this.addStoppage(5);
        this.phase = Phase.GOAL_CELEB;
        this.celebTimer = 3;
        this.lastConcededTeam = net;
        let assistId = null;
        if (scorer && !ownGoal) { scorer.animMode = 'CELEBRATE'; scorer.kickKind = null; scorer.actionImmediate = false; scorer.actionSeq++; }
        if (!ownGoal) {
          this.stats.onTarget[scoringTeam]++;
          if (scorer) {
            const s = this.ensurePlayerStat(scorer);
            if (s) s.goals++;
            const assist = this.lastAssistCandidate;
            if (assist && assist.team === scoringTeam && assist.passerId !== scorer.id &&
              this.time - assist.at <= 8) {
              const a = this.playerStats.get(assist.passerId);
              if (a) { a.assists++; assistId = assist.passerId; }
            }
          }
        }
        this.lastAssistCandidate = null;
        b.lastShot = null;
        b.release();
        V.set(b.vel, 0, 0, 0);
        this.events.emit('Goal', {
          team: scoringTeam, scorer: scorer?.id ?? null, ownGoal, assist: assistId,
          score: [...this.score]
        });
      } else this.endlineRestart(net);
      return;
    }
  }

  checkOut() {
    const b = this.ball;
    if (this.phase !== Phase.LIVE || this.time < this.freezeUntil) return;
    b.lastShot = null;
    if (Math.abs(b.pos.z) > this.fieldHalfZ + BALL_RADIUS) {
      const team = 1 - (b.lastTouchTeam >= 0 ? b.lastTouchTeam : 0);
      const z = clamp(b.pos.z, -this.fieldHalfZ, this.fieldHalfZ);
      const x = clamp(b.pos.x, -this.fieldHalfX + 1, this.fieldHalfX - 1);
      this.restart(team, V.v3(x, BALL_RADIUS, z), 'THROWIN');
      return;
    }
    if (Math.abs(b.pos.x) > this.fieldHalfX + BALL_RADIUS) {
      const endNet = b.pos.x > 0 ? 1 : 0;
      this.endlineRestart(endNet);
    }
  }

  endlineRestart(net) {
    const defending = net;
    const corner = this.ball.lastTouchTeam === defending;
    const team = corner ? 1 - defending : defending;
    const gx = this.goalNets[net].x;
    const pos = corner
      ? V.v3(gx, BALL_RADIUS, Math.sign(this.ball.pos.z || 1) * this.fieldHalfZ)
      : V.v3(gx - Math.sign(gx) * 4, BALL_RADIUS, 0);
    this.restart(team, pos, corner ? 'CORNER' : 'GOALKICK');
  }

  // Role-based corner shape: runners, edge/rebound players, rest defence and
  // a counter outlet instead of interpolating the old 11-row utility table.
  positionCornerBox(team, attacking) {
    const squad = this.teams[team];
    const taker = this.ball.holder;
    const own = this.goalNets[team];
    const attackGoal = this.teams[team].attackGoal;
    const dir = this.dirFor(team);
    const side = Math.sign(this.ball.pos.z || 1);
    const goalW = this.cfg.goalW;
    const goalX = attackGoal.x;
    const nearZ = side * goalW * 0.34;
    const farZ = -nearZ;
    const boxX = goalX - dir * 5.2;
    const farX = goalX - dir * 8.2;
    const spotX = goalX - dir * 11;
    const edgeX = goalX - dir * 18;
    const shortX = goalX - dir * 4;
    const shortZ = side * (this.fieldHalfZ - 4.5);
    const placed = new Set();
    const place = (p, x, z) => {
      if (!p || p.sentOff || p.isGoalKeeper || p === taker) return;
      p.setInstantPosition(
        clamp(x, -this.fieldHalfX + 1, this.fieldHalfX - 1),
        clamp(z, -this.fieldHalfZ + 1, this.fieldHalfZ - 1),
        Math.atan2(this.ball.pos.z - z, this.ball.pos.x - x)
      );
      p.animMode = 'IDLE';
      p.activeBehaviour = null;
      p.intent = null;
      placed.add(p);
    };

    const gk = squad.players.find((p) => p.isGoalKeeper && !p.sentOff);
    if (gk) {
      gk.setInstantPosition(
        clamp(own.x + dir * 1.2, -this.fieldHalfX + 1, this.fieldHalfX - 1),
        0,
        dir > 0 ? 0 : Math.PI
      );
      placed.add(gk);
    }
    const outfield = squad.players.filter((p) => !p.isGoalKeeper && !p.sentOff && p !== taker);
    const group = (p) => roleMeta(p.role).group;
    const defenders = outfield.filter((p) => group(p) === 'DEF');
    const midfielders = outfield.filter((p) => group(p) === 'MID');
    const forwards = outfield.filter((p) => group(p) === 'FWD');
    const cbs = defenders.filter((p) => p.role === 'CB' || p.role === 'DEF');
    const fbs = defenders.filter((p) => p.role === 'FB' || p.role === 'WB');
    const dms = midfielders.filter((p) => p.role === 'DM');
    const cms = midfielders.filter((p) => p.role !== 'DM');
    const strikers = forwards.filter((p) => p.role === 'ST' || p.role === 'FWD');
    const wings = forwards.filter((p) => p.role === 'W');
    const runners = [...strikers, ...wings, ...forwards.filter((p) => !strikers.includes(p) && !wings.includes(p))];

    if (attacking) {
      const rest = [];
      if (cbs[0]) rest.push(cbs[0]);
      if (dms[0]) rest.push(dms[0]);
      else if (cbs[1]) rest.push(cbs[1]);
      else if (cms[0]) rest.push(cms[0]);
      rest.forEach((p, i) => place(p, own.x + dir * this.fieldLength * 0.38, (i === 0 ? 1 : -1) * 5.5));

      const availableRunners = runners.filter((p) => !placed.has(p));
      if (availableRunners[0]) place(availableRunners[0], boxX, nearZ);
      if (availableRunners[1]) place(availableRunners[1], farX, farZ);

      const edgeMids = [...cms, ...dms].filter((p) => !placed.has(p));
      if (edgeMids[0]) place(edgeMids[0], spotX, 0);
      if (edgeMids[1]) place(edgeMids[1], edgeX, -side * 8);

      const edgeFbs = fbs.filter((p) => !placed.has(p));
      if (edgeFbs[0]) place(edgeFbs[0], shortX, shortZ);
      if (edgeFbs[1]) place(edgeFbs[1], edgeX, side * 9);

      const leftovers = outfield.filter((p) => !placed.has(p));
      leftovers.forEach((p, i) => {
        place(p, edgeX + dir * (i % 2) * 3, (i % 2 === 0 ? 1 : -1) * (12 + i));
      });
    } else {
      const outlet = forwards[0] || wings[0] || midfielders[0];
      if (outlet) place(outlet, 0, side * 12);
      const markers = outfield.filter((p) => !placed.has(p));
      const spots = [
        [own.x + dir * 2.6, side * goalW * 0.23],
        [own.x + dir * 2.6, -side * goalW * 0.23],
        [own.x + dir * 5.0, side * goalW * 0.56],
        [own.x + dir * 5.0, -side * goalW * 0.56],
        [own.x + dir * 9, side * 3.2],
        [own.x + dir * 11, 0],
        [own.x + dir * 15, -side * 6.5]
      ];
      markers.forEach((p, i) => {
        const [x, z] = spots[Math.min(i, spots.length - 1)];
        place(p, x, z);
      });
    }
  }

  clearRestartFlags() {
    for (const team of this.teams) team.oneTwo = null;
    for (const p of this.players) {
      p.kickTimer = 0; p.diveTimer = 0; p.feintUntil = 0; p.isInOffside = false;
      p.isThrowHolder = false; p.isGoalKickHolder = false; p.isCornerHolder = false;
      p.pendingStrike = null; p.pendingDistribution = null; p.intent = null;
      p.kickKind = null; p.actionImmediate = false; p.actionLockUntil = 0;
      p.oneTwoUntil = -1; p.oneTwoPartner = null; p.jumpTimer = 0; p.jumpHeight = 0;
      p.calledForPassUntil = 0; p.callReadyAt = 0;
      p.decision = null; p._attackDecision = null; p._decisionTime = -1; p.lastShotXG = null;
    }
  }

  restart(team, pos, kind, takerOverride = null) {
    this.flushPendingCard();
    if (kind !== 'FREEKICK') this.freeKickInfo = null;
    const nearest = this.teams[team].players.slice().sort((a, b) => V.distXZ(a.pos, pos) - V.distXZ(b.pos, pos))[0];
    const bestCrosser = this.teams[team].fielders.slice().sort((a, b) => (b.skills.longBall + b.skills.passing) - (a.skills.longBall + a.skills.passing))[0];
    const taker = takerOverride ?? (kind === 'GOALKICK' ? this.teams[team].players.find(p => p.isGoalKeeper) ?? nearest
      : kind === 'CORNER' ? bestCrosser ?? nearest : nearest);
    this.clearRestartFlags();
    if (kind === 'CORNER') { this.stats.corners[team]++; this.addStoppage(1.5); }
    else if (kind === 'FREEKICK') this.addStoppage(1);
    else if (kind === 'THROWIN') { this.stats.throwIns[team]++; this.addStoppage(0.5); }
    else if (kind === 'GOALKICK') { this.stats.goalKicks[team]++; this.addStoppage(0.5); }
    else if (kind === 'PENALTY') this.addStoppage(3);
    this.ball.reset(pos);
    this.restrictedGoalBy = null;
    for (const p of this.players) {
      if (!p.isGoalKeeper) continue;
      p.gkState = 'SET';
      p.gkRecoverUntil = 0;
      p.diveTimer = 0;
      p.diveVelocity = V.v3();
      p.pendingDistribution = null;
    }
    this.setPiece = kind;
    this.setPieceTeam = team;
    this.freezeUntil = Math.max(this.freezeUntil, this.time + (kind === 'CORNER' ? 1.9 : kind === 'THROWIN' ? 1.35 : 1.2));

    if (kind === 'PENALTY') {
      const goal = this.teams[team].attackGoal;
      const dir = this.dirFor(team);
      const attacking = this.teams[team];
      const defending = this.teams[1 - team];
      const taker = attacking.fielders
        .filter((p) => !p.sentOff)
        .sort((a, b) => (b.skills.shooting + b.skills.shootPower) - (a.skills.shooting + a.skills.shootPower))[0];
      if (!taker) return;
      const keeper = defending.players.find((p) => p.isGoalKeeper && !p.sentOff);
      let index = 0;
      for (const p of this.players) {
        if (p.sentOff || p === taker || p === keeper) continue;
        const side = index % 2 === 0 ? 1 : -1;
        const offset = 4 + Math.floor(index / 2) * 3;
        p.setInstantPosition(
          goal.x - dir * 22,
          clamp(side * offset, -this.fieldHalfZ + 3, this.fieldHalfZ - 3),
          dir > 0 ? 0 : Math.PI
        );
        index++;
      }
      taker.setInstantPosition(pos.x - dir * 1.4, 0, dir > 0 ? 0 : Math.PI);
      if (keeper) keeper.setInstantPosition(goal.x - dir * 0.45, 0, dir > 0 ? Math.PI : 0);
      this.ball.reset(pos);
      this.ball.hold(taker);
      this.ball.pos = V.v3(pos.x, BALL_RADIUS, pos.z);
      this.penalty = {
        team, pos: V.copy(pos), taker, keeper, taken: false,
        waiting: this.hasHuman, awardedAt: this.time, waitUntil: this.time + 8
      };
      this.freezeUntil = Math.max(this.freezeUntil, this.time + 2.6);
      this.events.emit('PenaltyAwarded', {
        team, taker, keeper, position: V.copy(pos), waiting: this.hasHuman
      });
      return;
    }

    let setupPos = V.copy(pos);
    let takerFacing = this.dirFor(team) > 0 ? 0 : Math.PI;
    if (kind === 'THROWIN' && taker) {
      const side = Math.sign(pos.z || 1);
      setupPos = V.v3(clamp(pos.x, -this.fieldHalfX + 1, this.fieldHalfX - 1), 0, this.fieldHalfZ * side + 0.45);
      takerFacing = -side * Math.PI / 2;
    } else if (kind === 'CORNER' && taker) {
      const side = Math.sign(pos.z || 1);
      setupPos = V.v3(pos.x + Math.sign(pos.x) * 0.6, 0, pos.z + side * 0.45);
      takerFacing = Math.atan2(-setupPos.z, -Math.sign(pos.x) * 6);
    }
    if (taker) {
      taker.setInstantPosition(setupPos.x, setupPos.z, takerFacing);
      this.ball.hold(taker, kind === 'THROWIN');
      if (kind === 'THROWIN') {
        const f = V.fromHeading(takerFacing);
        this.ball.pos = V.v3(taker.pos.x + f.x * 0.14, 2.02, taker.pos.z + f.z * 0.14);
      }
      if (kind === 'CORNER') this.ball.pos = V.v3(pos.x, BALL_RADIUS, pos.z);
    }
    if (kind === 'CORNER') {
      this.positionCornerBox(team, true);
      this.positionCornerBox(1 - team, false);
      if (taker) {
        taker.setInstantPosition(setupPos.x, setupPos.z, takerFacing);
        this.ball.hold(taker);
        this.ball.pos = V.v3(pos.x, BALL_RADIUS, pos.z);
      }
      for (const opp of this.teams[1 - team].players) {
        if (opp.sentOff || V.distXZ(opp.pos, pos) >= 9.15) continue;
        const away = V.normalizeXZ(V.sub(opp.pos, pos));
        const safe = V.lenXZ(away) > 1e-4 ? away : V.v3(-Math.sign(pos.x) || 1, 0, 0);
        opp.setInstantPosition(
          clamp(pos.x + safe.x * 9.4, -this.fieldHalfX + 1, this.fieldHalfX - 1),
          clamp(pos.z + safe.z * 9.4, -this.fieldHalfZ + 1, this.fieldHalfZ - 1)
        );
        opp.intent = null;
      }
    } else if (kind === 'THROWIN' && taker) {
      const receiver = this.teams[team].fielders
        .filter(p => p !== taker)
        .sort((a, b) => V.distXZ(a.pos, taker.pos) - V.distXZ(b.pos, taker.pos))[0];
      if (receiver) receiver.setInstantPosition(taker.pos.x + this.dirFor(team) * 5, clamp(taker.pos.z + 3, -this.fieldHalfZ + 1, this.fieldHalfZ - 1));
      for (const opp of this.teams[1 - team].players) {
        const distance = V.distXZ(opp.pos, taker.pos);
        if (distance < 2) {
          const away = V.normalizeXZ(V.sub(opp.pos, taker.pos));
          const safe = V.lenXZ(away) > 1e-4 ? away : V.fromHeading(taker.facing + Math.PI);
          opp.setInstantPosition(taker.pos.x + safe.x * 2.1, clamp(taker.pos.z + safe.z * 2.1, -this.fieldHalfZ + 0.5, this.fieldHalfZ - 0.5));
        }
      }
    }
    if (kind === 'GOALKICK') {
      const goal = this.goalNets[team];
      const dir = this.dirFor(team);
      const depth = this.cfg.markings?.boxDepth ?? 16.5;
      for (const opp of this.teams[1 - team].players) {
        if (opp.sentOff || !this.insidePenaltyArea(team, opp.pos)) continue;
        opp.setInstantPosition(
          goal.x + dir * (depth + 1.5),
          clamp(opp.pos.z, -this.fieldHalfZ + 2, this.fieldHalfZ - 2)
        );
        opp.intent = null;
      }
    }
    if (taker) {
      taker.isThrowHolder = kind === 'THROWIN';
      taker.isGoalKickHolder = kind === 'GOALKICK';
      taker.isCornerHolder = kind === 'CORNER';
    }
    if (kind !== 'FREEKICK') this.events.emit(kind === 'CORNER' ? 'Corner' : kind === 'THROWIN' ? 'ThrowIn' : 'GoalKick', { team });
    this.considerAiSubs();
  }

  executeSetPiece() {
    const kind = this.setPiece;
    const team = this.setPieceTeam;
    if (kind === 'PENALTY') {
      const penalty = this.penalty;
      if (!penalty || penalty.taken || !penalty.taker) return;
      if (penalty.waiting) {
        if (this.time < penalty.waitUntil) {
          this.freezeUntil = Math.max(this.freezeUntil, this.time + 0.5);
          return;
        }
        penalty.waiting = false;
      }
      const taker = penalty.taker;
      penalty.taken = true;
      if (penalty.keeper) {
        this.startGKDive(penalty.keeper, { worldX: 0, worldZ: this.rng.sign() || 1 });
      }
      this.ball.pos = V.v3(penalty.pos.x, BALL_RADIUS, penalty.pos.z);
      this.ball.hold(taker);
      taker.animMode = 'KICK';
      taker.kickTimer = 0.34;
      taker.kickKind = 'penalty';
      taker.actionImmediate = true;
      taker.actionSeq++;
      this.addStoppage(2);
      this.shootAtGoal(taker, 0.82, false);
      this.events.emit('PenaltyTaken', { team, taker, position: V.copy(penalty.pos) });
      return;
    }
    const taker = this.ball.holder;
    if (!taker || taker.team !== team) return;
    if (kind === 'THROWIN') {
      const candidates = this.teams[team].players
        .filter(p => p !== taker && !p.isGoalKeeper)
        .map(p => ({ p, d: V.distXZ(p.pos, taker.pos) }))
        .filter(({ p, d }) => d > 4 && d < 26)
        .sort((a, b) => {
          const fa = (a.p.pos.x - taker.pos.x) * this.dirFor(team);
          const fb = (b.p.pos.x - taker.pos.x) * this.dirFor(team);
          return (this.nearestOpponentDistance(b.p) + fb * 0.3 - b.d * 0.15) - (this.nearestOpponentDistance(a.p) + fa * 0.3 - a.d * 0.15);
        });
      const receiver = candidates[0]?.p;
      const target = receiver ? this.leadPoint(receiver, 0.3) : V.v3(
        taker.pos.x + this.dirFor(team) * 8,
        BALL_RADIUS,
        taker.pos.z * 0.4
      );
      target.x = clamp(target.x, -this.fieldHalfX + 2, this.fieldHalfX - 2);
      target.z = clamp(target.z, -this.fieldHalfZ + 2, this.fieldHalfZ - 2);
      this.restrictedGoalBy = taker.id;
      taker.animMode = 'THROW';
      taker.kickTimer = 0.5;
      taker.actionImmediate = true;
      taker.actionSeq++;
      this.ball.throwTo(target, taker, 0.92);
      this.events.emit('PlayerThrowIn', { player: taker, target: V.copy(target) });
    } else if (kind === 'CORNER') {
      const goal = this.teams[team].attackGoal;
      const gx = goal.x;
      const dir = taker.attackDir;
      const side = Math.sign(this.ball.pos.z || 1);
      const nearZ = side * this.cfg.goalW * 0.34;
      const farZ = -nearZ;
      const shortOption = this.teams[team].players
        .filter(p => p !== taker && !p.isGoalKeeper && V.distXZ(p.pos, taker.pos) < 12)
        .sort((a, b) => V.distXZ(a.pos, taker.pos) - V.distXZ(b.pos, taker.pos))[0];
      const short = !!shortOption && this.rng() < 0.18;
      let target;
      let runner = null;
      let post = 'short';
      if (short) {
        target = this.leadPoint(shortOption, 0.25);
        target.x = clamp(target.x, -this.fieldHalfX + 2, this.fieldHalfX - 2);
        target.z = clamp(target.z, -this.fieldHalfZ + 2, this.fieldHalfZ - 2);
        runner = shortOption;
        this.ball.pass(target, taker, 1.05, true);
        this.ball.intendedReceiverId = runner.id;
        this.ball.intendedReceiverUntil = this.time + 2.2;
      } else {
        post = this.rng() < 0.55 ? 'near' : 'far';
        const targetZ = post === 'near' ? nearZ : farZ;
        const targetX = gx - dir * (post === 'near' ? 5.2 : 8.2);
        const forwards = this.teams[team].players
          .filter((p) => p !== taker && !p.isGoalKeeper && roleMeta(p.role).group === 'FWD');
        runner = forwards.slice().sort((a, b) => Math.abs(a.pos.z - targetZ) - Math.abs(b.pos.z - targetZ))[0] ?? null;
        target = V.v3(targetX, 1.15, targetZ);
        this.ball.cross(target, taker, true);
        // Deliberate inswing/outswing: the ball curves toward or away from the goal mouth.
        this.ball.spin.y = (post === 'near' ? 1 : -1) * side * 6.5;
        if (runner) {
          this.ball.intendedReceiverId = runner.id;
          this.ball.intendedReceiverUntil = this.time + 2.4;
        }
      }
      this.events.emit('CornerTaken', {
        team: taker.team, target: V.copy(target), nearPost: post === 'near',
        post, short, runnerId: runner?.id ?? null
      });
    }
    this.ball.holder?.isThrowHolder && (this.ball.holder.isThrowHolder = false);
  }

  freeKick(team, pos, reason, indirect = false) {
    const goal = this.teams[team].attackGoal;
    const distance = V.distXZ(pos, goal);
    const canShoot = !indirect && distance <= 34;
    const fielders = this.teams[team].fielders.filter((p) => !p.sentOff);
    const specialist = fielders.slice().sort((a, b) =>
      (b.skills.shooting * 0.55 + b.skills.passing * 0.25 + b.skills.longBall * 0.20) -
      (a.skills.shooting * 0.55 + a.skills.passing * 0.25 + a.skills.longBall * 0.20))[0];
    const nearest = fielders.slice().sort((a, b) => V.distXZ(a.pos, pos) - V.distXZ(b.pos, pos))[0];
    const taker = canShoot ? specialist ?? nearest : nearest;
    this.restart(team, V.v3(pos.x, BALL_RADIUS, pos.z), 'FREEKICK', taker);
    this.indirectFreeKick = indirect;
    this.restrictedGoalBy = indirect ? (this.ball.holder?.id ?? null) : null;
    const defending = this.teams[1 - team];
    const towardGoal = V.normalizeXZ(V.sub(defending.ownGoal, pos));
    const side = V.v3(-towardGoal.z, 0, towardGoal.x);
    const wall = defending.fielders
      .slice()
      .sort((a, b) => V.distXZ(a.pos, pos) - V.distXZ(b.pos, pos))
      .slice(0, 3);
    wall.forEach((player, index) => {
      const offset = (index - 1) * 0.85;
      const spot = V.addScaled(V.addScaled(pos, towardGoal, 9.15), side, offset);
      player.setInstantPosition(
        clamp(spot.x, -this.fieldHalfX + 1, this.fieldHalfX - 1),
        clamp(spot.z, -this.fieldHalfZ + 1, this.fieldHalfZ - 1)
      );
      player.intent = null;
      player.activeBehaviour = null;
    });
    for (const opp of defending.players) {
      if (opp.isGoalKeeper || opp.sentOff || V.distXZ(opp.pos, pos) >= 9.15) continue;
      const away = V.normalizeXZ(V.sub(opp.pos, pos));
      const safe = V.lenXZ(away) > 1e-4 ? away : towardGoal;
      opp.setInstantPosition(
        clamp(pos.x + safe.x * 9.4, -this.fieldHalfX + 1, this.fieldHalfX - 1),
        clamp(pos.z + safe.z * 9.4, -this.fieldHalfZ + 1, this.fieldHalfZ - 1)
      );
      opp.intent = null;
      opp.activeBehaviour = null;
    }
    for (const attacker of this.teams[team].fielders) {
      if (V.distXZ(attacker.pos, pos) < 2.2 && attacker !== this.ball.holder) {
        const away = V.normalizeXZ(V.sub(attacker.pos, pos));
        attacker.setInstantPosition(pos.x + away.x * 2.2, clamp(pos.z + away.z * 2.2, -this.fieldHalfZ + 1, this.fieldHalfZ - 1));
      }
    }
    this.freeKickInfo = {
      team, pos: V.copy(pos), indirect, taker: this.ball.holder ?? taker,
      distance, canShoot, wall
    };
    this.freezeUntil = Math.max(this.freezeUntil, this.time + (canShoot ? 3.2 : 2.3));
    this.events.emit('Whistle', { reason });
    this.events.emit('FreeKickAwarded', {
      team, indirect, reason, taker: this.ball.holder ?? taker,
      position: V.copy(pos), distance, canShoot
    });
  }

  takeFreeKick({ zoneZ = 0, zoneY = 0.35, power = 0.65, curve = 0 } = {}) {
    const info = this.freeKickInfo;
    if (!info || this.setPiece !== 'FREEKICK') return { ok: false, reason: 'NO_FREE_KICK' };
    const taker = this.ball.holder ?? info.taker;
    if (!taker) return { ok: false, reason: 'NO_TAKER' };
    const goal = this.teams[info.team].attackGoal;
    const aim = V.v3(
      goal.x,
      clamp(0.5 + clamp(zoneY, 0, 1) * 1.4, 0.35, 2.3),
      clamp(zoneZ, -1, 1) * (this.cfg.goalW / 2 - 0.45)
    );
    const p = clamp(power, 0.2, 1);
    taker.animMode = 'KICK';
    taker.kickTimer = 0.34;
    taker.kickKind = 'shot';
    taker.actionImmediate = true;
    taker.actionSeq++;
    this.shootAtGoal(taker, p, false, aim, clamp(curve, -1, 1) * 16, 10 + p * 8 + clamp(zoneY, 0, 1) * 4);
    this.freezeUntil = this.time;
    this.setPiece = null;
    this.indirectFreeKick = false;
    this.restrictedGoalBy = null;
    this.freeKickInfo = null;
    this.events.emit('FreeKickTaken', { team: info.team, taker, aim: V.copy(aim) });
    return { ok: true };
  }

  // ------------------------------------------------------------- actions
  shootRoll(angleDeg, distance, toleranceMod) {
    const prob = S.AI_ShootToleranceDistanceCurveMod.evaluate(distance) * S.AI_ShootTolerance * toleranceMod /
      S.AI_ShootToleranceDividerAngleCurveMod.evaluate(angleDeg * S.AI_DistanceToAngleCurveMod.evaluate(distance));
    return this.rng.range(0, 100) < prob;
  }

  shootAtGoal(p, power, chip, aimOverride = null, curve = 0, angleOverride = null) {
    if (p.animMode !== 'KICK' || !p.kickKind) {
      p.animMode = 'KICK';
      p.kickTimer = 0.34;
      p.kickKind = 'shot';
      p.actionImmediate = true;
      p.actionSeq++;
    }
    if (p.isGoalKeeper) p.kickKind = null;
    const goal = this.teams[p.team].attackGoal;
    const d = V.distXZ(p.pos, goal);
    if (aimOverride) p.lastShotXG = null;
    const geometry = shotGeometry(p.pos, goal, this.cfg.goalW);
    const xg = p.lastShotXG ?? shotXG({
      ...geometry,
      blockers: this.shootBlockers(p, goal),
      oneOnOne: this.isOneOnOneWithGK(p),
      orientation: 1,
      reception: p.receptionQuality
    });
    const aimZ = this.rng.range(-this.cfg.goalW * 0.34, this.cfg.goalW * 0.34);
    const aim = aimOverride ? V.copy(aimOverride) : V.v3(goal.x, chip ? 1.4 : 0.7, aimZ);
    const corrected = this.ball.applyError(aim, p.skills.shooting);
    const angle = angleOverride ?? (chip ? 30 : 11 + power * 7);
    let v = this.ball.calcBallisticVelocityVector(this.ball.pos, corrected, angle);
    const distanceFactor = clamp(1 - d / 120, 0.85, 1);
    const skillFactor = 0.95 + p.skills.shootPower / 2000;
    const speed = clamp(16 + power * 14, 16, 30) * distanceFactor * skillFactor * (chip ? 0.55 : 1);
    v = V.withLength(v, speed);
    this.stats.shots[p.team]++;
    this.stats.xg[p.team] += xg;
    const shooterStat = this.ensurePlayerStat(p);
    if (shooterStat) shooterStat.shots++;
    this.ball.lastShot = { team: p.team, playerId: p.id, at: this.time };
    this.ball.lastShotXG = xg;
    p.lastShotXG = xg;
    this.ball.shoot(v, p);
    if (curve) this.ball.spin.y = curve;
    p.lastShotXG = null;
  }

  attackDecision(p) {
    if (!p || !p.hasBall || p.isGoalKeeper) return null;
    if (p._decisionTime === this.time) return p._attackDecision ?? null;
    const decision = evaluateAttack(this, p);
    p._decisionTime = this.time;
    p._attackDecision = decision;
    p.decision = decision ? {
      action: decision.action,
      kind: decision.kind,
      xg: +decision.xg.toFixed(3),
      targetId: decision.target?.id ?? null,
      value: +decision.bestValue.toFixed(3),
      retention: decision.retention == null ? null : +decision.retention.toFixed(3)
    } : null;
    return decision;
  }

  callForPass(p) {
    if (!p || !p.isHuman || this.time < p.callReadyAt) return false;
    p.callReadyAt = this.time + 1.5;
    p.calledForPassUntil = this.time + 2.2;
    this.events.emit('CallForPass', { player: p });
    return true;
  }

  bestPassTarget(p, intent = null) {
    let best = null, bestScore = -Infinity, aligned = null, alignedScore = -Infinity;
    const teamDir = p.attackDir;
    const worldAim = intent && Number.isFinite(intent.aimX) && Number.isFinite(intent.aimZ);
    const hasAim = worldAim
      ? Math.hypot(intent.aimX, intent.aimZ) > 0.15
      : intent && Math.hypot(intent.moveX ?? 0, intent.moveZ ?? 0) > 0.15;
    const aim = !hasAim ? null
      : worldAim ? Math.atan2(intent.aimZ, intent.aimX)
        : Math.atan2(intent.moveX * teamDir, intent.moveZ * teamDir);
    for (const q of this.teams[p.team].players) {
      if (q === p) continue;
      const d = V.distXZ(p.pos, q.pos);
      const maxDistance = q.isHuman ? 40 : 35;
      if (d < S.MinimumPassDistance || d > maxDistance || q.isInOffside) continue;
      const fwd = (q.pos.x - p.pos.x) * teamDir;
      let nearestOpp = Infinity;
      for (const o of this.teams[1 - p.team].players) nearestOpp = Math.min(nearestOpp, V.distXZ(q.pos, o.pos));
      const lane = this.laneBlockers(p.pos, this.leadPoint(q, 0.25), p.team);
      let score = fwd * 0.65 + nearestOpp * 1.7 - d * 0.18 - lane.blockers * 5.0 +
        Math.min(3, lane.tightest) * 1.0 + (q.isGoalKeeper ? S.BestOptionToTargetGKAddition : 0);
      if (q.isHuman && !q.isGoalKeeper) {
        const called = this.time < q.calledForPassUntil;
        if (called) {
          const viable = d <= 28 && lane.tightest > 1 && nearestOpp > 1;
          score += viable ? 100 : 1;
        } else {
          const open = nearestOpp > 2.4 && lane.tightest > 1.4;
          if (open) score += 4;
        }
      }
      let alignment = 1;
      if (hasAim) {
        const angle = V.headingOf(V.sub(q.pos, p.pos));
        alignment = Math.cos(angle - aim);
        score += alignment * 10;
      }
      if (score > bestScore) { bestScore = score; best = q; }
      if ((!hasAim || alignment > 0.25) && score > alignedScore) { alignedScore = score; aligned = q; }
    }
    return aligned ?? best;
  }

  leadPoint(player, seconds) {
    return V.addScaled(player.pos, V.fromHeading(player.facing), player.speed * seconds);
  }

  canKickBall(p, maxHeight = 1.8) {
    const b = this.ball;
    if (!b.isLoose || b.pos.y > maxHeight || p.stunned || this.time < p.ballContactReadyAt) return false;
    if (b.ignoreHitter === p && this.time < b.ignoreHitterUntil) return false;
    return V.distXZ(p.pos, b.pos) < 1.05;
  }

  bestRunTarget(p) {
    let best = null, bd = -Infinity;
    for (const q of this.teams[p.team].fielders) {
      if (q === p || q.isInOffside) continue;
      const space = this.spaceAhead(q);
      const fwd = (q.pos.x - p.pos.x) * p.attackDir;
      const score = space + fwd * 0.5;
      if (score > bd) { bd = score; best = q; }
    }
    return best;
  }

  bestCrossTarget(p) {
    return this.bestCrossOption(p)?.point ?? null;
  }

  // Cross utility: near/far-post occupancy, receiver openness and lane clearance.
  bestCrossOption(p) {
    const goal = this.teams[p.team].attackGoal;
    const dir = p.attackDir;
    const side = Math.sign(p.pos.z || 1);
    const postZ = {
      near: side * this.cfg.goalW * 0.42,
      far: -side * this.cfg.goalW * 0.42
    };
    let best = null, bestScore = -Infinity;
    for (const q of this.teams[p.team].fielders) {
      if (q === p) continue;
      const dGoal = V.distXZ(q.pos, goal);
      if (dGoal > 24) continue;
      const post = Math.abs(q.pos.z - postZ.near) <= Math.abs(q.pos.z - postZ.far) ? 'near' : 'far';
      const lane = this.laneBlockers(p.pos, q.pos, p.team);
      let open = 6;
      for (const o of this.teams[1 - p.team].fielders) open = Math.min(open, V.distXZ(q.pos, o.pos));
      const advance = (q.pos.x - p.pos.x) * dir;
      const score = open * 1.5 - Math.abs(q.pos.z - postZ[post]) * 0.45 - dGoal * 0.12 -
        lane.blockers * 2.5 + Math.min(3, lane.tightest) * 0.5 + clamp(advance, -6, 6) * 0.15;
      if (score > bestScore) {
        bestScore = score;
        const targetZ = clamp(q.pos.z, -this.cfg.goalW * 0.44, this.cfg.goalW * 0.44);
        best = { player: q, post, point: V.v3(q.pos.x + dir * 0.8, 1.0, targetZ), lane };
      }
    }
    return best;
  }

  bestCutbackTarget(p) {
    const goal = this.teams[p.team].attackGoal;
    const dir = p.attackDir;
    const spotX = goal.x - dir * (this.cfg.markings?.penaltySpot ?? 11);
    const boxHalf = (this.cfg.markings?.boxWidth ?? 40.32) / 2;
    let best = null, bestScore = -Infinity;
    for (const q of this.teams[p.team].fielders) {
      if (q === p) continue;
      if (Math.abs(q.pos.x - spotX) > 9 || Math.abs(q.pos.z) > boxHalf) continue;
      const lane = this.laneBlockers(p.pos, q.pos, p.team);
      let open = 6;
      for (const o of this.teams[1 - p.team].fielders) open = Math.min(open, V.distXZ(q.pos, o.pos));
      const central = 1 - Math.abs(q.pos.z) / boxHalf;
      const score = open * 1.8 + central * 4 - lane.blockers * 3 + Math.min(3, lane.tightest) * 0.5 -
        Math.abs(q.pos.x - spotX) * 0.2;
      if (score > bestScore) { bestScore = score; best = q; }
    }
    return best ? { player: best, point: V.v3(spotX, BALL_RADIUS, best.pos.z) } : null;
  }

  tackleFoulRisk(p, carrier, slide) {
    const alignment = V.dotXZ(V.fromHeading(carrier.facing), V.normalizeXZ(V.sub(p.pos, carrier.pos)));
    return clamp01((slide ? 0.22 : 0.03) + (alignment < -0.4 ? 0.33 : 0) +
      (p.speed > carrier.speed + 1.2 ? 0.08 : 0) + (this.isShieldedFrom(carrier, p) ? 0.08 : 0));
  }

  tackleSuccessChance(p, carrier, slide = false) {
    const carrierForward = V.fromHeading(carrier.facing);
    const toTackler = V.normalizeXZ(V.sub(p.pos, carrier.pos));
    const alignment = V.dotXZ(carrierForward, toTackler);
    const behind = alignment < -0.4;
    const frontOn = alignment > 0.5;
    const anglePenalty = frontOn ? 0.10 : behind ? 0.04 : 0.02;
    const shielded = this.isShieldedFrom(carrier, p);
    return clamp01(0.4 + (p.skills.tackling - carrier.skills.ballKeeping) / 130 +
      (p.skills.strength - carrier.skills.strength) / 220 - (slide ? 0.08 : 0) -
      anglePenalty - (shielded ? 0.28 : 0) + (1 - clamp01(carrier.balance ?? 1)) * 0.2 -
      S.Tackling_Difficulty * 0.04);
  }

  nearestOpponentDistance(p) {
    let d = Infinity;
    for (const o of this.teams[1 - p.team].players) d = Math.min(d, V.distXZ(p.pos, o.pos));
    return d;
  }

  laneBlockers(from, to, teamId) {
    let blockers = 0, tightest = Infinity;
    for (const opponent of this.teams[1 - teamId].players) {
      const clearance = segDist2D(from.x, from.z, to.x, to.z, opponent.pos.x, opponent.pos.z);
      if (clearance < 1.4) blockers++;
      tightest = Math.min(tightest, clearance);
    }
    return { blockers, tightest };
  }

  shootBlockers(p, goal) {
    let count = 0;
    for (const opponent of this.teams[1 - p.team].players) {
      if (opponent.isGoalKeeper) continue;
      const clearance = segDist2D(p.pos.x, p.pos.z, goal.x, goal.z, opponent.pos.x, opponent.pos.z);
      const closer = Math.abs(opponent.pos.x - goal.x) < Math.abs(p.pos.x - goal.x);
      if (clearance < 1.3 && closer) count++;
    }
    return count;
  }

  spaceAhead(p) {
    const fwd = V.fromHeading(p.facing);
    let d = 12;
    for (const o of this.teams[1 - p.team].players) {
      const rel = V.sub(o.pos, p.pos);
      const along = V.dotXZ(rel, fwd);
      if (along > 0 && along < d && Math.abs(rel.x * -fwd.z + rel.z * fwd.x) < 2.5) d = along;
    }
    return d;
  }

  isOneOnOneWithGK(p) {
    const gk = this.teams[1 - p.team].players.find((q) => q.isGoalKeeper);
    if (!gk) return false;
    const dGoal = V.distXZ(p.pos, this.teams[p.team].attackGoal);
    return dGoal < 22 && this.nearestOpponentDistance(p) > 5.5;
  }

  chaserFor(teamId) { return this.teams[teamId].chaser; }

  insidePenaltyArea(teamId, pos) {
    const goal = this.goalNets[teamId];
    const dir = this.dirFor(teamId);
    const depth = this.cfg.markings?.boxDepth ?? 16.5;
    const halfWidth = (this.cfg.markings?.boxWidth ?? 40.32) / 2;
    const along = (pos.x - goal.x) * dir;
    return along >= -0.5 && along <= depth && Math.abs(pos.z) <= halfWidth;
  }

  foulSeverity(tackler, carrier, slide, behind) {
    const goal = this.teams[carrier.team].attackGoal;
    const toGoal = V.sub(V.v3(goal.x, 0, goal.z), carrier.pos);
    const distance = V.lenXZ(toGoal);
    const cover = this.teams[tackler.team].players
      .filter((q) => !q.isGoalKeeper && !q.sentOff &&
        Math.abs(q.pos.x - goal.x) < Math.abs(carrier.pos.x - goal.x) &&
        segDist2D(carrier.pos.x, carrier.pos.z, goal.x, goal.z, q.pos.x, q.pos.z) < 5);
    const facingGoal = V.dotXZ(toGoal, V.fromHeading(carrier.facing)) > 0;
    const dogso = distance < 30 && cover.length <= 1 && facingGoal;
    if (dogso && (slide || behind)) return { red: true, yellow: false, reason: 'DOGSO' };
    const serious = slide && behind && tackler.speed > carrier.speed + 2.5;
    if (serious) return { red: true, yellow: false, reason: 'SERIOUS FOUL PLAY' };
    const reckless = slide || behind || tackler.speed > carrier.speed + 1.5;
    return { red: false, yellow: reckless, reason: reckless ? 'RECKLESS CHALLENGE' : '' };
  }

  applyCard(player, cardType, reason = '') {
    if (!player || player.sentOff) return;
    const red = cardType === 'red' || (cardType === 'yellow' && player.yellowCards >= 1);
    if (cardType === 'yellow') player.yellowCards++;
    const stat = this.ensurePlayerStat(player);
    if (red) {
      player.redCard = true;
      player.sentOff = true;
      player.kickTimer = 0;
      player.activeBehaviour = null;
      player.pendingDistribution = null;
      player.intent = null;
      if (this.ball.holder === player) this.ball.release();
      player.setInstantPosition(0, this.fieldHalfZ + 1.4, 0);
      if (cardType === 'yellow') {
        this.cards[player.team].yellow++;
        if (stat) stat.yellow++;
      }
      this.cards[player.team].red++;
      if (stat) stat.red++;
      this.events.emit('PlayerSentOff', { player, reason });
      if (player.isGoalKeeper) this.promoteEmergencyKeeper(player);
    } else {
      this.cards[player.team].yellow++;
      if (stat) stat.yellow++;
    }
    this.addStoppage(2);
    this.freezeUntil = Math.max(this.freezeUntil, this.time + 1.5);
    this.cardCutscene = { playerId: player.id, card: red ? 'red' : 'yellow', reason, until: this.time + 1.8 };
    this.events.emit('Card', {
      player,
      card: red ? 'red' : 'yellow',
      reason,
      yellowCards: player.yellowCards,
      redCard: player.redCard
    });
  }

  promoteEmergencyKeeper(sentOffKeeper) {
    const replacement = this.teams[sentOffKeeper.team].players
      .filter((p) => !p.sentOff && p !== sentOffKeeper && !p.isGoalKeeper)
      .sort((a, b) => b.skills.ballControl - a.skills.ballControl)[0];
    if (!replacement) return;
    const keeperSlot = { role: 'GK', duty: 'Hold', h: 0.5, v: 0.06 };
    sentOffKeeper.slotIndex = null;
    replacement.slotIndex = 0;
    replacement.role = 'GK';
    replacement.duty = 'Hold';
    replacement.anchorOut = makeAnchor(keeperSlot);
    replacement.anchorIn = makePhaseAnchor(keeperSlot);
    replacement.anchor = replacement.anchorOut;
    replacement.behaviours = keeperBehaviours();
    replacement.setInstantPosition(this.goalNets[replacement.team].x + this.dirFor(replacement.team) * 1.2, 0,
      this.dirFor(replacement.team) > 0 ? Math.PI : 0);
    this.events.emit('EmergencyKeeper', { player: replacement, team: replacement.team });
  }

  startAdvantage(offendedTeam, pos, tackler, card, reason) {
    this.advantage = {
      team: offendedTeam,
      pos: V.copy(pos),
      tackler,
      card,
      reason,
      until: this.time + 1.6
    };
    this.events.emit('RefereeDecision', { type: 'ADVANTAGE', team: offendedTeam, player: tackler, reason });
  }

  commitFoul(offendedTeam, pos, tackler, card) {
    this.advantage = null;
    this.fouls[tackler.team]++;
    const stat = this.ensurePlayerStat(tackler);
    if (stat) stat.fouls++;
    if (card?.red || card?.yellow) this.applyCard(tackler, card.red ? 'red' : 'yellow', card.reason);
    if (this.insidePenaltyArea(tackler.team, pos)) this.awardPenalty(offendedTeam, pos);
    else this.freeKick(offendedTeam, pos, card?.reason || 'FOUL');
  }

  awardFoul(offendedTeam, pos, tackler, slide, behind, allowAdvantage = true, carrier = this.ball.holder ?? tackler) {
    const card = this.foulSeverity(tackler, carrier, slide, behind);
    const inBox = this.insidePenaltyArea(tackler.team, pos);
    const holder = this.ball.holder;
    const canAdvantage = allowAdvantage && !inBox && holder && holder.team === offendedTeam && !holder.sentOff && !holder.stunned;
    if (canAdvantage && this.rng() < 0.6) {
      this.startAdvantage(offendedTeam, pos, tackler, card, card.reason || 'FOUL');
      return true;
    }
    this.commitFoul(offendedTeam, pos, tackler, card);
    return false;
  }

  resolveAdvantage() {
    const advantage = this.advantage;
    if (!advantage || this.time < advantage.until) return;
    const holder = this.ball.holder;
    const retained = holder && holder.team === advantage.team && !holder.sentOff && this.phase === Phase.LIVE;
    if (retained) {
      if (advantage.card?.red || advantage.card?.yellow) {
        this.pendingCard = {
          player: advantage.tackler,
          card: advantage.card.red ? 'red' : 'yellow',
          reason: advantage.card.reason
        };
      }
      this.advantage = null;
      this.events.emit('AdvantagePlayed', { team: advantage.team });
      return;
    }
    this.advantage = null;
    this.commitFoul(advantage.team, advantage.pos, advantage.tackler, advantage.card);
  }

  flushPendingCard() {
    if (!this.pendingCard) return;
    const pending = this.pendingCard;
    this.pendingCard = null;
    this.applyCard(pending.player, pending.card, pending.reason);
  }

  awardPenalty(team, pos) {
    const goal = this.teams[team].attackGoal;
    const dir = this.dirFor(team);
    const spot = V.v3(goal.x - dir * (this.cfg.markings?.penaltySpot ?? 11), BALL_RADIUS, 0);
    this.restart(team, spot, 'PENALTY');
  }

  takePenalty({ zoneZ = 0, zoneY = 0.35, power = 0.8 } = {}) {
    const penalty = this.penalty;
    if (!penalty || penalty.taken || !penalty.taker) return { ok: false, reason: 'NO_PENALTY' };
    const taker = penalty.taker;
    const goal = this.teams[penalty.team].attackGoal;
    const aim = V.v3(
      goal.x,
      clamp(0.45 + clamp(zoneY, 0, 1) * 1.25, 0.35, 2.2),
      clamp(zoneZ, -1, 1) * (this.cfg.goalW / 2 - 0.45)
    );
    const p = clamp(power, 0.25, 1);
    if (penalty.keeper) {
      const picked = Math.sign(zoneZ) || (this.rng() < 0.5 ? 1 : -1);
      const guess = this.rng() < 0.35 ? picked : -picked;
      this.startGKDive(penalty.keeper, { worldX: 0, worldZ: guess });
    }
    penalty.waiting = false;
    penalty.taken = true;
    taker.animMode = 'KICK';
    taker.kickTimer = 0.34;
    taker.kickKind = 'penalty';
    taker.actionImmediate = true;
    taker.actionSeq++;
    this.ball.pos = V.v3(penalty.pos.x, BALL_RADIUS, penalty.pos.z);
    this.ball.hold(taker);
    this.addStoppage(2);
    this.shootAtGoal(taker, p, false, aim, 0, 9 + p * 5);
    this.setPiece = null;
    this.freezeUntil = this.time;
    this.events.emit('PenaltyTaken', { team: penalty.team, taker, aim: V.copy(aim), human: true });
    return { ok: true };
  }

  takePenaltyDefense(diveSide = 0) {
    const penalty = this.penalty;
    if (!penalty || penalty.taken || !penalty.taker) return { ok: false, reason: 'NO_PENALTY' };
    const side = Math.sign(diveSide);
    if (penalty.keeper && side !== 0) {
      this.startGKDive(penalty.keeper, { worldX: 0, worldZ: side });
    }
    const goal = this.teams[penalty.team].attackGoal;
    const zoneZ = this.rng.range(-0.72, 0.72);
    const zoneY = this.rng.range(0.15, 0.55);
    const aim = V.v3(goal.x, 0.45 + zoneY * 1.2, zoneZ * (this.cfg.goalW / 2 - 0.45));
    const taker = penalty.taker;
    penalty.waiting = false;
    penalty.taken = true;
    taker.animMode = 'KICK';
    taker.kickTimer = 0.34;
    taker.kickKind = 'penalty';
    taker.actionImmediate = true;
    taker.actionSeq++;
    this.ball.pos = V.v3(penalty.pos.x, BALL_RADIUS, penalty.pos.z);
    this.ball.hold(taker);
    this.addStoppage(2);
    this.shootAtGoal(taker, 0.8, false, aim, 0, 13);
    this.setPiece = null;
    this.freezeUntil = this.time;
    this.events.emit('PenaltyTaken', { team: penalty.team, taker, aim: V.copy(aim), humanDefense: true, diveSide: side });
    return { ok: true };
  }

  cancelPenalty() {
    const penalty = this.penalty;
    if (!penalty || penalty.taken) return;
    penalty.waiting = false;
    this.freezeUntil = this.time;
    this.events.emit('PenaltyCancelled', { team: penalty.team });
  }

  attemptTackle(p, slide) {
    const carrier = this.ball.holder;
    p.tackleReadyAt = this.time + (slide ? 1.4 : 0.9);
    p.kickTimer = 0.3;
    p.animMode = slide ? 'SLIDE' : 'TACKLE';
    p.kickKind = null;
    p.actionSeq++;
    p.actionImmediate = false;
    if (!carrier || carrier.team === p.team || this.ball.heldInHands) { p.currentAct = Acts.TacklingFailed; return; }
    const d = V.distXZ(p.pos, carrier.pos);
    if (d > (slide ? 2.3 : 1.6)) { p.currentAct = Acts.TacklingFailed; return; }
    const carrierForward = V.fromHeading(carrier.facing);
    const toTackler = V.normalizeXZ(V.sub(p.pos, carrier.pos));
    const behind = V.dotXZ(carrierForward, toTackler) < -0.4;
    if (this.time < carrier.feintImmuneUntil) {
      p.stunnedUntil = this.time + 0.35;
      p.currentAct = Acts.TacklingFailed;
      this.events.emit('PlayerFeint', { player: carrier, evaded: p });
      return;
    }
    const chance = this.tackleSuccessChance(p, carrier, slide);
    const foulRisk = this.tackleFoulRisk(p, carrier, slide);
    const isFoul = this.rng() < foulRisk;
    this.events.emit('PlayerSlideTackle', { player: p });
    if (this.rng() < chance) {
      carrier.pendingStrike = null;
      carrier.oneTwoUntil = -1;
      this.ball.release();
      this.ball.vel = V.scale(V.normalize(V.sub(this.ball.pos, carrier.pos)), 3.5);
      this.ball.lastKickBy = p;
      this.ball.lastKickAt = this.time;
      this.ball.lastKickKind = 'tackle';
      carrier.stunnedUntil = this.time + 1.2;
      carrier.currentAct = Acts.TacklingFailed;
      this.passStreak[carrier.team] = 0;
      this.stats.tackles[p.team]++;
      const stat = this.ensurePlayerStat(p);
      if (stat) stat.tackles++;
      this.events.emit('PlayerTackled', { player: carrier, by: p });
      if (isFoul) this.awardFoul(carrier.team, V.copy(carrier.pos), p, slide, behind, false, carrier);
    } else {
      p.stunnedUntil = this.time + (slide ? 1.0 : 0.45);
      if (isFoul) this.awardFoul(carrier.team, V.copy(carrier.pos), p, slide, behind, true, carrier);
    }
  }

  scheduleStrike(p, payload, delay = null) {
    if (p.stunned || !p.hasBall || this.ball.heldInHands) return false;
    if (p.pendingStrike) {
      const priority = ACTION_PRIORITY[payload.type] ?? 0;
      const current = ACTION_PRIORITY[p.pendingStrike.type] ?? 0;
      const canCancel = priority > current && p.pendingStrike.contactAt - this.time > STRIKE_CANCEL_WINDOW;
      if (!canCancel) return false;
    }
    const contactDelay = delay ?? (payload.type === 'shoot' ? 0.37 : 0.35);
    p.pendingStrike = { ...payload, contactAt: this.time + contactDelay };
    p.kickKind = payload.type === 'shoot' ? 'shot' : 'pass';
    p.kickTimer = contactDelay + 0.14;
    p.animMode = 'KICK';
    p.actionSeq++;
    p.actionImmediate = false;
    p.actionLockUntil = this.time + contactDelay + 0.22;
    return true;
  }

  resolvePendingStrikes() {
    for (const p of this.players) {
      const strike = p.pendingStrike;
      if (!strike) continue;
      if (p.stunned || this.ball.holder !== p || this.ball.heldInHands) { p.pendingStrike = null; continue; }
      if (this.time < strike.contactAt) continue;
      p.pendingStrike = null;
      if (strike.type === 'pass') {
        this.ball.pass(strike.point, p, strike.speed);
        if (strike.receiverId) {
          this.ball.intendedReceiverId = strike.receiverId;
          this.ball.intendedReceiverUntil = this.time + 2.2;
        }
      } else if (strike.type === 'through') {
        if (strike.lob) this.ball.cross(strike.point, p);
        else this.ball.pass(strike.point, p, strike.speed);
        if (strike.receiverId) {
          this.ball.intendedReceiverId = strike.receiverId;
          this.ball.intendedReceiverUntil = this.time + 2.4;
        }
      } else if (strike.type === 'cross') this.ball.cross(strike.point, p);
      else if (strike.type === 'shoot') this.shootAtGoal(p, strike.power, strike.chip);
    }
  }

  performSkill(p, intent = {}) {
    if (!p.hasBall || this.ball.heldInHands) return false;
    return intent.closeControl ? this.performBallRoll(p, intent) : this.performFeint(p, intent);
  }

  skillSide(p, intent) {
    const forward = V.fromHeading(p.facing);
    const right = V.v3(-forward.z, 0, forward.x);
    const dir = p.attackDir;
    const dx = Number.isFinite(intent?.worldX) ? intent.worldX : (intent?.moveX ?? 0) * dir;
    const dz = Number.isFinite(intent?.worldZ) ? intent.worldZ : (intent?.moveZ ?? 0) * dir;
    return Math.sign(V.dotXZ(V.v3(dx, 0, dz), right)) || 0;
  }

  performFeint(p, intent = {}) {
    if (this.time < p.feintReadyAt || !p.hasBall) return false;
    p.pendingStrike = null;
    const dir = p.attackDir;
    let dx, dz;
    if (Number.isFinite(intent.worldX) && Number.isFinite(intent.worldZ)) {
      dx = intent.worldX; dz = intent.worldZ;
    } else {
      dx = (intent.moveZ ?? 0) * dir; dz = (intent.moveX ?? 0) * dir;
    }
    if (Math.hypot(dx, dz) < 0.1) { dx = -Math.sin(p.facing); dz = Math.cos(p.facing); }
    const v = V.normalizeXZ(V.v3(dx, 0, dz));
    const burst = 5.2 + p.skills.dribbleSpeed / 35;
    p.feintVelocity = V.scale(v, burst);
    p.feintUntil = this.time + 0.26;
    p.feintImmuneUntil = this.time + 0.58;
    p.feintReadyAt = this.time + 1.05;
    p.animMode = 'FEINT';
    p.kickTimer = 0.26;
    p.skillKind = 'feint';
    p.diveSide = this.skillSide(p, intent) || (p.lastSkillSide ? -p.lastSkillSide : 1);
    p.lastSkillSide = p.diveSide;
    this.events.emit('PlayerFeint', { player: p });
    return true;
  }

  performBallRoll(p, intent = {}) {
    if (this.time < p.feintReadyAt || !p.hasBall || this.ball.heldInHands) return false;
    p.pendingStrike = null;
    p.moveMode = MoveMode.Close;
    p.faceUp = false;
    const forward = V.fromHeading(p.facing);
    const right = V.v3(-forward.z, 0, forward.x);
    let side = this.skillSide(p, intent);
    if (!side) side = p.lastSkillSide ? -p.lastSkillSide : 1;
    p.lastSkillSide = side;
    const dir = V.scale(right, side);
    p.feintVelocity = V.addScaled(V.scale(dir, 4.6 + p.skills.dribbleSpeed / 38), forward, 1.0);
    p.feintUntil = this.time + 0.24;
    p.feintImmuneUntil = this.time + 0.55;
    p.feintReadyAt = this.time + 1.05;
    p.animMode = 'FEINT';
    p.kickTimer = 0.24;
    p.skillKind = 'roll';
    p.diveSide = side;
    this.ball.nudge(p, dir.x, dir.z, 3.4);
    this.events.emit('PlayerBallRoll', { player: p, side });
    return true;
  }

  startGKDive(p, intent = null) {
    if (!p.isGoalKeeper || this.time < p.diveReadyAt || p.hasBall) return false;
    let dir;
    if (intent && Number.isFinite(intent.worldX) && Number.isFinite(intent.worldZ) &&
      Math.hypot(intent.worldX, intent.worldZ) > 0.1) {
      dir = V.normalizeXZ(V.v3(intent.worldX, 0, intent.worldZ));
    } else if (intent && Math.hypot(intent.moveX ?? 0, intent.moveZ ?? 0) > 0.1) {
      const side = p.attackDir;
      dir = V.normalizeXZ(V.v3((intent.moveZ ?? 0) * side, 0, (intent.moveX ?? 0) * side));
    } else dir = V.normalizeXZ(V.sub(this.ball.pos, p.pos));
    if (V.lenXZ(dir) < 0.1) dir = V.fromHeading(p.facing);
    p.diveVelocity = V.scale(dir, 6.8 + p.skills.agility / 60);
    p.diveSide = dir.z >= 0 ? 1 : -1;
    p.diveTimer = 0.46;
    p.diveReadyAt = this.time + 1.1;
    p.animMode = 'DIVE';
    p.gkState = 'DIVE';
    p.kickTimer = 0.46;
    p.kickKind = null;
    p.actionSeq++;
    p.actionImmediate = false;
    return true;
  }

  canHandleBall(p, ignoreBackpass = false) {
    const ownGoal = this.goalNets[p.team];
    return p.isGoalKeeper && Math.abs(this.ball.pos.x - ownGoal.x) <= 16.5 &&
      Math.abs(this.ball.pos.z) <= Math.min(20.15, this.fieldHalfZ) && Math.abs(this.ball.pos.x) <= this.fieldHalfX &&
      (ignoreBackpass || !this.isBackpass(p));
  }

  updateGoalkeeperStates() {
    for (const p of this.players) {
      if (!p.isGoalKeeper) continue;
      p.gkState = p.pendingDistribution ? 'DISTRIBUTE'
        : this.ball.holder === p && this.ball.heldInHands ? 'HOLD'
          : p.diveTimer > 0 ? 'DIVE'
            : this.time < p.gkRecoverUntil ? 'RECOVER' : 'SET';
    }
  }

  keeperCatchChance(p, incomingSpeed, height = BALL_RADIUS, lateral = 0) {
    const control = p.skills.ballControl ?? 50;
    let chance = 1.02 - incomingSpeed * 0.02 + control / 320;
    chance -= Math.max(0, height - 1.4) * 0.14;
    chance -= Math.abs(lateral) * 0.045;
    return clamp(chance, 0.08, 0.94);
  }

  gkContact(p) {
    const b = this.ball;
    if (!this.canHandleBall(p) || p.stunned || this.time < p.ballContactReadyAt || !b.isLoose) return false;
    if (p === b.ignoreHitter && this.time < b.ignoreHitterUntil) return false;
    const highBall = b.pos.y > 2.0;
    const reach = (p.diveTimer > 0 ? 1.35 : 1.05) + (highBall ? 0.25 : 0);
    if (V.distXZ(p.pos, b.pos) > reach || b.pos.y > (p.diveTimer > 0 ? 2.75 : highBall ? 2.7 : 2.0)) return false;
    if (highBall && p.diveTimer <= 0) { p.jumpHeight = 0.42; p.jumpTimer = 0.4; }
    const incomingSpeed = b.speed;
    const catchChance = this.keeperCatchChance(p, incomingSpeed, b.pos.y, Math.abs(b.pos.z - p.pos.z));
    p.ballContactReadyAt = this.time + 0.3;
    const shot = b.lastShot && this.time - b.lastShot.at < 6 && b.lastShot.team !== p.team ? b.lastShot : null;
    if ((incomingSpeed < 15 && !highBall) || this.rng() < catchChance) {
      b.hold(p, true);
      this.onBallControlled(p);
      p.diveTimer = 0;
      p.diveVelocity = V.v3();
      p.kickTimer = 0;
      p.speed = 0;
      p.animMode = 'GK_HOLD';
      p.gkState = 'HOLD';
      if (shot) {
        this.stats.saves[p.team]++;
        this.stats.onTarget[shot.team]++;
        const s = this.ensurePlayerStat(p);
        if (s) s.saves++;
        b.lastShot = null;
      }
      this.events.emit('KeeperSavesTheBall', { player: p, speed: incomingSpeed, outcome: 'catch' });
    } else {
      const away = V.normalizeXZ(V.sub(b.pos, p.pos));
      const impact = V.dotXZ(b.vel, away);
      if (impact < 0) b.vel = V.addScaled(b.vel, away, -1.6 * impact);
      b.vel = V.scale(b.vel, 0.75);
      b.vel.y = Math.max(2.5, Math.abs(b.vel.y) * 0.4);
      b.lastTouch = p; b.lastTouchTeam = p.team;
      p.gkRecoverUntil = this.time + 0.45;
      p.gkState = 'RECOVER';
      if (shot) {
        this.stats.saves[p.team]++;
        this.stats.onTarget[shot.team]++;
        const s = this.ensurePlayerStat(p);
        if (s) s.saves++;
        b.lastShot = null;
      }
      this.events.emit('KeeperParry', { player: p, speed: incomingSpeed });
      this.events.emit('KeeperSavesTheBall', { player: p, speed: incomingSpeed, outcome: 'parry' });
    }
    return true;
  }

  updateSpecialActions(dt) {
    for (const p of this.players) {
      if (p.skillKind && this.time >= p.feintUntil) p.skillKind = null;
      if (this.time < p.feintUntil) {
        p.pos = V.addScaled(p.pos, p.feintVelocity, dt);
        p.speed = V.lenXZ(p.feintVelocity);
      }
      if (p.diveTimer > 0) {
        if (this.ball.holder === p) { p.diveTimer = 0; p.animMode = 'GK_READY'; }
        else {
          p.pos = V.addScaled(p.pos, p.diveVelocity, dt);
          p.diveTimer = Math.max(0, p.diveTimer - dt);
          if (p.diveTimer === 0 && this.ball.holder !== p) {
            p.kickTimer = 0;
            p.animMode = 'GK_READY';
            if (p.isGoalKeeper) p.gkRecoverUntil = this.time + 0.35;
          }
        }
      }
    }
  }

  gkChooseDistribution(p) {
    const direction = this.dirFor(p.team);
    const maxDistance = Math.min(28, this.fieldLength * 0.45);
    let receiver = null, bestScore = -Infinity;
    for (const teammate of this.teams[p.team].fielders) {
      const distance = V.distXZ(p.pos, teammate.pos);
      const advance = (teammate.pos.x - p.pos.x) * direction;
      if (teammate.stunned || distance < 5 || distance > maxDistance || advance < 2) continue;
      let blocked = 0;
      for (const opponent of this.teams[1 - p.team].players) {
        if (segDist2D(p.pos.x, p.pos.z, teammate.pos.x, teammate.pos.z, opponent.pos.x, opponent.pos.z) < 1.5) blocked++;
      }
      const score = Math.min(10, this.nearestOpponentDistance(teammate)) * 2 - distance * 0.25 + advance * 0.15 - blocked * 6;
      if (score > bestScore) { bestScore = score; receiver = teammate; }
    }
    const target = receiver ? this.leadPoint(receiver, 0.3) : V.v3(
      p.pos.x + direction * Math.min(22, this.fieldLength * 0.35),
      BALL_RADIUS,
      p.pos.z * 0.5
    );
    target.x = clamp(target.x, -this.fieldHalfX + 8, this.fieldHalfX - 8);
    target.z = clamp(target.z, -this.fieldHalfZ * 0.42, this.fieldHalfZ * 0.42);
    target.y = BALL_RADIUS;
    const distance = V.distXZ(p.pos, target);
    const flightTime = clamp(1.55 + distance / 28, 1.55, 2.35);
    const kind = p.isGoalKickHolder
      ? 'punt'
      : receiver && distance < 15 ? 'throw'
        : receiver && distance < 24 ? 'roll' : 'punt';
    return { receiver, target, distance, flightTime, kind };
  }

  // Legacy immediate release (tests and emergency fallbacks). Normal play uses
  // gkDistribute so the ball leaves on the distribution contact frame.
  gkClear(p) {
    const info = this.gkChooseDistribution(p);
    p.pendingDistribution = null;
    p.passingTarget = info.receiver;
    if (info.kind === 'throw' || info.kind === 'roll') {
      this.ball.throwTo(info.target, p, info.kind === 'roll' ? 0.8 : 1, false);
    } else {
      this.ball.cross(info.target, p, p.isGoalKickHolder, info.flightTime);
    }
    this.ball.intendedReceiverId = info.receiver?.id ?? null;
    this.ball.intendedReceiverUntil = this.time + info.flightTime + 0.5;
    this.events.emit('GKDegage', { player: p, receiverId: info.receiver?.id ?? null, target: V.copy(this.ball.crossTarget ?? info.target), kind: info.kind });
  }

  gkDistribute(p) {
    const canDistribute = this.ball.heldInHands || p?.isGoalKickHolder;
    if (!p || !p.isGoalKeeper || !p.hasBall || !canDistribute || p.pendingDistribution) return false;
    const info = this.gkChooseDistribution(p);
    p.pendingDistribution = {
      ...info, contactAt: this.time + 0.42,
      givenAt: this.time
    };
    p.passingTarget = info.receiver;
    p.animMode = p.isGoalKickHolder ? 'GK_READY' : 'GK_HOLD';
    p.sprinting = false;
    this.events.emit('GkDistributionStarted', {
      player: p, receiverId: info.receiver?.id ?? null, target: V.copy(info.target), kind: info.kind
    });
    return true;
  }

  resolvePendingDistributions() {
    for (const p of this.players) {
      const distribution = p.pendingDistribution;
      if (!distribution) continue;
      if (!p.hasBall || (!this.ball.heldInHands && !p.isGoalKickHolder) || p.stunned) {
        p.pendingDistribution = null;
        continue;
      }
      if (this.time < distribution.contactAt) continue;
      p.pendingDistribution = null;
      p.gkRecoverUntil = this.time + 0.3;
      if (distribution.kind === 'throw' || distribution.kind === 'roll') {
        this.ball.throwTo(distribution.target, p, distribution.kind === 'roll' ? 0.8 : 1, false);
      } else {
        this.ball.cross(distribution.target, p, p.isGoalKickHolder, distribution.flightTime);
      }
      this.ball.intendedReceiverId = distribution.receiver?.id ?? null;
      this.ball.intendedReceiverUntil = this.time + distribution.flightTime + 0.5;
      this.events.emit('GKDegage', {
        player: p, receiverId: distribution.receiver?.id ?? null,
        target: V.copy(this.ball.crossTarget ?? distribution.target), kind: distribution.kind,
        heldFor: +(this.time - distribution.givenAt).toFixed(3)
      });
    }
  }

  assignOffsides(hitter, ignore) {
    for (const p of this.players) p.isInOffside = false;
    if (!this.cfg.offside || ignore || !hitter) return;
    const line = this.teams[hitter.team].offsideLine;
    const attackDir = this.dirFor(hitter.team);
    for (const p of this.teams[hitter.team].players) {
      if (p === hitter || p.sentOff) continue;
      const inOpponentHalf = p.pos.x * attackDir > 0.05;
      const aheadOfLine = (p.pos.x - line) * attackDir > 0.05;
      const aheadOfBall = (p.pos.x - this.ball.pos.x) * attackDir > 0.05;
      p.isInOffside = inOpponentHalf && aheadOfLine && aheadOfBall;
    }
  }

  delayBehaviourSelectionByReaction(p) {
    p.nextBehaviourTime = this.time + 0.06 + (1 - p.skills.reaction / 100) * 0.22;
  }

  // ------------------------------------------------------------- snapshot
  statsSnapshot() {
    const total = this.stats.possession[0] + this.stats.possession[1];
    const possession = total > 0.01
      ? [Math.round((this.stats.possession[0] / total) * 100), 0]
      : [50, 50];
    possession[1] = 100 - possession[0];
    return {
      possession,
      possessionSeconds: this.stats.possession.map((v) => Math.round(v)),
      shots: [...this.stats.shots],
      onTarget: [...this.stats.onTarget],
      xg: this.stats.xg.map((v) => Math.round(v * 100) / 100),
      passes: [...this.stats.passes],
      passesCompleted: [...this.stats.passesCompleted],
      crosses: [...this.stats.crosses],
      corners: [...this.stats.corners],
      saves: [...this.stats.saves],
      tackles: [...this.stats.tackles],
      duels: [...this.stats.duels],
      duelsWon: [...this.stats.duelsWon],
      throwIns: [...this.stats.throwIns],
      goalKicks: [...this.stats.goalKicks],
      fouls: [...this.fouls],
      offsides: [...this.offsides],
      cards: this.cards.map((c) => ({ ...c }))
    };
  }

  playerStatsSnapshot() {
    return [...this.playerStats.values()].map((s) => ({ ...s, rating: ratingFor(s) }));
  }

  getSnapshot() {
    return {
      phase: this.phase, status: this.status, clockSec: this.clockSec, countdown: this.countdown,
      displayClockSec: this.displayClockSec, displayAdded: this.displayAddedMinutes,
      matchMinutes: this.matchMinutes, clockScale: this.clockScale,
      half: this.half, halfDuration: this.halfDuration, addedTime: [...this.addedTime], sideSwapped: this.sideSwapped,
      score: [...this.score], setPiece: this.setPiece, aiLevel: this.aiLevel, isDeadBall: this.isDeadBall(),
      cfg: { id: this.cfg.id, mode: this.cfg.id, teamSize: this.cfg.teamSize, defaultFormation: this.cfg.defaultFormation, matchMinutes: this.matchMinutes, pitchLength: this.fieldLength, pitchWidth: this.fieldWidth, goalW: this.cfg.goalW, goalH: this.cfg.goalH, offside: this.cfg.offside },
      goalX: this.goalNets.map((g) => g.x),
      ball: {
        x: this.ball.pos.x, y: this.ball.pos.y, z: this.ball.pos.z,
        vx: this.ball.vel.x, vy: this.ball.vel.y, vz: this.ball.vel.z,
        spinX: this.ball.spin.x, spinY: this.ball.spin.y, spinZ: this.ball.spin.z,
        holderId: this.ball.holder?.id ?? null, dribblePulse: this.ball.dribblePulse
      },
      offsideLines: [this.teams[0].offsideLine, this.teams[1].offsideLine],
      passStreak: [...this.passStreak],
      stats: this.statsSnapshot(),
      playerStats: this.playerStatsSnapshot(),
      teams: this.teams.map((t) => ({
        id: t.id, name: t.id === 0 ? 'HOME' : 'AWAY',
        formationId: t.formationId, formationName: t.formation?.name ?? '',
        formationStyle: t.formation?.style ?? 'balanced',
        tactic: t.tactic,
        pendingFormation: this.pendingFormations[t.id]?.formationId ?? null,
        tacticPreset: {
          width: t.preset.width, depth: t.preset.depth, press: t.preset.press,
          lineHeight: t.preset.lineHeight, mentality: t.preset.DefenceAttackSlider
        }
      })),
      bench: this.teams.map((t) => t.bench.map((p) => ({
        id: p.id, team: p.team, role: p.role, naturalRole: p.naturalRole, name: p.name,
        band: p.anchor?.band ?? null, duty: p.duty,
        stamina: Math.round(p.stamina), isGoalKeeper: p.isGoalKeeper
      }))),
      substitutions: this.teams.map((t) => ({
        used: t.subsUsed, windows: t.subWindowsUsed, windowOpen: t.subWindowOpen, remaining: 5 - t.subsUsed
      })),
      fouls: [...this.fouls],
      cards: this.cards.map((c) => ({ ...c })),
      penalty: this.penalty ? {
        team: this.penalty.team, takerId: this.penalty.taker?.id ?? null,
        keeperId: this.penalty.keeper?.id ?? null, taken: this.penalty.taken,
        waiting: this.penalty.waiting
      } : null,
      freeKick: this.freeKickInfo ? {
        team: this.freeKickInfo.team, indirect: this.freeKickInfo.indirect,
        takerId: this.freeKickInfo.taker?.id ?? null, distance: this.freeKickInfo.distance,
        canShoot: this.freeKickInfo.canShoot
      } : null,
      advantage: this.advantage ? { team: this.advantage.team, until: this.advantage.until } : null,
      cardCutscene: this.cardCutscene ? {
        playerId: this.cardCutscene.playerId, card: this.cardCutscene.card,
        reason: this.cardCutscene.reason, until: this.cardCutscene.until
      } : null,
      players: this.players.map((p) => {
        const carrying = this.ball.holder === p;
        const carryMode = !carrying ? null
          : p.shieldActive ? 'SHIELD'
            : p.faceUp ? 'FACE-UP'
              : p.moveMode === MoveMode.Close ? 'CLOSE'
                : p.moveMode === MoveMode.Sprint ? 'SPRINT' : 'NORMAL';
        return {
        id: p.id, team: p.team, role: p.role, naturalRole: p.naturalRole, duty: p.duty,
        slotIndex: p.slotIndex, band: p.anchor?.band ?? null, name: p.name, isHuman: p.isHuman,
        x: p.pos.x, z: p.pos.z, facing: p.facing, speed: p.speed,
        animMode: p.animMode, act: p.currentAct, hasBall: carrying,
        motionState: p.motionState, strafeSign: p.strafeSign, moveMode: p.moveMode,
        locoState: p.locoState, locoPhase: p.locoPhase, locoFoot: p.locoFoot,
        locoContact: p.locoContact, locoStride: p.locoStride,
        kickKind: p.kickKind, actionSeq: p.actionSeq, actionImmediate: p.actionImmediate,
        stunned: p.stunned, offside: p.isInOffside, kickTimer: Math.max(0, p.kickTimer),
        stamina: p.stamina, diveSide: p.diveSide, feinting: this.time < p.feintUntil,
        skillKind: p.skillKind, faceUp: p.faceUp, carryMode,
        balance: p.balance, shielded: p.shieldActive, shieldSide: p.shieldSide,
        jostle: p.jostle, shieldTargetId: p.shieldTargetId,
        gkState: p.gkState, gkHoldTime: p.isGoalKeeper ? +(p.ballHoldTime ?? 0).toFixed(3) : 0,
        jumpHeight: p.jumpHeight, aiBehaviour: p.aiBehaviour ?? null,
        decision: p.decision ?? null,
        yellowCards: p.yellowCards, redCard: p.redCard, sentOff: p.sentOff
        };
      })
    };
  }
}

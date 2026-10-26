import * as V from './vec.js';
import { clamp, clamp01 } from '../core/math.js';
import { shotGeometry, shotXG, positionXG, passRetention, turnoverCost } from './analytics/xg.js';

const MIN_SHOT_XG = 0.025;
const MIN_PASS_VALUE = 0.015;

function safePoint(match, point) {
  return V.v3(
    clamp(point.x, -match.fieldHalfX + 2, match.fieldHalfX - 2),
    0,
    clamp(point.z, -match.fieldHalfZ + 2, match.fieldHalfZ - 2)
  );
}

/**
 * Score the carrier's options in a common currency: expected goals and
 * possession risk. Execution stays in the behaviour layer.
 */
export function evaluateAttack(match, p) {
  if (!p.hasBall || p.isGoalKeeper) return null;
  const team = match.teams[p.team];
  const goal = team.attackGoal;
  const ownGoal = team.ownGoal;
  const goalW = match.cfg.goalW;
  const dir = p.attackDir;
  const progress = clamp01((p.pos.x - ownGoal.x) / match.fieldLength);
  const geometry = shotGeometry(p.pos, goal, goalW);
  const blockers = match.shootBlockers(p, goal);
  const oneOnOne = match.isOneOnOneWithGK(p);
  const heading = V.headingOf(V.sub(V.v3(goal.x, 0, goal.z), p.pos));
  const headingDelta = Math.atan2(Math.sin(heading - p.facing), Math.cos(heading - p.facing));
  const orientation = clamp01(Math.cos(headingDelta));
  const xg = shotXG({
    ...geometry,
    blockers,
    oneOnOne,
    orientation,
    reception: p.receptionQuality
  });
  const shotValue = xg + (oneOnOne ? 0.05 : 0) +
    (progress > 0.65 ? 0.025 : 0) + (geometry.distance < 22 ? 0.015 : 0) +
    (xg >= 0.06 ? 0.015 : 0);
  const shotEligible = (geometry.distance <= 34 || oneOnOne) && xg >= MIN_SHOT_XG;

  const passes = [];
  for (const q of match.teams[p.team].players) {
    if (q === p) continue;
    const distance = V.distXZ(p.pos, q.pos);
    const maxDistance = q.isHuman ? 40 : 35;
    if (distance < 3 || distance > maxDistance || q.isInOffside) continue;
    const point = q.isHuman ? V.copy(q.pos) : match.leadPoint(q, 0.3);
    const lane = match.laneBlockers(p.pos, point, p.team);
    let nearestOpp = Infinity;
    for (const o of match.teams[1 - p.team].players) nearestOpp = Math.min(nearestOpp, V.distXZ(q.pos, o.pos));
    if (progress < 0.6 && (lane.tightest < 1.5 || nearestOpp < 2.2)) continue;
    const retention = passRetention({
      laneClearance: lane.tightest,
      receiverOpenness: nearestOpp,
      receiverControl: q.skills.ballControl / 100,
      distance,
      passerSkill: p.skills.passing / 100
    });
    const qGeometry = shotGeometry(q.pos, goal, goalW);
    const qXG = shotXG({
      ...qGeometry,
      blockers: nearestOpp < 1.2 ? 1 : 0,
      oneOnOne: false,
      orientation: 1,
      reception: 0.5
    });
    const qProgress = clamp01((q.pos.x - ownGoal.x) / match.fieldLength);
    const threat = qXG * 0.65 + Math.max(0, qProgress - progress) * 0.04 + 0.03;
    const risk = (1 - retention) * turnoverCost(qProgress);
    let value = retention * threat - risk;
    if (match.teams[p.team].inTransition && qProgress > progress) value += 0.02;
    if (q.isGoalKeeper) value -= 0.01;
    if (q.isHuman && match.time < q.calledForPassUntil && lane.tightest > 1 && nearestOpp > 1) value += 0.06;
    const boxHalf = (match.cfg.markings?.boxWidth ?? 40.32) / 2;
    const inBox = (goal.x - q.pos.x) * dir < 20 && Math.abs(q.pos.z) < boxHalf;
    const kind = inBox && Math.abs(p.pos.z) > match.fieldHalfZ * 0.38 ? 'cross' : 'pass';
    passes.push({
      action: kind,
      kind,
      target: q,
      point: kind === 'cross'
        ? safePoint(match, V.addScaled(q.pos, V.fromHeading(q.facing), 0.8))
        : safePoint(match, point),
      value,
      xg: qXG,
      retention,
      distance
    });
  }
  passes.sort((a, b) => b.value - a.value);
  const bestPass = passes[0] ?? null;

  const space = match.spaceAhead(p);
  const towardGoal = V.normalizeXZ(V.sub(V.v3(goal.x, 0, goal.z), p.pos));
  const carryPoint = safePoint(match, V.addScaled(p.pos, towardGoal, 4 + Math.min(12, space) * 0.6));
  const carryGeometry = shotGeometry(carryPoint, goal, goalW);
  const carryXG = positionXG(carryPoint, goal, goalW, 8);
  const pressure = match.nearestOpponentDistance(p);
  const carryValue = carryXG * 0.25 * (0.7 + clamp01(space / 24) * 0.3) - (pressure < 1.8 ? 0.02 : 0) + 0.003;

  const candidates = [];
  if (shotEligible) candidates.push({ action: 'shoot', kind: 'shot', value: shotValue, xg });
  if (bestPass && bestPass.value >= MIN_PASS_VALUE) candidates.push(bestPass);
  candidates.push({ action: 'carry', kind: 'carry', value: carryValue, xg: carryXG, point: carryPoint });
  candidates.sort((a, b) => b.value - a.value);
  const best = candidates[0] ?? { action: 'carry', kind: 'carry', value: carryValue, xg: carryXG, point: carryPoint };

  return {
    action: best.action,
    kind: best.kind,
    target: best.target ?? null,
    point: best.point ?? null,
    xg,
    shotValue,
    passValue: bestPass?.value ?? 0,
    carryValue,
    bestValue: best.value,
    shotEligible,
    retention: bestPass?.retention ?? null,
    options: { passes: passes.slice(0, 3), shotValue, carryValue },
    reason: best.action
  };
}

import { clamp01 } from '../../core/math.js';

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

// Analytic priors, calibrated against the game's own shot/pass outcomes.
// Keep the surface small: these are decision features, not a trained black box.
export const SHOT_MODEL = Object.freeze({
  intercept: -2.65,
  centrality: 1.9,
  distance: -0.085,
  blockers: -0.42,
  oneOnOne: 1.15,
  orientation: 0.22,
  reception: 0.18
});

export const PASS_MODEL = Object.freeze({
  intercept: -1.6,
  lane: 1.15,
  openness: 0.85,
  control: 0.75,
  distance: -0.045,
  skill: 0.55
});

export function shotGeometry(pos, goal, goalW) {
  const dx = goal.x - pos.x;
  const dz = goal.z - pos.z;
  const distance = Math.hypot(dx, dz);
  const lateral = Math.abs(dz);
  const mouth = goalW / 2;
  const centrality = clamp01(1 - lateral / (mouth + distance * 0.35));
  return { distance, centrality, lateral, angle: Math.atan2(mouth, Math.max(1, distance)) };
}

export function shotXG({ distance, centrality, blockers = 0, oneOnOne = false, orientation = 1, reception = 0.5 }) {
  const z = SHOT_MODEL.intercept +
    SHOT_MODEL.centrality * clamp01(centrality) +
    SHOT_MODEL.distance * distance +
    SHOT_MODEL.blockers * blockers +
    (oneOnOne ? SHOT_MODEL.oneOnOne : 0) +
    SHOT_MODEL.orientation * clamp01(orientation) +
    SHOT_MODEL.reception * clamp01(reception);
  return sigmoid(z);
}

export function positionXG(pos, goal, goalW, nearestOpp = 8) {
  const geometry = shotGeometry(pos, goal, goalW);
  return shotXG({
    ...geometry,
    blockers: nearestOpp < 1.2 ? 1 : 0,
    oneOnOne: false,
    orientation: 1,
    reception: 0.5
  });
}

export function passRetention({ laneClearance = 0, receiverOpenness = 0, receiverControl = 0.5, distance = 0, passerSkill = 0.5 }) {
  const z = PASS_MODEL.intercept +
    PASS_MODEL.lane * clamp01(laneClearance / 3) +
    PASS_MODEL.openness * clamp01((receiverOpenness - 1) / 7) +
    PASS_MODEL.control * clamp01(receiverControl) +
    PASS_MODEL.distance * distance +
    PASS_MODEL.skill * clamp01(passerSkill);
  return sigmoid(z);
}

export function turnoverCost(progress) {
  return 0.02 + 0.09 * (1 - clamp01(progress));
}

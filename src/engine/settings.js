import engineSettingsJson from '../data/engineSettings.json' with { type: 'json' };
import gkSettingsJson from '../data/gkSettings.json' with { type: 'json' };
import skillCurvesJson from '../data/playerSkillCurves.json' with { type: 'json' };
import engineOptionsJson from '../data/engineOptions.json' with { type: 'json' };
import { AnimCurve } from './curve.js';

function hydrate({ scalars, curves, tables }) {
  const out = { ...scalars, tables: tables ?? {} };
  for (const [k, v] of Object.entries(curves ?? {})) out[k] = AnimCurve.fromUnity(v);
  return out;
}

export const EngineSettings = hydrate(engineSettingsJson);
export const GKSettings = hydrate(gkSettingsJson);
export const PlayerSkillCurves = hydrate(skillCurvesJson);
export const EngineOptions = {
  ballDropPrediction: hydrate(engineOptionsJson.ballDropPrediction),
  ballDropPredictionForCrosses: hydrate(engineOptionsJson.ballDropPredictionForCrosses),
  crossBall: hydrate(engineOptionsJson.crossBall),
  shooting: hydrate(engineOptionsJson.shooting)
};

export const GRAVITY = 9.81; // UnityEngine.Physics.gravity magnitude

// MatchPlayer float converters apply PlayerSkillCurves: a 0 stat still yields ~60%.
export function skillToMultiplier(curveName, stat0to100) {
  const curve = PlayerSkillCurves[curveName];
  if (!curve) return stat0to100 / 100;
  return curve.evaluate(stat0to100 / 100);
}

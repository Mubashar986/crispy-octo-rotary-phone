import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const DB = join(here, '../../work/out/database');
const OUT = join(here, '../src/data');
mkdirSync(OUT, { recursive: true });

const read = (f) => JSON.parse(readFileSync(join(DB, f), 'utf8'));

const UNITY_META = new Set(['m_GameObject', 'm_Enabled', 'm_Script', 'm_Name', 'm_ObjectHideFlags']);

const isCurve = (v) => v && typeof v === 'object' && Array.isArray(v.m_Curve);
const trimCurve = (v) => ({
  m_Curve: v.m_Curve.map((k) => ({ time: k.time, value: k.value, inSlope: k.inSlope ?? 0, outSlope: k.outSlope ?? 0 })),
  m_PreInfinity: v.m_PreInfinity ?? 2,
  m_PostInfinity: v.m_PostInfinity ?? 2
});

function splitPayload(data) {
  const scalars = {}, curves = {}, tables = {};
  for (const [k, v] of Object.entries(data)) {
    if (UNITY_META.has(k)) continue;
    if (isCurve(v)) curves[k] = trimCurve(v);
    else if (Array.isArray(v)) tables[k] = v;
    else if (v && typeof v === 'object') tables[k] = v;
    else scalars[k] = v;
  }
  return { scalars, curves, tables };
}

// --- EngineSettings (87-param tuning surface) ---
const esRaw = read('EngineSettings.json');
const esData = Array.isArray(esRaw) ? esRaw[0].data : esRaw.data ?? esRaw;
const engineSettings = splitPayload(esData);

// --- Singletons: GK, skill curves, engine options, formations ---
const singletons = read('singletons.json');
const pick = (name) => (singletons[name] ? splitPayload(singletons[name].data ?? singletons[name]) : null);

const gkSettings = pick('GKSettings');
const playerSkillCurves = pick('PlayerSkillCurves');
const engineOptions = {
  ballDropPrediction: pick('EngineOptions_BallDropPrediction'),
  ballDropPredictionForCrosses: pick('EngineOptions_BallDropPredictionForCrosses'),
  crossBall: pick('EngineOptions_CrossBallSettings'),
  shooting: pick('EngineOptions_ShootingSettings')
};

const FORMATION_NAMES = ['FormalPositioning', 'AttackerCornerPositioning', 'DefenderCornerPositioning', 'KickOffPositioning', 'KickOffPositioning_Starter'];
const formations = {};
for (const name of FORMATION_NAMES) {
  const p = pick(name);
  if (!p) continue;
  const rows = p.tables.FieldPositions ?? p.tables.fieldPositions ?? [];
  formations[name] = {
    fixedLength: !!(p.scalars.FixedLength ?? p.tables.FixedLength),
    positions: rows.map((r) => ({
      name: r.Name, position: r.Position,
      h: r.HorizontalPlacement, v: r.VerticalPlacement
    }))
  };
}

// --- Position stat profiles (CSV) ---
const csv = readFileSync(join(DB, 'position_skill_profiles.csv'), 'utf8').trim().split(/\r?\n/);
const head = csv[0].split(',');
const profiles = {};
for (const line of csv.slice(1)) {
  const cells = line.split(',');
  const row = {};
  head.forEach((h, i) => { row[h] = cells[i]; });
  profiles[row.schema] = {
    positions: row.positions, mask: parseInt(row.position_mask, 10),
    skills: {
      strength: +row.strength, acceleration: +row.acceleration, topSpeed: +row.topSpeed,
      dribbleSpeed: +row.dribbleSpeed, jump: +row.jump, tackling: +row.tackling,
      ballKeeping: +row.ballKeeping, passing: +row.passing, longBall: +row.longBall,
      agility: +row.agility, shooting: +row.shooting, shootPower: +row.shootPower,
      positioning: +row.positioning, reaction: +row.reaction, ballControl: +row.ballControl
    }
  };
}

const write = (name, obj) => {
  writeFileSync(join(OUT, name), JSON.stringify(obj));
  console.log(`  src/data/${name}  (${(JSON.stringify(obj).length / 1024).toFixed(1)} KB)`);
};

console.log('generated:');
write('engineSettings.json', engineSettings);
write('gkSettings.json', gkSettings);
write('playerSkillCurves.json', playerSkillCurves);
write('engineOptions.json', engineOptions);
write('formations.json', formations);
write('positionProfiles.json', profiles);
console.log(`  engineSettings: ${Object.keys(engineSettings.scalars).length} scalars, ${Object.keys(engineSettings.curves).length} curves`);
console.log(`  formations: ${Object.keys(formations).join(', ')}`);

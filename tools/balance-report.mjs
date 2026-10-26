import { Match, Phase } from '../src/engine/match.js';
import { MODE_CONFIGS } from '../src/config/modes.js';
import * as V from '../src/engine/vec.js';

const arg = (name, fallback) => {
  const hit = process.argv.find((v) => v.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
};

const mode = arg('mode', 'full11');
const matches = Math.max(1, Number(arg('matches', 12)));
const humanMode = arg('human', '0') === '1';
const startSeed = Number(arg('seed', 1));
const CFG = MODE_CONFIGS[mode];

const blankTeam = () => ({
  shots: 0, goals: 0, xg: 0, passes: 0, completed: 0, intercepted: 0, out: 0,
  finalThird: 0, crosses: 0, headers: 0, holderTicks: 0
});

function scriptHuman(m, human) {
  if (!human) return;
  if (m.time > 2 && m.time % 1.5 < 1 / 30) m.callForPass(human);
  const team = m.teams[human.team];
  const dir = human.team === 0 ? 1 : -1;
  const lineX = team.offsideLine;
  const targetX = Math.min(m.ball.pos.x + dir * 15, lineX - dir * 1.5);
  const targetZ = Math.max(-m.fieldHalfZ + 6, Math.min(m.fieldHalfZ - 6, m.ball.pos.z * 0.4 + 6));
  const dx = targetX - human.pos.x;
  const dz = targetZ - human.pos.z;
  human.intent = Math.hypot(dx, dz) > 1.5 ? { worldX: dx, worldZ: dz, sprint: false } : null;
}

function runMatch(seed) {
  const m = new Match(CFG, { seed, humanSlot: humanMode ? 9 : null, aiLevel: 2 });
  m.phase = Phase.LIVE;
  m.clockSec = 0;
  m.time = 0;
  m.freezeUntil = 0;
  m.setPiece = null;
  const teams = [blankTeam(), blankTeam()];
  let shots = 0, goals = 0, xg = 0, headers = 0, maxPass = 0, maxShot = 0, clearances = 0;
  let holderTicks = 0, looseTicks = 0;
  const lastThird = [false, false];
  let pendingPass = null;
  const passZones = { own: { completed: 0, total: 0 }, mid: { completed: 0, total: 0 }, final: { completed: 0, total: 0 } };
  let humanPasses = 0, humanControls = 0, humanTouches = 0;
  const decisions = { shoot: 0, pass: 0, cross: 0, carry: 0 };
  let passRetentionSum = 0, passRetentionCount = 0;
  const decisionClock = new Map();
  const human = m.players.find((p) => p.isHuman);

  const closePass = (kind) => {
    if (!pendingPass) return;
    teams[pendingPass.team][kind]++;
    pendingPass = null;
  };

  m.events.on('PlayerPass', (ev) => {
    if (pendingPass) teams[pendingPass.team].out++;
    if (ev.kind === 'clear') { clearances++; return; }
    const progress = (ev.player.pos.x - m.goalNets[ev.player.team].x) / m.fieldLength;
    const zone = progress < 0.33 ? 'own' : progress < 0.66 ? 'mid' : 'final';
    pendingPass = { team: ev.player.team, time: m.time, zone };
    teams[ev.player.team].passes++;
    passZones[zone].total++;
    maxPass = Math.max(maxPass, ev.power);
    if (ev.player.passingTarget?.isHuman) humanPasses++;
  });
  m.events.on('PlayerControlBall', (ev) => {
    if (pendingPass) {
      if (ev.player.team === pendingPass.team) {
        teams[pendingPass.team].completed++;
        passZones[pendingPass.zone].completed++;
      } else teams[pendingPass.team].intercepted++;
      pendingPass = null;
    }
    if (ev.player.isHuman) humanControls++;
  });
  m.events.on('PlayerTouchTheBall', (ev) => {
    if (pendingPass && ev.player.team !== pendingPass.team) {
      teams[pendingPass.team].intercepted++;
      pendingPass = null;
    }
    if (ev.player.isHuman) humanTouches++;
  });
  m.events.on('PlayerShoot', (ev) => {
    shots++;
    teams[ev.player.team].shots++;
    const value = ev.xg ?? 0;
    xg += value;
    teams[ev.player.team].xg += value;
    maxShot = Math.max(maxShot, ev.power);
  });
  m.events.on('Goal', (ev) => { closePass('completed'); goals++; teams[ev.team].goals++; });
  m.events.on('PlayerHeader', (ev) => {
    headers++;
    if (pendingPass) {
      if (ev.player.team === pendingPass.team) closePass('completed');
      else closePass('intercepted');
    }
  });
  m.events.on('PlayerCross', (ev) => { teams[ev.player.team].crosses++; });
  m.events.on('ThrowIn', () => closePass('out'));
  m.events.on('GoalKick', () => closePass('out'));
  m.events.on('Corner', () => closePass('out'));

  const steps = Math.ceil(CFG.durationSec * 30);
  for (let i = 0; i < steps; i++) {
    scriptHuman(m, human);
    m.step(1 / 30);
    for (const p of m.players) {
      if (!p.decision || p._decisionTime === decisionClock.get(p.id)) continue;
      decisionClock.set(p.id, p._decisionTime);
      decisions[p.decision.action] = (decisions[p.decision.action] ?? 0) + 1;
      if ((p.decision.action === 'pass' || p.decision.action === 'cross') && p.decision.retention != null) {
        passRetentionSum += p.decision.retention;
        passRetentionCount++;
      }
    }
    const holder = m.ball.holder;
    if (holder) {
      holderTicks++;
      teams[holder.team].holderTicks++;
    } else looseTicks++;
    for (let team = 0; team < 2; team++) {
      const progress = (m.ball.pos.x - m.goalNets[team].x) / m.fieldLength;
      const inThird = progress > 0.66;
      if (inThird && !lastThird[team]) teams[team].finalThird++;
      lastThird[team] = inThird;
    }
  }
  if (pendingPass) teams[pendingPass.team].out++;
  return {
    score: [...m.score], shots, goals, xg, headers, maxPass, maxShot,
    holderTicks, looseTicks, teams, humanPasses, humanControls, humanTouches, decisions,
    passRetention: passRetentionCount ? passRetentionSum / passRetentionCount : null,
    passZones, clearances
  };
}

const rows = [];
for (let i = 0; i < matches; i++) rows.push(runMatch(startSeed + i));
const sum = (fn) => rows.reduce((n, r) => n + fn(r), 0);
const mean = (fn) => sum(fn) / rows.length;

const completed = rows.reduce((n, r) => n + r.teams[0].completed + r.teams[1].completed, 0);
const intercepted = rows.reduce((n, r) => n + r.teams[0].intercepted + r.teams[1].intercepted, 0);
const out = rows.reduce((n, r) => n + r.teams[0].out + r.teams[1].out, 0);
const passPct = completed / Math.max(1, completed + intercepted + out) * 100;
const holderPct = sum((r) => r.holderTicks) / Math.max(1, sum((r) => r.holderTicks + r.looseTicks)) * 100;
const minutes = CFG.durationSec / 60;
const shotsPerTeam = sum((r) => r.teams[0].shots + r.teams[1].shots) / rows.length / 2;
const finalThirdPerTeam = sum((r) => r.teams[0].finalThird + r.teams[1].finalThird) / rows.length / 2;

const report = {
  mode, matches, humanMode,
  shotsPerTeam: +(shotsPerTeam / (minutes / 10)).toFixed(2),
  goalsPerMatch: +mean((r) => r.goals).toFixed(2),
  xgPerMatch: +mean((r) => r.xg).toFixed(2),
  xgPerShot: +(sum((r) => r.xg) / Math.max(1, sum((r) => r.shots))).toFixed(3),
  passPct: +passPct.toFixed(1),
  possessionPct: +holderPct.toFixed(1),
  finalThirdPerTeam: +finalThirdPerTeam.toFixed(1),
  crossesPerTeam: +(sum((r) => r.teams[0].crosses + r.teams[1].crosses) / rows.length / 2).toFixed(1),
  headersPerMatch: +mean((r) => r.headers).toFixed(1),
  maxPassSpeed: +Math.max(...rows.map((r) => r.maxPass)).toFixed(1),
  maxShotSpeed: +Math.max(...rows.map((r) => r.maxShot)).toFixed(1),
  human: humanMode ? {
    passesTargeted: +(sum((r) => r.humanPasses) / rows.length).toFixed(1),
    controls: +(sum((r) => r.humanControls) / rows.length).toFixed(1),
    touches: +(sum((r) => r.humanTouches) / rows.length).toFixed(1)
  } : null,
  decisions: Object.fromEntries(Object.entries(rows.reduce((out, r) => {
    for (const [k, v] of Object.entries(r.decisions)) out[k] = (out[k] ?? 0) + v;
    return out;
  }, {})).map(([k, v]) => [k, +(v / rows.length).toFixed(1)])),
  avgPassRetention: +(rows.reduce((n, r) => n + (r.passRetention ?? 0), 0) / Math.max(1, rows.filter((r) => r.passRetention != null).length)).toFixed(3),
  passZones: Object.fromEntries(['own', 'mid', 'final'].map((zone) => {
    const completed = rows.reduce((n, r) => n + r.passZones[zone].completed, 0);
    const total = rows.reduce((n, r) => n + r.passZones[zone].total, 0);
    return [zone, { total, pct: total ? +(completed / total * 100).toFixed(1) : null }];
  })),
  clearancesPerMatch: +(sum((r) => r.clearances) / rows.length).toFixed(1)
};
console.log(JSON.stringify(report, null, 2));

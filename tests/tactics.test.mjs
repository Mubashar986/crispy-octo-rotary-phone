import test from 'node:test';
import assert from 'node:assert/strict';
import { Match, Phase } from '../src/engine/match.js';
import { MODE_CONFIGS } from '../src/config/modes.js';
import {
  FORMATIONS, MODE_ROLE_OPTIONS, formationsForMode, getFormation,
  defaultFormationId, attackingFormationId, makePhaseAnchor
} from '../src/config/formations.js';
import { roleBand, roleDuties, defaultDuty } from '../src/engine/roles.js';

const live = (cfg = MODE_CONFIGS.full11, opts = {}) => {
  const m = new Match(cfg, { seed: 31, humanSlot: null, aiLevel: 0, ...opts });
  m.phase = Phase.LIVE;
  m.time = 10;
  m.freezeUntil = 0;
  m.setPiece = null;
  m.clockSec = 0;
  return m;
};

const deadBall = (m) => {
  m.setPiece = 'THROWIN';
  m.freezeUntil = m.time + 5;
};

test('every formation is legal for its mode and differs by phase', () => {
  for (const modeId of Object.keys(FORMATIONS)) {
    const mode = MODE_CONFIGS[modeId];
    const list = formationsForMode(modeId);
    assert.ok(list.length >= 3, `${modeId} needs at least three formations`);
    for (const formation of list) {
      assert.equal(formation.slots.length, mode.teamSize, `${modeId}/${formation.id} size`);
      assert.equal(formation.slots[0].role, 'GK', `${modeId}/${formation.id} keeper`);
      let phaseDifference = 0;
      for (const [i, slot] of formation.slots.entries()) {
        assert.ok(slot.h >= 0 && slot.h <= 1, `${formation.id} slot ${i} h`);
        assert.ok(slot.v >= 0 && slot.v <= 1, `${formation.id} slot ${i} v`);
        assert.ok(roleDuties(slot.role).includes(slot.duty), `${formation.id} slot ${i} duty`);
        if (slot.role !== 'GK') {
          assert.ok(MODE_ROLE_OPTIONS[modeId].includes(slot.role), `${modeId} role ${slot.role}`);
          const inAnchor = makePhaseAnchor(slot);
          phaseDifference += Math.abs(inAnchor.v - slot.v) + Math.abs(inAnchor.h - slot.h);
        }
      }
      assert.ok(phaseDifference > 0, `${formation.id} needs an in/out shape difference`);
    }
  }
});

test('default formations drive roster roles and match the mode config', () => {
  for (const modeId of Object.keys(MODE_CONFIGS)) {
    const m = new Match(MODE_CONFIGS[modeId], { seed: 32, humanSlot: null, aiLevel: 0 });
    const formation = getFormation(modeId, MODE_CONFIGS[modeId].defaultFormation);
    assert.equal(m.teams[0].formationId, formation.id);
    assert.deepEqual(m.teams[0].players.map((p) => p.role), formation.slots.map((s) => s.role));
    assert.deepEqual(MODE_CONFIGS[modeId].roles, formation.slots.map((s) => s.role));
    assert.deepEqual(m.teams[0].players.map((p) => p.duty), formation.slots.map((s) => s.duty));
    assert.ok(m.teams[0].players.every((p) => p.anchorIn && p.anchorOut && p.anchor));
  }
});

test('possession phase selects the in or out anchor', () => {
  const m = live();
  const team = m.teams[0];
  const fullback = team.players.find((p) => p.role === 'FB');
  const winger = team.players.find((p) => p.role === 'W');
  assert.ok(fullback.anchorIn.v > fullback.anchorOut.v);
  assert.ok(winger.anchorIn.v > winger.anchorOut.v);
  fullback.markingTarget = null;
  team.phase = 'IN_POSSESSION';
  team.ballProgress = 0.5;
  const inPos = team.getFieldPosition(fullback, 0.5);
  team.phase = 'OUT_OF_POSSESSION';
  const outPos = team.getFieldPosition(fullback, 0.5);
  assert.ok((inPos.x - outPos.x) * team.dir > 1, 'attacking full-back should advance in possession');
});

test('formation changes preserve player identity, human control and keeper', () => {
  const m = live(MODE_CONFIGS.full11, { humanSlot: 5 });
  const team = m.teams[0];
  const human = m.players.find((p) => p.isHuman);
  const ids = team.players.map((p) => p.id).sort();
  const beforePos = { x: human.pos.x, z: human.pos.z };
  const result = m.setTeamFormation(0, '4-3-3');
  assert.equal(result.ok, true);
  assert.equal(team.formationId, '4-3-3');
  assert.deepEqual(team.players.map((p) => p.id).sort(), ids);
  assert.equal(m.players.find((p) => p.id === human.id), human);
  assert.equal(human.isHuman, true);
  assert.equal(team.players.find((p) => p.isGoalKeeper).role, 'GK');
  assert.equal(new Set(team.players.map((p) => p.slotIndex)).size, team.players.length);
  assert.equal(roleBand(human.role), 'ST', 'the human forward should stay in the forward group');
  assert.deepEqual({ x: human.pos.x, z: human.pos.z }, beforePos, 'shape change must not teleport players');
});

test('an emergency keeper takes the keeper slot and survives a formation change', () => {
  const m = live();
  const team = m.teams[0];
  const keeper = team.players.find((p) => p.isGoalKeeper);
  m.applyCard(keeper, 'red', 'DOGSO');
  const replacement = team.players.find((p) => p.role === 'GK' && p !== keeper);
  assert.ok(replacement);
  assert.equal(replacement.slotIndex, 0);
  assert.ok(replacement.anchorOut.v < 0.1);
  assert.equal(team.players.filter((p) => !p.sentOff && p.role === 'GK').length, 1);
  m.setTeamFormation(0, '4-3-3');
  assert.equal(team.players.filter((p) => !p.sentOff && p.role === 'GK').length, 1);
  assert.equal(replacement.slotIndex, 0);
});

test('a sent-off player does not break a formation change', () => {
  const m = live();
  const team = m.teams[0];
  team.players[5].sentOff = true;
  const result = m.setTeamFormation(0, '4-3-3');
  assert.equal(result.ok, true);
  assert.equal(team.formationId, '4-3-3');
  const active = team.players.filter((p) => !p.sentOff);
  assert.equal(active.length, 10);
  assert.equal(new Set(active.map((p) => p.slotIndex)).size, 10);
  assert.equal(team.players.find((p) => p.isGoalKeeper).role, 'GK');
});

test('live shape changes queue until the next dead ball', () => {
  const m = live();
  const result = m.queueFormation(0, '4-3-3');
  assert.equal(result.ok, true);
  assert.equal(result.pending, true);
  assert.equal(m.teams[0].formationId, '4-4-2');
  assert.equal(m.pendingFormations[0].formationId, '4-3-3');
  deadBall(m);
  m.step(1 / 30);
  assert.equal(m.teams[0].formationId, '4-3-3');
  assert.equal(m.pendingFormations[0], null);
});

test('role and duty plans apply at a stoppage and move the phase anchor', () => {
  const m = live();
  const team = m.teams[0];
  const index = team.formation.slots.findIndex((s) => s.role === 'FB');
  const player = team.players.find((p) => p.slotIndex === index);
  const oldIn = player.anchorIn.v;
  const rolePlan = team.formation.slots.map((s) => ({ role: s.role, duty: s.duty }));
  rolePlan[index] = { role: 'FB', duty: 'Attack' };
  const queued = m.queueFormation(0, team.formationId, rolePlan);
  assert.equal(queued.pending, true);
  deadBall(m);
  m.step(1 / 30);
  assert.equal(team.formation.slots[index].duty, 'Attack');
  assert.equal(player.duty, 'Attack');
  assert.ok(player.anchorIn.v > oldIn);
});

test('mentality changes the shape immediately', () => {
  const m = live();
  const team = m.teams[0];
  team.phase = 'IN_POSSESSION';
  team.ballProgress = 0.5;
  const striker = team.players.find((p) => p.role === 'ST');
  const before = team.getFieldPosition(striker, 0.5);
  const result = m.setTeamTactic(0, 'Offensive');
  assert.equal(result.ok, true);
  assert.equal(team.tactic, 'Offensive');
  const after = team.getFieldPosition(striker, 0.5);
  assert.ok((after.x - before.x) * team.dir > 1, 'offensive mentality should push the line up');
});

test('AI adapts mentality and switches shape at half-time when losing', () => {
  const m = live();
  m.score = [1, 0];
  m.clockSec = m.cfg.durationSec * 0.8;
  m.updateAiTactics({ force: true });
  assert.equal(m.teams[1].tactic, 'Offensive');

  m.score = [0, 1];
  m.clockSec = m.cfg.durationSec * 0.9;
  m.updateAiTactics({ force: true });
  assert.equal(m.teams[1].tactic, 'ParkTheBus');

  m.score = [1, 0];
  m.phase = Phase.HALF_TIME;
  m.clockSec = m.cfg.durationSec * 0.5;
  m.updateAiTactics({ force: true, allowFormation: true });
  assert.equal(m.teams[1].formationId, attackingFormationId('full11'));
  assert.equal(m.teams[1].tactic, 'Offensive');
});

test('substitutes inherit the outgoing slot role and keeper subs stay keepers', () => {
  const m = live();
  deadBall(m);
  const team = m.teams[0];
  const fullback = team.players.find((p) => p.role === 'FB');
  const bench = team.bench.find((p) => !p.isGoalKeeper);
  const oldRole = fullback.role;
  const oldSlot = fullback.slotIndex;
  const oldIn = fullback.anchorIn.v;
  const result = m.substitute(0, fullback.id, bench.id);
  assert.equal(result.ok, true);
  assert.equal(bench.role, oldRole);
  assert.equal(bench.slotIndex, oldSlot);
  assert.equal(bench.anchorIn.v, oldIn);

  const keeper = team.players.find((p) => p.isGoalKeeper);
  const nonKeeper = team.bench.find((p) => !p.isGoalKeeper);
  const blocked = m.substitute(0, keeper.id, nonKeeper.id);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'GK_NEEDS_KEEPER');
});

test('snapshot exposes formation, tactic, duty and pending shape', () => {
  const m = live();
  const team = m.teams[0];
  const queued = m.queueFormation(0, '4-3-3');
  assert.equal(queued.pending, true);
  const snap = m.getSnapshot();
  assert.equal(snap.teams[0].formationId, '4-4-2');
  assert.equal(snap.teams[0].pendingFormation, '4-3-3');
  assert.equal(snap.teams[0].tactic, 'Balanced');
  assert.equal(snap.players[0].role, 'GK');
  assert.equal(snap.players[0].duty, 'Hold');
  assert.ok(snap.players.every((p) => p.band));
  assert.ok(snap.players.every((p) => p.slotIndex != null));
  assert.ok(snap.bench[0].every((p) => p.naturalRole));
  assert.equal(snap.teams[0].tacticPreset.press, 0.60);
  assert.equal(defaultFormationId('full11'), '4-4-2');
  assert.equal(roleBand(getFormation('full11', '4-3-3').slots[5].role), 'CM');
  assert.equal(defaultDuty('DM'), 'Hold');
});

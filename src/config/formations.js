import { clamp } from '../core/math.js';
import { roleBand, roleMeta, defaultDuty, normaliseDuty } from '../engine/roles.js';

const slot = (role, duty, h, v) => ({ role, duty, h, v });
const GK = () => slot('GK', 'Hold', 0.5, 0.06);

// Every formation is expressed as out-of-possession base slots.
// In-possession anchors are derived from the role duty, so changing a
// full-back from Support to Attack visibly changes the attacking shape.
export const FORMATIONS = {
  cage3: [
    {
      id: '1-2', name: '1-2', style: 'balanced', description: 'One defender, two forwards',
      slots: [GK(), slot('DEF', 'Hold', 0.5, 0.24), slot('FWD', 'Attack', 0.28, 0.74), slot('FWD', 'Attack', 0.72, 0.74)]
    },
    {
      id: '2-1', name: '2-1', style: 'defensive', description: 'Two defenders, one forward',
      slots: [GK(), slot('DEF', 'Hold', 0.3, 0.24), slot('DEF', 'Hold', 0.7, 0.24), slot('FWD', 'Attack', 0.5, 0.78)]
    },
    {
      id: '1-1-1', name: '1-1-1', style: 'attacking', description: 'Balanced diamond',
      slots: [GK(), slot('DEF', 'Hold', 0.5, 0.22), slot('MID', 'Support', 0.5, 0.52), slot('FWD', 'Attack', 0.5, 0.82)]
    }
  ],
  classic5: [
    {
      id: '2-2-1', name: '2-2-1', style: 'balanced', description: 'Compact two banks with a striker',
      slots: [GK(), slot('DEF', 'Hold', 0.28, 0.22), slot('DEF', 'Hold', 0.72, 0.22), slot('MID', 'Support', 0.28, 0.52), slot('MID', 'Support', 0.72, 0.52), slot('FWD', 'Attack', 0.5, 0.82)]
    },
    {
      id: '1-3-1', name: '1-3-1', style: 'attacking', description: 'Three midfielders behind the striker',
      slots: [GK(), slot('DEF', 'Hold', 0.5, 0.22), slot('MID', 'Support', 0.2, 0.52), slot('MID', 'Support', 0.5, 0.48), slot('MID', 'Support', 0.8, 0.52), slot('FWD', 'Attack', 0.5, 0.82)]
    },
    {
      id: '3-1-1', name: '3-1-1', style: 'defensive', description: 'Three at the back, one screen',
      slots: [GK(), slot('DEF', 'Hold', 0.2, 0.22), slot('DEF', 'Hold', 0.5, 0.2), slot('DEF', 'Hold', 0.8, 0.22), slot('MID', 'Support', 0.5, 0.52), slot('FWD', 'Attack', 0.5, 0.82)]
    },
    {
      id: '2-1-2', name: '2-1-2', style: 'attacking', description: 'Two forwards and a playmaker',
      slots: [GK(), slot('DEF', 'Hold', 0.28, 0.22), slot('DEF', 'Hold', 0.72, 0.22), slot('MID', 'Support', 0.5, 0.5), slot('FWD', 'Attack', 0.3, 0.8), slot('FWD', 'Attack', 0.7, 0.8)]
    }
  ],
  club7: [
    {
      id: '2-3-2', name: '2-3-2', style: 'balanced', description: 'Wing-backs supply a front two',
      slots: [GK(), slot('DEF', 'Hold', 0.3, 0.2), slot('DEF', 'Hold', 0.7, 0.2), slot('WB', 'Support', 0.14, 0.5), slot('MID', 'Support', 0.5, 0.48), slot('WB', 'Support', 0.86, 0.5), slot('FWD', 'Attack', 0.3, 0.82), slot('FWD', 'Attack', 0.7, 0.82)]
    },
    {
      id: '3-2-2', name: '3-2-2', style: 'defensive', description: 'Three centre-backs and two strikers',
      slots: [GK(), slot('DEF', 'Hold', 0.2, 0.2), slot('DEF', 'Hold', 0.5, 0.18), slot('DEF', 'Hold', 0.8, 0.2), slot('MID', 'Support', 0.35, 0.5), slot('MID', 'Support', 0.65, 0.5), slot('FWD', 'Attack', 0.3, 0.82), slot('FWD', 'Attack', 0.7, 0.82)]
    },
    {
      id: '2-4-1', name: '2-4-1', style: 'attacking', description: 'Four across midfield, one target',
      slots: [GK(), slot('DEF', 'Hold', 0.3, 0.2), slot('DEF', 'Hold', 0.7, 0.2), slot('WB', 'Attack', 0.12, 0.5), slot('MID', 'Support', 0.38, 0.48), slot('MID', 'Support', 0.62, 0.48), slot('WB', 'Attack', 0.88, 0.5), slot('FWD', 'Attack', 0.5, 0.84)]
    }
  ],
  full11: [
    {
      id: '4-4-2', name: '4-4-2', style: 'balanced', description: 'Two banks of four and a front two',
      slots: [
        GK(),
        slot('FB', 'Support', 0.12, 0.22), slot('CB', 'Hold', 0.37, 0.18), slot('CB', 'Hold', 0.63, 0.18), slot('FB', 'Support', 0.88, 0.22),
        slot('W', 'Support', 0.12, 0.5), slot('CM', 'Support', 0.4, 0.46), slot('CM', 'Support', 0.6, 0.46), slot('W', 'Support', 0.88, 0.5),
        slot('ST', 'Attack', 0.38, 0.84), slot('ST', 'Attack', 0.62, 0.84)
      ]
    },
    {
      id: '4-3-3', name: '4-3-3', style: 'attacking', description: 'One holding midfielder, two eights, a front three',
      slots: [
        GK(),
        slot('FB', 'Support', 0.12, 0.22), slot('CB', 'Hold', 0.37, 0.18), slot('CB', 'Hold', 0.63, 0.18), slot('FB', 'Support', 0.88, 0.22),
        slot('DM', 'Hold', 0.5, 0.36), slot('CM', 'Support', 0.3, 0.5), slot('CM', 'Support', 0.7, 0.5),
        slot('W', 'Attack', 0.12, 0.8), slot('ST', 'Attack', 0.5, 0.86), slot('W', 'Attack', 0.88, 0.8)
      ]
    },
    {
      id: '4-2-3-1', name: '4-2-3-1', style: 'balanced', description: 'Double pivot behind an attacking three',
      slots: [
        GK(),
        slot('FB', 'Support', 0.12, 0.22), slot('CB', 'Hold', 0.37, 0.18), slot('CB', 'Hold', 0.63, 0.18), slot('FB', 'Support', 0.88, 0.22),
        slot('DM', 'Hold', 0.35, 0.38), slot('DM', 'Hold', 0.65, 0.38),
        slot('W', 'Support', 0.14, 0.64), slot('AM', 'Attack', 0.5, 0.66), slot('W', 'Support', 0.86, 0.64),
        slot('ST', 'Attack', 0.5, 0.86)
      ]
    },
    {
      id: '3-5-2', name: '3-5-2', style: 'attacking', description: 'Three centre-backs, high wing-backs, two strikers',
      slots: [
        GK(),
        slot('CB', 'Hold', 0.25, 0.18), slot('CB', 'Hold', 0.5, 0.16), slot('CB', 'Hold', 0.75, 0.18),
        slot('WB', 'Attack', 0.08, 0.48), slot('DM', 'Hold', 0.5, 0.4), slot('CM', 'Support', 0.32, 0.54), slot('CM', 'Support', 0.68, 0.54), slot('WB', 'Attack', 0.92, 0.48),
        slot('ST', 'Attack', 0.38, 0.84), slot('ST', 'Attack', 0.62, 0.84)
      ]
    }
  ]
};

export const MODE_ROLE_OPTIONS = {
  cage3: ['DEF', 'MID', 'FWD'],
  classic5: ['DEF', 'MID', 'FWD'],
  club7: ['DEF', 'WB', 'MID', 'AM', 'FWD'],
  full11: ['CB', 'FB', 'WB', 'DM', 'CM', 'AM', 'W', 'ST']
};

export const BENCH_ROLES = {
  cage3: ['GK', 'DEF', 'FWD'],
  classic5: ['GK', 'DEF', 'MID', 'FWD'],
  club7: ['GK', 'DEF', 'WB', 'MID', 'FWD'],
  full11: ['GK', 'CB', 'FB', 'DM', 'CM', 'W', 'ST']
};

export const TACTIC_OPTIONS = [
  { id: 'ParkTheBus', label: 'PARK THE BUS', short: 'PTB', description: 'Deep block, low press, protect the box' },
  { id: 'Defensive', label: 'DEFENSIVE', short: 'DEF', description: 'Compact shape, safe build-up' },
  { id: 'CounterAttack', label: 'COUNTER', short: 'CTR', description: 'Drop in, then attack the space quickly' },
  { id: 'Balanced', label: 'BALANCED', short: 'BAL', description: 'Hold shape and choose the moment' },
  { id: 'HighPressure', label: 'HIGH PRESS', short: 'PRS', description: 'Push the line up and hunt the ball' },
  { id: 'Offensive', label: 'OFFENSIVE', short: 'OFF', description: 'Wide, deep and aggressive in possession' }
];

export function cloneFormation(formation) {
  return { ...formation, slots: formation.slots.map((s) => ({ ...s })) };
}

export function formationsForMode(modeId) {
  return FORMATIONS[modeId] ?? [];
}

export function getFormation(modeId, formationId) {
  const found = formationsForMode(modeId).find((f) => f.id === formationId);
  return found ? cloneFormation(found) : null;
}

export function defaultFormationId(modeId) {
  return formationsForMode(modeId)[0]?.id ?? null;
}

export function attackingFormationId(modeId) {
  const list = formationsForMode(modeId);
  return (list.find((f) => f.style === 'attacking') ?? list[0])?.id ?? null;
}

export function defensiveFormationId(modeId) {
  const list = formationsForMode(modeId);
  return (list.find((f) => f.style === 'defensive') ?? list[0])?.id ?? null;
}

export function makeAnchor(slotDef) {
  return {
    h: slotDef.h,
    v: slotDef.v,
    band: roleBand(slotDef.role),
    role: slotDef.role,
    duty: normaliseDuty(slotDef.role, slotDef.duty)
  };
}

export function makePhaseAnchor(slotDef) {
  const meta = roleMeta(slotDef.role);
  const duty = normaliseDuty(slotDef.role, slotDef.duty);
  const push = meta.push[duty] ?? 0;
  const narrow = meta.narrow[duty] ?? 0;
  return {
    h: clamp(0.5 + (slotDef.h - 0.5) * (1 - narrow), 0.04, 0.96),
    v: clamp(slotDef.v + push, 0.05, 0.94),
    band: meta.band,
    role: slotDef.role,
    duty
  };
}

export function applyRolePlan(formation, rolePlan) {
  if (!Array.isArray(rolePlan)) return cloneFormation(formation);
  const out = cloneFormation(formation);
  out.slots = out.slots.map((s, i) => {
    if (i === 0) return s;
    const patch = rolePlan[i];
    if (!patch?.role) return s;
    const meta = roleMeta(patch.role);
    if (!meta || meta.band === 'GK') return s;
    return { ...s, role: patch.role, duty: normaliseDuty(patch.role, patch.duty ?? meta.defaultDuty) };
  });
  return out;
}

export function benchSlots(modeId, benchSize) {
  const roles = BENCH_ROLES[modeId] ?? ['GK', 'DEF', 'MID', 'FWD'];
  return Array.from({ length: benchSize }, (_, i) => {
    const role = roles[i % roles.length];
    const duty = defaultDuty(role);
    const depth = { GK: 0.06, CB: 0.24, CM: 0.52, ST: 0.8 }[roleBand(role)] ?? 0.5;
    return { role, duty, h: 0.5, v: depth };
  });
}

export function roleOptionsForMode(modeId, includeGK = true) {
  const list = MODE_ROLE_OPTIONS[modeId] ?? ['DEF', 'MID', 'FWD'];
  return includeGK ? ['GK', ...list] : list.slice();
}

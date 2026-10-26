// Role taxonomy shared by the formation catalog, engine and UI.
// Bands stay CB/CM/ST so every existing behaviour keeps a fallback.
export const ROLE_META = {
  GK: { label: 'GOALKEEPER', short: 'GK', band: 'GK', group: 'GK', duties: ['Hold'], defaultDuty: 'Hold', push: { Hold: 0 }, narrow: { Hold: 0 } },
  CB: { label: 'CENTRE BACK', short: 'CB', band: 'CB', group: 'DEF', duties: ['Hold', 'Support'], defaultDuty: 'Hold', push: { Hold: 0.01, Support: 0.04 }, narrow: { Hold: 0, Support: 0.05 } },
  FB: { label: 'FULL-BACK', short: 'FB', band: 'CB', group: 'DEF', duties: ['Hold', 'Support', 'Attack'], defaultDuty: 'Support', push: { Hold: 0.02, Support: 0.12, Attack: 0.20 }, narrow: { Hold: 0, Support: -0.02, Attack: -0.04 } },
  WB: { label: 'WING-BACK', short: 'WB', band: 'CB', group: 'DEF', duties: ['Support', 'Attack'], defaultDuty: 'Support', push: { Support: 0.18, Attack: 0.26 }, narrow: { Support: -0.02, Attack: -0.04 } },
  DM: { label: 'DEFENSIVE MID', short: 'DM', band: 'CM', group: 'MID', duties: ['Hold', 'Support', 'Attack'], defaultDuty: 'Hold', push: { Hold: 0.01, Support: 0.05, Attack: 0.10 }, narrow: { Hold: 0.12, Support: 0.10, Attack: 0.06 } },
  CM: { label: 'CENTRAL MID', short: 'CM', band: 'CM', group: 'MID', duties: ['Hold', 'Support', 'Attack'], defaultDuty: 'Support', push: { Hold: 0.01, Support: 0.07, Attack: 0.12 }, narrow: { Hold: 0.06, Support: 0.08, Attack: 0.12 } },
  AM: { label: 'ATTACKING MID', short: 'AM', band: 'CM', group: 'MID', duties: ['Support', 'Attack'], defaultDuty: 'Attack', push: { Support: 0.05, Attack: 0.10 }, narrow: { Support: 0.22, Attack: 0.26 } },
  W: { label: 'WINGER', short: 'W', band: 'ST', group: 'FWD', duties: ['Support', 'Attack'], defaultDuty: 'Attack', push: { Support: 0.06, Attack: 0.12 }, narrow: { Support: -0.06, Attack: -0.08 } },
  ST: { label: 'STRIKER', short: 'ST', band: 'ST', group: 'FWD', duties: ['Support', 'Attack'], defaultDuty: 'Attack', push: { Support: 0.03, Attack: 0.05 }, narrow: { Support: 0.10, Attack: 0.12 } },
  DEF: { label: 'DEFENDER', short: 'DEF', band: 'CB', group: 'DEF', duties: ['Hold', 'Support'], defaultDuty: 'Hold', push: { Hold: 0.01, Support: 0.06 }, narrow: { Hold: 0, Support: 0.02 } },
  MID: { label: 'MIDFIELD', short: 'MID', band: 'CM', group: 'MID', duties: ['Hold', 'Support', 'Attack'], defaultDuty: 'Support', push: { Hold: 0.01, Support: 0.07, Attack: 0.12 }, narrow: { Hold: 0.06, Support: 0.08, Attack: 0.10 } },
  FWD: { label: 'FORWARD', short: 'FWD', band: 'ST', group: 'FWD', duties: ['Support', 'Attack'], defaultDuty: 'Attack', push: { Support: 0.05, Attack: 0.10 }, narrow: { Support: 0.05, Attack: 0.08 } }
};

export const ROLE_SKILL_BIAS = {
  CB: { tackling: 3, strength: 3, positioning: 1 },
  FB: { topSpeed: 3, stamina: 4, tackling: 1 },
  WB: { topSpeed: 4, stamina: 5, dribbleSpeed: 2 },
  DM: { tackling: 5, positioning: 5, passing: 2 },
  CM: { passing: 2, stamina: 2, ballControl: 1 },
  AM: { passing: 4, ballControl: 3, shooting: 2 },
  W: { topSpeed: 4, dribbleSpeed: 4, ballControl: 2 },
  ST: { shooting: 4, positioning: 3, shootPower: 2 },
  DEF: { tackling: 2, strength: 2 },
  MID: { passing: 2, stamina: 2 },
  FWD: { shooting: 3, positioning: 2 }
};

export function roleMeta(role) {
  return ROLE_META[role] ?? ROLE_META.CM;
}

export function roleBand(role) {
  return roleMeta(role).band;
}

export function roleDuties(role) {
  return roleMeta(role).duties;
}

export function defaultDuty(role) {
  return roleMeta(role).defaultDuty;
}

export function normaliseDuty(role, duty) {
  const meta = roleMeta(role);
  return meta.duties.includes(duty) ? duty : meta.defaultDuty;
}

export function skillBiasForRole(role) {
  return ROLE_SKILL_BIAS[role] ?? {};
}

export function isWideDefender(role) {
  return ['FB', 'WB'].includes(role);
}

export function isCentralMid(role) {
  return ['DM', 'CM', 'AM', 'MID'].includes(role);
}

export function isForward(role) {
  return ['W', 'ST', 'FWD'].includes(role);
}

export function isAttackingDuty(player) {
  return player?.duty === 'Attack';
}

export function isHoldingDuty(player) {
  return player?.duty === 'Hold';
}

// One shared full-size football ground for every mode (user decision).
// Team count and roles vary by mode; the pitch, goals and markings never do.
const FULL_PITCH = {
  pitchLength: 105, pitchWidth: 68,
  goalW: 7.32, goalH: 2.44, runoff: 9,
  markings: { boxDepth: 16.5, boxWidth: 40.32, goalAreaDepth: 5.5, goalAreaWidth: 18.32, penaltySpot: 11, circle: 9.15, cornerArc: 1 }
};

export const MODE_CONFIGS = {
  cage3: {
    ...FULL_PITCH,
    id: 'cage3', name: '3v3 STREET CAGE', teamSize: 4, benchSize: 3, durationSec: 180, matchMinutes: 40, offside: false,
    defaultFormation: '1-2',
    roles: ['GK', 'DEF', 'FWD', 'FWD']
  },
  classic5: {
    ...FULL_PITCH,
    id: 'classic5', name: '5v5 SMALL-SIDED', teamSize: 6, benchSize: 4, durationSec: 300, matchMinutes: 60, offside: false,
    defaultFormation: '2-2-1',
    roles: ['GK', 'DEF', 'DEF', 'MID', 'MID', 'FWD']
  },
  club7: {
    ...FULL_PITCH,
    id: 'club7', name: '7v7 SMALL-SIDED (OFFSIDE)', teamSize: 8, benchSize: 5, durationSec: 480, matchMinutes: 80, offside: true,
    defaultFormation: '2-3-2',
    roles: ['GK', 'DEF', 'DEF', 'WB', 'MID', 'WB', 'FWD', 'FWD']
  },
  full11: {
    ...FULL_PITCH,
    id: 'full11', name: '11v11 FULL PITCH', teamSize: 11, benchSize: 7, durationSec: 600, matchMinutes: 90, offside: true,
    defaultFormation: '4-4-2',
    roles: ['GK', 'FB', 'CB', 'CB', 'FB', 'W', 'CM', 'CM', 'W', 'ST', 'ST']
  }
};

export const ROLE_LABELS = {
  GK: 'GOALKEEPER', DEF: 'DEFENDER', MID: 'MIDFIELD', FWD: 'FORWARD',
  CB: 'CENTRE BACK', FB: 'FULL-BACK', WB: 'WING-BACK', DM: 'DEFENSIVE MID',
  CM: 'CENTRAL MID', AM: 'ATTACKING MID', W: 'WINGER', ST: 'STRIKER'
};

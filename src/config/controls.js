// Keyboards are described by e.key (lowercase) or e.code. Each scheme maps both
// movement and actions; the HUD uses labels from the same source of truth.
export const CONTROL_SCHEMES = {
  arrows: {
    id: 'arrows', name: 'Arrow Classic',
    movementLabel: 'ARROWS or WASD',
    keys: {
      movement: ['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd'],
      sprint: ['shift'], closeControl: ['m'], faceUp: ['n'],
      pass: [' ', 'space'], shoot: ['x'], skill: ['c'], through: ['z'],
      switch: ['f'], call: ['g'],
      camera: ['v'], ping: ['p'], chat: ['t']
    },
    codes: { pass: ['Space'] },
    labels: { pass: 'SPACE', shoot: 'X', skill: 'C', through: 'Z', sprint: 'SHIFT', closeControl: 'M', faceUp: 'N', camera: 'V', switch: 'F', call: 'G' }
  },
  wasd: {
    id: 'wasd', name: 'WASD Left Hand',
    movementLabel: 'WASD',
    keys: {
      movement: ['w', 'a', 's', 'd'], sprint: ['shift'], closeControl: ['m'], faceUp: ['n'],
      pass: [' '], shoot: ['e'], skill: ['q'], through: ['r'],
      switch: ['f'], call: ['g'],
      camera: ['v'], ping: ['p'], chat: ['t']
    },
    codes: { pass: ['Space'] },
    labels: { pass: 'SPACE', shoot: 'E', skill: 'Q', through: 'R', sprint: 'SHIFT', closeControl: 'M', faceUp: 'N', camera: 'V', switch: 'F', call: 'G' }
  },
  homerow: {
    id: 'homerow', name: 'WASD Home Row',
    movementLabel: 'WASD',
    keys: {
      movement: ['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'],
      sprint: ['shift'], closeControl: ['m'], faceUp: ['n'],
      pass: ['j', ' '], shoot: ['k'], skill: ['l'], through: ['i'],
      switch: ['f'], call: ['g'],
      camera: ['v'], ping: ['q'], chat: ['t']
    },
    codes: { pass: ['Space'] },
    labels: { pass: 'J', shoot: 'K', skill: 'L', through: 'I', sprint: 'SHIFT', closeControl: 'M', faceUp: 'N', camera: 'V', switch: 'F', call: 'G' }
  },
  mouse: {
    id: 'mouse', name: 'WASD + Mouse',
    movementLabel: 'WASD',
    keys: {
      movement: ['w', 'a', 's', 'd'], sprint: ['shift'], closeControl: ['m'], faceUp: ['n'],
      pass: [], shoot: [], skill: ['q'], through: [],
      switch: ['f'], call: ['g'],
      camera: ['v'], ping: ['p'], chat: ['t']
    },
    codes: {},
    mouse: { pass: 0, through: 1, shoot: 2 },
    labels: { pass: 'LMB', shoot: 'RMB', skill: 'Q', through: 'MMB', sprint: 'SHIFT', closeControl: 'M', faceUp: 'N', camera: 'V', switch: 'F', call: 'G' }
  },
  numpad: {
    id: 'numpad', name: 'Numpad Striker',
    movementLabel: 'ARROW KEYS',
    keys: {
      movement: ['arrowup', 'arrowdown', 'arrowleft', 'arrowright'], sprint: ['shift'], closeControl: ['m'], faceUp: ['n'],
      pass: [], shoot: [], skill: [], through: [],
      switch: ['f'], call: ['g'],
      camera: ['v'], ping: ['p'], chat: ['t']
    },
    codes: { pass: ['Numpad1'], shoot: ['Numpad2'], skill: ['Numpad0'], through: ['Numpad3'] },
    labels: { pass: 'NUM 1', shoot: 'NUM 2', skill: 'NUM 0', through: 'NUM 3', sprint: 'SHIFT', closeControl: 'M', faceUp: 'N', camera: 'V', switch: 'F', call: 'G' }
  }
};

export const DEFAULT_SCHEME = 'arrows';
export const SCHEME_LIST = Object.values(CONTROL_SCHEMES);

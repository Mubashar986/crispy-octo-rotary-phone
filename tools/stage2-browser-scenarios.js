export async function verifyStage2InBrowser() {
  const P = window.__pitchline;
  const checks = [];
  const assert = (name, condition) => {
    if (!condition) throw new Error(`Stage 2 browser check failed: ${name}`);
    checks.push(name);
  };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const key = (type, value, time) => {
    const e = new KeyboardEvent(type, { key: value, bubbles: true });
    Object.defineProperty(e, 'timeStamp', { value: time });
    window.dispatchEvent(e);
  };
  const setup = () => {
    if (!P.host) document.getElementById('btn-start').click();
    const tutorial = document.getElementById('controls-panel');
    if (tutorial && !tutorial.classList.contains('hidden')) document.getElementById('btn-tutorial-close').click();
    document.activeElement?.blur();
    P.state.input.resetAll();
    P.host.resetInput();
    P.host.retakeSlot();
    const m = P.host.match;
    m.phase = 'LIVE'; m.setPiece = null; m.freezeUntil = 0;
    const human = m.players.find(p => p.id === P.host.humanId);
    m.players.forEach((p, i) => {
      p.setInstantPosition(-m.fieldHalfX + 2 + i * 1.5, m.fieldHalfZ * 0.6);
      p.kickTimer = 0; p.stunnedUntil = 0; p.feintUntil = 0;
      p.diveTimer = 0; p.feintReadyAt = 0; p.diveReadyAt = 0;
      p.ballContactReadyAt = 0; p.isInOffside = false;
      p.actionLockUntil = 0; p.pendingStrike = null; p.pendingDistribution = null;
      p.kickKind = null; p.actionImmediate = false; p.actionSeq = (p.actionSeq ?? 0) + 1;
    });
    human.setInstantPosition(0, 0, 0);
    m.ball.reset({ x: 0.5, y: 0.11, z: 0 });
    P.host.latestSnapshot = m.getSnapshot();
    P.host.prevSnapshot = P.host.latestSnapshot;
    return { m, human };
  };

  P.leaveMatch();
  document.getElementById('lobby-name').focus();
  key('keydown', 'x', 0); key('keyup', 'x', 500);
  assert('lobby typing does not create game actions', P.state.input.sample(0).shoot !== true);
  document.getElementById('lobby-name').blur();
  document.getElementById('btn-start').click();
  const tutorialPanel = document.getElementById('controls-panel');
  assert('first-match controls tutorial appears', !tutorialPanel.classList.contains('hidden'));
  assert('tutorial explains Arrow Classic keys', document.getElementById('ck-shoot').textContent === 'X' &&
    document.getElementById('ck-pass').textContent === 'SPACE');
  document.getElementById('btn-tutorial-close').click();
  assert('closing tutorial enables input', P.state.input.active);
  assert('Arrow Classic is the default scheme', P.state.input.scheme.id === 'arrows');
  assert('desktop legend uses Arrow scheme labels', document.getElementById('controls-hint').textContent.includes('X SHOOT'));
  assert('control mode defaults to PLAYER', document.getElementById('control-mode-select').value === 'player');
  assert('switch and call keys are explained', document.getElementById('ck-switch').textContent === 'F' &&
    document.getElementById('ck-call').textContent === 'G');
  const formationSelect = document.getElementById('formation-select');
  const tacticSelect = document.getElementById('tactic-select');
  assert('lobby exposes formation and mentality selectors', formationSelect.options.length >= 3 &&
    tacticSelect.options.length === 6 && formationSelect.value === '2-2-1');
  assert('lobby mini-pitch previews out and in shapes', document.querySelectorAll('#lobby-pitch .pitch-dot').length >= 6);
  assert('lobby plan title reflects the selected shape', document.getElementById('lobby-plan-title').textContent.includes('2-2-1') &&
    document.getElementById('lobby-plan-title').textContent.includes('BALANCED'));
  const originalFormation = formationSelect.value;
  formationSelect.value = '1-3-1'; formationSelect.dispatchEvent(new Event('change'));
  assert('lobby formation change updates the title and preview', document.getElementById('lobby-plan-title').textContent.includes('1-3-1') &&
    document.querySelectorAll('#lobby-pitch .pitch-dot').length >= 6);
  formationSelect.value = originalFormation; formationSelect.dispatchEvent(new Event('change'));

  let { m, human } = setup();
  assert('scaled match clock is active', P.snapshot.matchMinutes === 60 && P.snapshot.displayAdded === 0);
  let ballVerts = 0;
  P.state.matchView.ball.traverse((object) => {
    if (object.isMesh && object.geometry?.attributes?.position) ballVerts = Math.max(ballVerts, object.geometry.attributes.position.count);
  });
  assert(`high-detail ball mesh is loaded (${ballVerts} verts)`, ballVerts > 3000);
  assert('ball spin is exposed to the renderer',
    Number.isFinite(P.snapshot.ball.spinX) && Number.isFinite(P.snapshot.ball.spinY) && Number.isFinite(P.snapshot.ball.spinZ));
  const before = { ...human.pos };
  key('keydown', 'w', 1000); key('keydown', 'Shift', 1000);
  for (let i = 0; i < 120; i++) {
    P.host.receiveIntent(P.state.input.sample(1 / 60)); P.host.tick(1 / 60);
  }
  key('keyup', 'w', 3000); key('keyup', 'Shift', 3000);
  assert('keyboard movement survives 60Hz sampling', Math.hypot(human.pos.x - before.x, human.pos.z - before.z) > 2);
  assert('sprinting visibly drains stamina', human.stamina < 95);

  ({ m, human } = setup());
  const move = (worldX, speedScale = 1, ticks = 60) => {
    for (let i = 0; i < ticks; i++) {
      P.host.receiveIntent({ moveX: 0, moveZ: 1, worldX, worldZ: 0, speedScale, sprint: false });
      P.host.tick(1 / 30);
    }
  };
  move(1);
  const forwardX = human.pos.x;
  const forwardZ = human.pos.z;
  move(-1);
  assert('180-degree reversal does not orbit', human.pos.x < forwardX - 0.5 &&
    Math.abs(human.pos.z - forwardZ) < 0.12 &&
    Math.abs(Math.atan2(Math.sin(human.facing - Math.PI), Math.cos(human.facing - Math.PI))) < 0.45);
  const fullDistance = forwardX;

  ({ m, human } = setup());
  move(1, 0.5);
  assert(`analog stick magnitude scales movement speed (full=${fullDistance.toFixed(2)} half=${human.pos.x.toFixed(2)})`,
    Math.abs(human.pos.x) < Math.abs(fullDistance) * 0.62 &&
    Math.abs(human.pos.x) > Math.abs(fullDistance) * 0.3);

  ({ m, human } = setup());
  for (let i = 0; i < 6; i++) {
    P.host.receiveIntent({ moveX: 0, moveZ: 1, worldX: -1, worldZ: 0, speedScale: 0, sprint: false });
    P.host.tick(1 / 30);
  }
  assert('reversal from rest pivots before accelerating', Math.abs(human.pos.x) < 0.3 &&
    Math.abs(Math.atan2(Math.sin(human.facing - Math.PI), Math.cos(human.facing - Math.PI))) < 1.1);

  ({ m, human } = setup());
  m.players.filter((p) => p !== human).forEach((p) => p.setInstantPosition(30, 30, 0));
  human.setInstantPosition(-10, 0, 0);
  let locoSnap = null;
  for (let i = 0; i < 60; i++) {
    P.host.receiveIntent({ worldX: 1, worldZ: 0, speedScale: 1, sprint: true });
    P.host.tick(1 / 30);
    locoSnap = P.snapshot.players.find((p) => p.id === human.id);
  }
  assert('locomotion FSM reaches a sprint with a live gait phase',
    locoSnap.locoState === 'SPRINT' && locoSnap.locoPhase >= 0 && locoSnap.locoPhase < 1 &&
    (locoSnap.locoFoot === 'L' || locoSnap.locoFoot === 'R'));
  P.state.matchView.update(1 / 30, P.snapshot, human.id);
  const locoRig = P.state.matchView.rigs.get(human.id);
  assert('athlete rig exposes foot planting diagnostics', !!locoRig.footPlanting);
  const locoDuration = locoRig.current?.getClip()?.duration ?? 0;
  assert('gait clip is phase-locked to distance travelled',
    Math.abs(locoRig.current.time - locoSnap.locoPhase * locoDuration) < 0.02);
  let plantedFrames = 0, maxContactDrift = 0;
  const lastContact = new Map();
  for (let i = 0; i < 45; i++) {
    P.host.receiveIntent({ worldX: 1, worldZ: 0, speedScale: 1, sprint: true });
    P.host.tick(1 / 30);
    P.state.matchView.update(1 / 30, P.snapshot, human.id);
    for (const leg of locoRig.footPlanting.getDiagnostics()) {
      if (!leg.planted || !leg.contact) { lastContact.delete(leg.side); continue; }
      plantedFrames++;
      const previous = lastContact.get(leg.side);
      if (previous) maxContactDrift = Math.max(maxContactDrift, previous.distanceTo(leg.contact));
      lastContact.set(leg.side, leg.contact.clone());
    }
  }
  assert('sprint plants a foot on the turf', plantedFrames > 5);
  assert(`planted foot stays anchored while the body travels (drift=${maxContactDrift.toFixed(3)})`, maxContactDrift < 0.06);
  for (let i = 0; i < 30; i++) {
    P.host.receiveIntent({ moveX: 0, moveZ: 0 });
    P.host.tick(1 / 30);
  }
  locoSnap = P.snapshot.players.find((p) => p.id === human.id);
  assert('locomotion FSM settles back to IDLE after stopping', locoSnap.locoState === 'IDLE' && locoSnap.locoPhase === 0);

  ({ m, human } = setup());
  m.ball.hold(human);
  let dribbleTouches = 0;
  const dribbleOff = m.events.on('PlayerDribbleTouch', (ev) => { if (ev.player.id === human.id) dribbleTouches++; });
  let maxSep = 0, minSep = Infinity;
  for (let i = 0; i < 60; i++) {
    P.host.receiveIntent({ moveX: 0, moveZ: 1, worldX: 1, worldZ: 0, speedScale: 1, sprint: false });
    P.host.tick(1 / 30);
    const sep = Math.hypot(m.ball.pos.x - human.pos.x, m.ball.pos.z - human.pos.z);
    maxSep = Math.max(maxSep, sep);
    minSep = Math.min(minSep, sep);
  }
  assert('dribbling produces repeated touches', dribbleTouches >= 3);
  assert(`ball is not glued to the feet (max=${maxSep.toFixed(2)} min=${minSep.toFixed(2)})`,
    maxSep > 0.35 && maxSep < 2.5 && maxSep - minSep > 0.1);
  assert('normal dribbling keeps possession', m.ball.holder?.id === human.id);
  dribbleOff();

  ({ m, human } = setup());
  const shieldOpponent = m.players.find((p) => p.team === 1 && !p.isGoalKeeper);
  m.players.filter((p) => p.team === 1 && p !== shieldOpponent).forEach((p) => p.setInstantPosition(30, 30, 0));
  shieldOpponent.setInstantPosition(-0.85, 0, 0);
  shieldOpponent.tackleReadyAt = 1e9;
  human.setInstantPosition(0, 0, 0);
  m.ball.hold(human);
  m.ball.pos.x = 0.5; m.ball.pos.y = 0.11; m.ball.pos.z = 0;
  P.host.receiveIntent({ worldX: 1, worldZ: 0, speedScale: 0.4, closeControl: true });
  P.host.tick(1 / 30);
  assert('close control with a defender behind engages a shield', human.moveMode === 0 && human.shieldActive);
  assert('snapshot exposes shielding, side and balance',
    P.snapshot.players.find((p) => p.id === human.id).shielded === true &&
    Number.isFinite(P.snapshot.players.find((p) => p.id === human.id).balance));
  assert('shield carry mode is reported to the HUD', P.snapshot.players.find((p) => p.id === human.id).carryMode === 'SHIELD');

  ({ m, human } = setup());
  const duelOpponent = m.players.find((p) => p.team === 1 && !p.isGoalKeeper);
  m.players.filter((p) => p.team === 1 && p !== duelOpponent).forEach((p) => p.setInstantPosition(30, 30, 0));
  human.setInstantPosition(0, 0, 0);
  duelOpponent.setInstantPosition(0.85, 0, Math.PI);
  duelOpponent.vx = -2.6; duelOpponent.vz = 0; duelOpponent.speed = 2.6;
  human.vx = 2.6; human.vz = 0; human.speed = 2.6;
  m.separatePlayers(1 / 30);
  P.host.latestSnapshot = m.getSnapshot();
  assert('shoulder contact drains balance on both players',
    human.balance < 1 && duelOpponent.balance < 1);
  assert('snapshot exposes the contact lean',
    P.snapshot.players.find((p) => p.id === human.id).jostle > 0);

  ({ m, human } = setup());
  const stumbleCarrier = m.players.find((p) => p.team === 1 && !p.isGoalKeeper);
  m.players.filter((p) => p.team === 1 && p !== stumbleCarrier).forEach((p) => p.setInstantPosition(30, 30, 0));
  human.setInstantPosition(0, 0, 0);
  stumbleCarrier.setInstantPosition(-0.8, 0, 0);
  m.ball.hold(stumbleCarrier);
  m.ball.pos.x = -0.4; m.ball.pos.y = 0.11; m.ball.pos.z = 0;
  stumbleCarrier.balance = 0.1;
  human.vx = -3; human.vz = 0; human.speed = 3;
  let stumbleEvent = null;
  const stumbleOff = m.events.on('PlayerStumbled', (ev) => { stumbleEvent = ev; });
  m.separatePlayers(1 / 30);
  stumbleOff();
  assert('a stumble releases the ball and credits the duel winner',
    !!stumbleEvent && m.ball.holder === null && m.stats.duelsWon[0] === 1);

  ({ m, human } = setup());
  m.players.filter((p) => p !== human).forEach((p) => p.setInstantPosition(30, 30, 0));
  human.setInstantPosition(0, 0, 0);
  m.ball.hold(human);
  m.ball.pos.x = 0.4; m.ball.pos.y = 0.11; m.ball.pos.z = 0;
  P.state.input.resetAll(); P.host.resetInput();
  key('keydown', 'm', 9000);
  for (let i = 0; i < 6; i++) {
    const carryIntent = P.state.input.sample(1 / 30);
    P.host.receiveIntent({ ...carryIntent, worldX: 1, worldZ: 0, speedScale: 0.6 });
    P.host.tick(1 / 30);
  }
  let carrySnap = P.snapshot.players.find((p) => p.id === human.id);
  assert('M engages close control and the snapshot reports the carry mode',
    carrySnap.moveMode === 1 && carrySnap.carryMode === 'CLOSE');
  P.state.hud.update(P.snapshot, { carry: carrySnap.carryMode, stamina: carrySnap.stamina });
  assert('HUD renders the live carry mode chip',
    P.state.hud.el.carry && P.state.hud.el.carry.style.display !== 'none' &&
    P.state.hud.el.carry.textContent === 'CARRY · CLOSE');
  P.state.matchView.update(1 / 30, P.snapshot, human.id);
  const carryRig = P.state.matchView.rigs.get(human.id);
  assert('active-player ring tint reflects the carry mode',
    carryRig.ring.material.color.getHex() === 0x53e0ff);
  assert('dribble touches pulse the ball mesh',
    P.snapshot.ball.dribblePulse > 0 && P.state.matchView.ball.scale.x > 1);
  const rollStart = { x: human.pos.x, z: human.pos.z };
  let rolled = null;
  const rollOff = m.events.on('PlayerBallRoll', (ev) => { rolled = ev; });
  key('keydown', 'c', 9200); key('keyup', 'c', 9250);
  P.host.receiveIntent(P.state.input.sample(1 / 30));
  P.host.tick(1 / 30);
  rollOff();
  key('keyup', 'm', 9300);
  assert('C while close controlling performs a ball roll', !!rolled && human.skillKind === 'roll');
  for (let i = 0; i < 8; i++) {
    P.host.receiveIntent({ moveX: 0, moveZ: 0 });
    P.host.tick(1 / 30);
  }
  assert('ball roll carries the player and ball past the defender',
    Math.hypot(human.pos.x - rollStart.x, human.pos.z - rollStart.z) > 0.2 &&
    m.ball.holder?.id === human.id);

  ({ m, human } = setup());
  m.players.filter((p) => p !== human).forEach((p) => p.setInstantPosition(30, 30, 0));
  human.setInstantPosition(0, 0, 0);
  m.ball.hold(human);
  m.ball.pos.x = 0.4; m.ball.pos.y = 0.11; m.ball.pos.z = 0;
  P.state.input.resetAll(); P.host.resetInput();
  key('keydown', 'n', 9400);
  const faceIntent = P.state.input.sample(1 / 30);
  P.host.receiveIntent({ ...faceIntent, worldX: 0, worldZ: 1, speedScale: 0.5 });
  P.host.tick(1 / 30);
  key('keyup', 'n', 9450);
  assert('N engages face-up carry toward goal',
    P.snapshot.players.find((p) => p.id === human.id).carryMode === 'FACE-UP');
  assert('controls hint advertises the new carry keys',
    document.getElementById('controls-hint').textContent.includes('M CLOSE') &&
    document.getElementById('controls-hint').textContent.includes('N FACE-UP'));

  ({ m, human } = setup());
  m.ball.hold(human);
  P.state.matchView.update(1 / 30, P.host.latestSnapshot, P.host.humanId);
  const clipRig = P.state.matchView.rigs.get(human.id);
  assert(`football mocap action clips are loaded (${Object.keys(clipRig?.actions ?? {}).join(',')})`,
    ['pass', 'shot', 'penalty', 'dive', 'tackle', 'throwin', 'celebrate'].every((kind) => clipRig?.actions[kind]));
  let humanShots = 0;
  const off = m.events.on('PlayerShoot', ev => { if (ev.player.id === human.id) humanShots++; });
  key('keydown', 'x', 4000); key('keyup', 'x', 4500);
  const shotIntent = P.state.input.sample(1 / 144);
  assert('charge power survives browser key release', Math.abs(shotIntent.shootPower - 0.725) < 1e-8);
  P.host.receiveIntent(shotIntent);
  P.host.tick(1 / 30);
  P.state.matchView.update(1 / 30, P.host.latestSnapshot, P.host.humanId);
  assert('mocap shot clip plays on a strike', clipRig?.current?.getClip().name === 'shot');
  for (let i = 0; i < 13; i++) { P.host.tick(1 / 30); P.host.receiveIntent(P.state.input.sample(1 / 30)); }
  assert('one key release produces exactly one shot', humanShots === 1);
  off();

  ({ m, human } = setup());
  m.ball.hold(human);
  key('keydown', 'c', 5000); key('keyup', 'c', 5050);
  P.host.receiveIntent(P.state.input.sample(1 / 30)); P.host.tick(1 / 30);
  assert('C/L with possession creates a feint', m.time < human.feintUntil && human.animMode === 'FEINT');
  const feintZ = human.pos.z;
  P.host.receiveIntent({ moveX: 0, moveZ: 0 }); P.host.tick(1 / 30);
  assert('feint motion continues across ticks', human.pos.z > feintZ);

  ({ m, human } = setup());
  m.ball.pos.y = 1.8; m.ball.vel.y = -2;
  key('keydown', 'x', 6000); key('keyup', 'x', 6050);
  P.host.receiveIntent(P.state.input.sample(1 / 30)); P.host.tick(1 / 30);
  assert('shoot input can head an aerial ball', human.animMode === 'HEADER' && m.ball.lastTouch?.id === human.id);
  P.state.matchView.update(1 / 30, P.snapshot, human.id);
  assert('header selects an idle-backed procedural pose, not a kick clip', P.state.matchView.rigs.get(human.id).current?.getClip().name === 'Idle_Loop');

  const controlFrame = (name, mode, facing = 0, ballX = 0) => {
    ({ m, human } = setup());
    human.setInstantPosition(0, 0, facing);
    m.ball.reset({ x: ballX, y: 0.11, z: 0 });
    P.state.scene._pieceFocus = null;
    P.state.scene._forceCut = true;
    P.host.latestSnapshot = m.getSnapshot();
    P.host.prevSnapshot = P.host.latestSnapshot;
    P.state.scene.cameraMode = mode;
    for (let i = 0; i < 120; i++) P.state.scene.updateCamera(1 / 30, m.getSnapshot(), human.id);
    P.state.scene.camera.updateMatrixWorld();
    const project = (x, z) => {
      const v = P.state.scene.camera.position.clone().set(x, 0.2, z).project(P.state.scene.camera);
      return { x: v.x, y: v.y };
    };
    const measure = (moveX, moveZ) => {
      human.setInstantPosition(0, 0, facing);
      const dir = P.state.scene.movementDirection(moveX, moveZ, human.team);
      const start = project(human.pos.x, human.pos.z);
      for (let i = 0; i < 15; i++) {
        human.intent = { worldX: dir.x, worldZ: dir.z };
        m.applyHumanControl(human, 1 / 30);
      }
      human.intent = null;
      const end = project(human.pos.x, human.pos.z);
      return { dx: end.x - start.x, dy: end.y - start.y };
    };
    const up = measure(0, 1);
    const right = measure(1, 0);
    if (!(up.dy > 0.002)) throw new Error(`Stage 2 browser check failed: ${name} (${JSON.stringify(up)})`);
    if (!(right.dx > 0.002)) throw new Error(`Stage 2 browser check failed: ${name} (${JSON.stringify(right)})`);
    checks.push(name);
  };
  P.state.scene._pieceFocus = null;
  assert('ATTACK is the default camera', P.state.scene.cameraMode === 0 && P.state.scene.cameraLabel === 'CAM ATTACK');
  controlFrame('ATTACK camera maps Up/Right to screen directions', 0);
  controlFrame('FOLLOW facing attack maps Up/Right to screen directions', 1, 0);
  controlFrame('FOLLOW facing own goal maps Up/Right to screen directions', 1, Math.PI);
  controlFrame('WIDE camera maps Up/Right to screen directions', 2);
  controlFrame('GOAL camera at the own end maps Up/Right to screen directions', 3, 0, -10);
  controlFrame('GOAL camera at the far end maps Up/Right to screen directions', 3, 0, 10);
  controlFrame('BROADCAST camera maps Up/Right to screen directions', 4);
  P.state.scene.cameraMode = 0;

  P.leaveMatch();
  const controlModeSelect = document.getElementById('control-mode-select');
  assert('control mode menu offers PLAYER and TEAM', [...controlModeSelect.options].map((o) => o.value).join(',') === 'player,team');
  controlModeSelect.value = 'team'; controlModeSelect.dispatchEvent(new Event('change'));
  document.getElementById('btn-start').click();
  ({ m, human } = setup());
  m.phase = 'LIVE'; m.setPiece = null; m.freezeUntil = 0;
  const defender = m.teams[0].players[1];
  const opponentHolder = m.teams[1].players[5];
  for (const p of m.players) p.setInstantPosition(40, 25);
  human.setInstantPosition(30, 0);
  defender.setInstantPosition(0, 0);
  opponentHolder.setInstantPosition(0, 0);
  m.ball.hold(opponentHolder);
  assert('TEAM mode auto-switches to the nearest defender', P.host.autoSwitch() && P.host.humanId === defender.id);
  key('keydown', 'f', 9000); key('keyup', 'f', 9050);
  assert('F switches the active player in TEAM mode', P.host.humanId !== defender.id);
  key('keydown', 'g', 9200); key('keyup', 'g', 9250);
  assert('G calls for a pass', P.host.human.calledForPassUntil > m.time);
  P.leaveMatch();
  controlModeSelect.value = 'player'; controlModeSelect.dispatchEvent(new Event('change'));

  const roles = document.getElementById('role-select');
  assert('goalkeeper role is selectable', [...roles.options].some(o => o.value === 'GK'));
  roles.value = 'GK'; roles.dispatchEvent(new Event('change'));
  document.getElementById('btn-start').click();
  ({ m, human } = setup());
  human.setInstantPosition(-m.fieldHalfX + 4, 0, 0);
  m.ball.reset({ x: -m.fieldHalfX + 5.2, y: 0.7, z: 0.4 }); m.ball.vel = { x: -12, y: 0, z: 0 };
  key('keydown', 'c', 7000); key('keyup', 'c', 7050);
  P.host.receiveIntent(P.state.input.sample(1 / 30)); P.host.tick(1 / 30);
  assert('human GK input causes a dive or save', human.diveTimer > 0 || m.ball.holder?.id === human.id);
  for (let i = 0; i < 15 && !m.ball.holder; i++) P.host.tick(1 / 30);
  assert('soft shot is caught by the goalkeeper', m.ball.holder?.id === human.id && m.ball.heldInHands);
  assert('catch holds the ball above the turf', m.ball.pos.y > 1 && human.diveTimer === 0);
  P.state.matchView.update(1 / 30, P.snapshot, human.id);
  const rig = P.state.matchView.rigs.get(human.id);
  assert('keeper uses a stable hold pose', rig.current?.getClip().name === 'Idle_Loop' && human.animMode === 'GK_HOLD');
  assert('keeper possession FSM reports HOLD', human.gkState === 'HOLD' && P.snapshot.players.find(p => p.id === human.id).gkState === 'HOLD');
  const holdSnapshot = m.getSnapshot();

  key('keydown', ' ', 8000); key('keyup', ' ', 8250);
  P.host.receiveIntent(P.state.input.sample(1 / 30)); P.host.tick(1 / 30);
  assert('human GK holds the ball through the distribution wind-up',
    m.ball.heldInHands && m.ball.holder?.id === human.id && !!human.pendingDistribution);
  assert('keeper possession FSM reports DISTRIBUTE during the wind-up', human.gkState === 'DISTRIBUTE');
  for (let i = 0; i < 20; i++) {
    P.host.receiveIntent(P.state.input.sample(1 / 30)); P.host.tick(1 / 30);
  }
  assert('human GK can distribute with A/J', !m.ball.heldInHands && m.ball.lastTouch?.id === human.id);
  assert('keeper possession FSM leaves DISTRIBUTE after release', human.gkState === 'SET' || human.gkState === 'RECOVER');

  P.host.lastHumanInputTime = performance.now() / 1000 - 16;
  P.host.tick(0);
  assert('AFK takeover appears', P.host.coveredByBot && !document.getElementById('afk').classList.contains('hidden'));
  document.getElementById('btn-retake').click(); P.host.tick(0);
  assert('retake clears AFK without immediately retriggering', !P.host.coveredByBot && document.getElementById('afk').classList.contains('hidden'));

  human.isHuman = false;
  m.restart(0, { x: -m.fieldHalfX + 4, y: 0.11, z: 0 }, 'GOALKICK');
  let outfieldControls = 0, chain = 1, longestChain = 1, distributions = 0;
  const listeners = [
    m.events.on('PlayerControlBall', ev => { if (!ev.player.isGoalKeeper) { outfieldControls++; chain = 0; } }),
    m.events.on('PlayerTouchTheBall', ev => { if (!ev.player.isGoalKeeper) chain = 0; }),
    m.events.on('GoalKick', () => { chain++; longestChain = Math.max(longestChain, chain); }),
    m.events.on('GKDegage', ev => {
      distributions++;
      if (Math.abs(ev.target.x) >= m.fieldHalfX || Math.abs(ev.target.z) >= m.fieldHalfZ) throw new Error('Keeper targeted out of play');
    })
  ];
  for (let i = 0; i < 30 * 45; i++) P.host.tick(1 / 30);
  listeners.forEach(off => off());
  assert('keeper restart delivers in field to outfield play', distributions > 0 && outfieldControls > 0);
  assert('keepers do not loop through untouched goal kicks', longestChain < 3);

  P.state.matchView.update(1 / 30, P.snapshot, P.host.humanId);
  assert('referee rig is rendered with the match', P.state.matchView.referee &&
    P.state.matchView.referee.root.parent === P.state.matchView.group);
  const liveStats = m.getSnapshot().stats;
  assert('live snapshot exposes full match stats', liveStats.possession[0] + liveStats.possession[1] === 100 &&
    liveStats.shots.length === 2 && liveStats.passes.length === 2 && liveStats.cards.length === 2);
  assert('bench and substitution counters are exposed', P.snapshot.bench[0].length > 0 &&
    P.snapshot.substitutions[0].used === 0);

  P.leaveMatch();
  roles.value = 'FWD'; roles.dispatchEvent(new Event('change'));
  document.getElementById('btn-start').click();
  ({ m, human } = setup());
  document.getElementById('btn-tactics').click();
  assert('TACTICS panel opens and pauses the match', !document.getElementById('tactics-panel').classList.contains('hidden') && P.host.paused);
  assert('TACTICS lists every active player and formation', document.querySelectorAll('#tactics-roles .role-row').length ===
    m.teams[0].players.filter((p) => !p.sentOff).length && document.querySelectorAll('#tactics-formations .chip-btn').length >= 3);
  assert('TACTICS pitch renders the current phase', document.querySelectorAll('#tactics-pitch .pitch-dot').length >= m.cfg.teamSize);
  [...document.querySelectorAll('#tactics-formations .chip-btn')].find((b) => b.textContent === '1-3-1').click();
  assert('TACTICS draft updates without changing the match', m.teams[0].formationId === '2-2-1' && P.state.tacticsDraft.formationId === '1-3-1');
  document.getElementById('btn-tactics-apply').click();
  assert('live shape change queues for the next stoppage', m.teams[0].formationId === '2-2-1' &&
    m.pendingFormations[0]?.formationId === '1-3-1');
  m.setPiece = 'THROWIN';
  m.freezeUntil = m.time + 100;
  m.step(1 / 30);
  assert('queued formation applies at the stoppage', m.teams[0].formationId === '1-3-1');
  document.getElementById('btn-tactics').click();
  [...document.querySelectorAll('#tactics-tactics .tactic-btn')].find((b) => b.textContent.startsWith('HIGH PRESS')).click();
  document.getElementById('btn-tactics-apply').click();
  assert('mentality applies immediately without a stoppage', m.teams[0].tactic === 'HighPressure');

  m.phase = 'LIVE'; m.setPiece = null; m.freezeUntil = 0;
  m.setPiece = null;
  const fkGoal = m.teams[0].attackGoal;
  const fkShots = m.stats.shots[0];
  m.freeKick(0, { x: fkGoal.x - m.dirFor(0) * 25, y: 0.11, z: 0 }, 'FOUL', false);
  await wait(850);
  assert('free kick opens the interactive aim panel', !document.getElementById('setpiece-panel').classList.contains('hidden') && P.host.paused);
  assert('free kick panel exposes six zones and curve', document.querySelectorAll('#goal-zones button').length === 6 &&
    !document.getElementById('curve-wrap').classList.contains('hidden'));
  document.querySelector('#goal-zones button[data-z="1"][data-y="1"]').click();
  document.getElementById('btn-setpiece-strike').click();
  assert('free kick strike releases the ball and closes the panel', !P.state.setPieceOpen &&
    m.stats.shots[0] > fkShots && m.setPiece === null);

  m.setPiece = 'THROWIN';
  m.freezeUntil = m.time + 100;
  document.getElementById('btn-subs').click();
  assert('SUBS panel pauses the match at a stoppage', !document.getElementById('subs-panel').classList.contains('hidden') && P.host.paused);
  assert('SUBS panel lists every active field player', document.querySelectorAll('#subs-list .sub-row').length ===
    m.teams[0].players.filter((p) => !p.sentOff).length);
  const benchBefore = m.teams[0].bench.length;
  document.querySelectorAll('#subs-list .sub-row button')[1].click();
  assert('UI substitution uses the bench and a window', m.teams[0].subsUsed === 1 &&
    m.teams[0].subWindowsUsed === 1 && m.teams[0].bench.length === benchBefore - 1);
  const nonGKBench = m.teams[0].bench.find((p) => !p.isGoalKeeper);
  const humanBefore = P.host.humanId;
  const humanSub = P.host.requestSubstitution(P.host.humanId, nonGKBench.id);
  assert('human substitution transfers control to the incoming player', humanSub.ok &&
    P.host.humanId === nonGKBench.id && nonGKBench.isHuman && humanBefore !== nonGKBench.id);
  document.getElementById('btn-subs-close').click();
  assert('closing SUBS resumes play', !P.host.paused);

  const cardPlayer = m.teams[1].players[5];
  m.applyCard(cardPlayer, 'yellow', 'RECKLESS CHALLENGE');
  assert('yellow-card cutscene appears', !document.getElementById('card-cutscene').classList.contains('hidden') &&
    document.getElementById('card-shape').classList.contains('yellow'));
  assert('referee strip reports the card decision', document.getElementById('ref-message').textContent.includes('YELLOW'));

  m.phase = 'LIVE'; m.setPiece = null; m.freezeUntil = 0;
  m.awardPenalty(0, { x: 0, y: 0, z: 0 });
  assert('human penalty enters HUD-free in-world control', P.state.penaltyControl?.mode === 'taker' &&
    P.host.paused && document.getElementById('hud').classList.contains('penalty-cinema') &&
    document.getElementById('setpiece-panel').classList.contains('hidden'));
  const penaltyTaker = m.penalty?.taker;
  P.state.matchView.update(1 / 30, P.host.latestSnapshot, P.host.humanId);
  const takerRig = P.state.matchView.rigs.get(penaltyTaker?.id);
  const takerPoint = P.state.scene._desired.clone();
  if (takerRig) takerRig.root.getWorldPosition(takerPoint);
  assert('penalty taker faces the goal with a valid rig', Number.isFinite(penaltyTaker?.facing) &&
    !!takerRig && Number.isFinite(takerPoint.x) && Number.isFinite(takerPoint.z));
  key('keydown', 'arrowright', 5000);
  for (let i = 0; i < 14; i++) {
    P.penaltyTick(1 / 30);
    P.state.scene.updateCamera(1 / 30, P.host.latestSnapshot, P.host.humanId);
  }
  key('keyup', 'arrowright', 5200);
  key('keydown', 'x', 5300);
  for (let i = 0; i < 20; i++) P.penaltyTick(1 / 30);
  const penaltyAim = P.state.penaltyControl?.aimZ ?? 0;
  const penaltyFacing = m.penalty?.taker?.facing ?? 0;
  key('keyup', 'x', 5750);
  for (let i = 0; i < 5; i++) P.penaltyTick(1 / 30);
  assert('penalty keys aim and strike without a panel', Math.abs(penaltyAim) > 0.03 &&
    Number.isFinite(penaltyFacing) && penaltyFacing > 0 &&
    m.penalty?.taken === true && !P.state.penaltyControl && !P.host.paused &&
    !document.getElementById('hud').classList.contains('penalty-cinema'));

  m.penalty = null; m.setPiece = null; m.phase = 'LIVE'; m.freezeUntil = 0;
  m.awardPenalty(1, { x: 0, y: 0, z: 0 });
  assert('human keeper penalty is also HUD-free', P.state.penaltyControl?.mode === 'keeper' &&
    document.getElementById('hud').classList.contains('penalty-cinema'));
  key('keydown', 'c', 6500);
  for (let i = 0; i < 4; i++) P.penaltyTick(1 / 30);
  key('keyup', 'c', 6560);
  for (let i = 0; i < 4; i++) P.penaltyTick(1 / 30);
  assert('keyboard dive resolves the keeper penalty', m.penalty?.taken === true && !P.state.penaltyControl &&
    !document.getElementById('hud').classList.contains('penalty-cinema'));

  m.penalty = null; m.setPiece = null; m.phase = 'LIVE'; m.freezeUntil = 0;
  m.beginHalfTime();
  assert('half-time report pauses and shows stats', !document.getElementById('halftime-panel').classList.contains('hidden') &&
    P.host.paused && document.querySelectorAll('#ht-stats .ht-stat').length >= 8);
  document.getElementById('btn-ht-continue').click();
  assert('second half starts from the half-time report', m.half === 2 && m.phase === 'COUNTDOWN' &&
    document.getElementById('halftime-panel').classList.contains('hidden') && !P.host.paused);
  m.phase = 'LIVE'; m.setPiece = null; m.freezeUntil = 0;
  const secondHalfCornerGoal = m.teams[0].attackGoal.x;
  let secondHalfCorner = null;
  m.events.on('CornerTaken', (ev) => { secondHalfCorner = ev; });
  m.restart(0, { x: secondHalfCornerGoal, y: 0.11, z: m.fieldHalfZ }, 'CORNER');
  m.executeSetPiece();
  assert('second-half corners target the attacking goal', secondHalfCorner?.target.x < 0);
  m.phase = 'LIVE';
  m.half = 2;
  m.halfStoppage = 0;
  m.addedTime = [0, 0];
  m.setPiece = null;
  m.freezeUntil = 0;
  m.clockSec = m.cfg.durationSec - 1 / 60;
  P.host.tick(1 / 30);
  assert('full time renders results and disables input', m.phase === 'ENDED' && !P.state.input.active && !document.querySelector('[data-screen="results"]').classList.contains('hidden'));
  assert('full-time report includes match statistics', document.querySelectorAll('#res-stat-grid .ht-stat').length >= 8);
  document.getElementById('btn-lobby').click();
  assert('leave returns to lobby instead of an empty match view', !P.host && !document.querySelector('[data-screen="lobby"]').classList.contains('hidden'));

  document.getElementById('btn-start').click();
  ({ m, human } = setup());
  human.setInstantPosition(-m.fieldHalfX + 4, 0, 0);
  m.ball.reset({ x: -m.fieldHalfX + 4.5, y: 0.7, z: 0 }); m.ball.vel = { x: -8, y: 0, z: 0 };
  m.gkContact(human);
  P.host.latestSnapshot = m.getSnapshot(); P.host.prevSnapshot = P.host.latestSnapshot;
  P.state.scene.cameraMode = 1;
  P.state.matchView.update(1 / 30, P.snapshot, human.id);
  for (let i = 0; i < 80; i++) P.state.scene.updateCamera(1 / 30, P.snapshot, human.id);
  P.state.scene.render();
  return { checks, capturePlayerId: human.id, capturedBallHeight: holdSnapshot.ball.y };
}

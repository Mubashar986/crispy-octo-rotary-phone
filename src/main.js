import { SceneView, CAMERA_MODES } from './render/scene.js';
import { buildStadium } from './render/stadium.js';
import { MatchView } from './render/matchView.js';
import { loadBallMesh, loadAudioBuffers } from './render/assetLoader.js';
import { loadAthleteLibrary, AthleteFactory } from './render/athletes.js';
import { LocalMatchHost } from './net/loopback.js';
import { InputManager } from './input/InputManager.js';
import { SoundEngine } from './audio/SoundEngine.js';
import { Hud } from './ui/hud.js';
import { showScreen, Screens, currentScreen } from './ui/router.js';
import { profile, xpForLevel } from './state/profile.js';
import { MODE_CONFIGS, ROLE_LABELS } from './config/modes.js';
import { CONTROL_SCHEMES, SCHEME_LIST, DEFAULT_SCHEME } from './config/controls.js';
import {
  TACTIC_OPTIONS, getFormation, formationsForMode, cloneFormation, defaultFormationId,
  roleOptionsForMode, makePhaseAnchor
} from './config/formations.js';
import { TACTIC_PRESETS } from './engine/team.js';
import { roleDuties, defaultDuty, roleMeta } from './engine/roles.js';
import { randomSeed } from './core/rng.js';
import { clamp, lerp } from './core/math.js';

const $ = (id) => document.getElementById(id);
// rAF is throttled to zero in hidden tabs, which would stall boot forever;
// the timeout fallback lets the boot gate complete regardless of visibility.
const nextFrame = () => new Promise((r) => {
  let done = false;
  const fire = () => { if (!done) { done = true; r(); } };
  requestAnimationFrame(fire);
  setTimeout(fire, 60);
});

const state = {
  scene: null, stadium: null, matchView: null, host: null, input: null, hud: null,
  sfx: new SoundEngine(), modeId: 'classic5', role: 'FWD', controlMode: 'player', lastTs: 0, running: false,
  controlsOpen: false, subsOpen: false, subsQueued: false, halfTimeOpen: false, tacticsOpen: false,
  setPieceOpen: false, setPieceType: null, setPieceData: null, setPieceMode: 'taker',
  setPieceZone: { z: 0, y: 0 }, setPieceDive: 0, penaltyControl: null,
  tacticsPhase: 'out', tacticsDraft: null, exhaustedWarned: false,
  refTimer: 0, cardTimer: 0, setPieceTimer: 0,
  perf: { fps: 0, frames: 0, elapsed: 0 }
};

function setBoot(pct, label) {
  $('boot-bar').style.width = `${pct}%`;
  $('boot-status').textContent = label;
}

async function boot() {
  const params = new URLSearchParams(location.search);
  if (params.has('mode') && MODE_CONFIGS[params.get('mode')]) state.modeId = params.get('mode');
  showScreen(Screens.BOOT);
  setBoot(10, 'CREATING RENDERER…');
  await nextFrame();
  state.scene = new SceneView($('canvas-host'));
  state.hud = new Hud({
    homeScore: 'hud-home-score', awayScore: 'hud-away-score', clock: 'hud-clock', phase: 'hud-phase',
    streak: 'hud-streak', camMode: 'hud-cam', role: 'hud-role', shape: 'hud-shape', perf: 'hud-perf', stamina: 'hud-stamina', staminaFill: 'hud-stamina-fill', radar: 'radar', banner: 'banner', compass: 'hud-compass-arrow',
    carry: 'hud-carry',
    afk: 'afk', afkText: 'afk-text', toasts: 'toasts'
  });
  setBoot(35, 'BUILDING STADIUM…');
  await nextFrame();
  state.stadium = buildStadium(MODE_CONFIGS[state.modeId]);
  state.scene.scene.add(state.stadium.group);
  state.scene.onCameraLabel = (label) => state.hud.set('camMode', label);
  const savedQuality = profile.get().quality === 'LIGHT' ? 'LIGHT' : 'HIGH';
  state.scene.setQuality(savedQuality);
  state.stadium.setQuality(savedQuality);
  setBoot(55, 'LOADING EXTRACTED UNITY ASSETS…');
  await nextFrame();
  const [ballMesh, audioCount, athleteLibrary] = await Promise.all([
    loadBallMesh(), loadAudioBuffers(state.sfx), loadAthleteLibrary()
  ]);
  state.ballMesh = ballMesh;
  state.audioCount = audioCount;
  state.athletes = athleteLibrary ? new AthleteFactory(athleteLibrary) : null;
  setBoot(70, 'WIRING INPUT…');
  await nextFrame();
  state.input = new InputManager({
    joystickZone: $('joystick-zone'), joystickKnob: $('joystick-knob'),
    btnA: $('btn-act-A'), btnB: $('btn-act-B'), btnC: $('btn-act-C'), btnD: $('btn-act-D'), btnSprint: $('btn-sprint'),
    canvas: state.scene.renderer.domElement,
    scheme: profile.get().controlScheme ?? DEFAULT_SCHEME
  });
  state.input.onCameraCycle = () => state.scene.cycleCameraMode();
  state.input.onSwitch = () => {
    if (!state.host) return;
    if (state.controlMode !== 'team') { state.hud.toast('SWITCH IS TEAM MODE ONLY'); return; }
    if (!state.host.requestSwitch()) state.hud.toast('NO PLAYER TO SWITCH');
  };
  state.input.onCall = () => {
    if (!state.host) return;
    if (!state.host.requestCall()) state.hud.toast('CALL ON COOLDOWN');
  };
  applyControlScheme(state.input.scheme);
  if (!matchMedia('(pointer: coarse)').matches) $('touch-controls').classList.add('hidden');
  window.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') $('touch-controls').classList.remove('hidden');
  }, true);
  window.addEventListener('keydown', (e) => {
    if (currentScreen() !== Screens.MATCH) return;
    if (e.target?.closest?.('input, textarea, select')) return;
    const key = e.key.toLowerCase();
    if (key === 'h') {
      if (state.setPieceOpen) return;
      if (state.tacticsOpen) closeTacticsPanel();
      toggleControlsPanel();
    } else if (key === 'b') toggleSubsPanel();
    else if (key === 't') toggleTacticsPanel();
    else if (key === 'escape') {
      if (state.setPieceOpen) cancelSetPiece();
      else if (state.tacticsOpen) closeTacticsPanel();
      else if (state.subsOpen) closeSubsPanel();
      else if (state.controlsOpen) setControlsVisible(false);
    }
  });
  window.addEventListener('resize', () => state.scene.resize());
  window.addEventListener('blur', () => state.host?.resetInput());
  document.addEventListener('visibilitychange', () => { if (document.hidden) state.host?.resetInput(); });
  setBoot(100, 'READY');
  await nextFrame();
  buildLobby();
  showScreen(Screens.LOBBY);
  state.scene.resetLobbyCamera();
  if (params.has('quality')) {
    const tier = params.get('quality').toLowerCase() === 'light' ? 'LIGHT' : 'HIGH';
    state.scene.setQuality(tier);
    state.stadium.setQuality(tier);
    $('btn-quality').textContent = tier === 'HIGH' ? 'HIGH' : 'LITE';
  }
  if (params.has('autostart')) startMatch();
  if (params.has('cam')) {
    state.scene.cameraMode = Math.max(0, Math.min(CAMERA_MODES.length - 1, Number(params.get('cam')) || 0));
    state.hud.set('camMode', `CAM ${CAMERA_MODES[state.scene.cameraMode]}`);
  }
  requestAnimationFrame(loop);
}

function setControlsVisible(visible) {
  $('controls-panel').classList.toggle('hidden', !visible);
  state.controlsOpen = visible;
  if (currentScreen() === Screens.MATCH && state.input) {
    state.input.setActive(!visible && !state.subsOpen && !state.halfTimeOpen && !state.tacticsOpen && !state.setPieceOpen);
  }
  if (!visible && state.host) state.host.lastHumanInputTime = performance.now() / 1000;
}

function toggleControlsPanel() {
  const opening = $('controls-panel').classList.contains('hidden');
  if (opening) profile.update({ controlsTutorialSeen: true });
  setControlsVisible(opening);
}

function applyControlScheme(scheme) {
  document.querySelectorAll('[data-key]').forEach((el) => { el.textContent = scheme.labels[el.dataset.key]; });
  $('controls-scheme-name').textContent = scheme.name.toUpperCase();
  $('ck-move').textContent = scheme.movementLabel;
  for (const action of ['sprint', 'pass', 'shoot', 'skill', 'through', 'switch', 'call', 'camera', 'closeControl', 'faceUp']) $('ck-' + action).textContent = scheme.labels[action];
  updateControlsHint(scheme);
}

function updateControlsHint(scheme = state.input?.scheme ?? CONTROL_SCHEMES[DEFAULT_SCHEME]) {
  const mode = state.controlMode ?? 'player';
  const action = mode === 'team'
    ? `${scheme.labels.switch} SWITCH • ${scheme.labels.call} CALL`
    : `${scheme.labels.call} CALL`;
  $('controls-hint').textContent =
    `${scheme.movementLabel} MOVE ON SCREEN • ${scheme.labels.sprint} SPRINT • ${scheme.labels.pass} PASS • ${scheme.labels.shoot} SHOOT • ${scheme.labels.skill} FEINT/SLIDE • ${scheme.labels.closeControl} CLOSE • ${scheme.labels.faceUp} FACE-UP • ${scheme.labels.through} THROUGH • ${action} • ${scheme.labels.camera} CAM • H KEYS`;
}

function tacticLabel(id) {
  return TACTIC_OPTIONS.find((t) => t.id === id)?.label ?? id;
}

function gamePlanFor(modeId) {
  const saved = profile.get().gamePlans?.[modeId] ?? {};
  const formation = formationsForMode(modeId).some((f) => f.id === saved.formation)
    ? saved.formation : defaultFormationId(modeId);
  const tactic = TACTIC_OPTIONS.some((t) => t.id === saved.tactic) ? saved.tactic : 'Balanced';
  return { formation, tactic };
}

function saveGamePlan(modeId, patch) {
  const plans = { ...(profile.get().gamePlans ?? {}) };
  plans[modeId] = { ...gamePlanFor(modeId), ...patch };
  profile.update({ gamePlans: plans });
}

function selectedLobbyFormation() {
  const plan = gamePlanFor(state.modeId);
  return getFormation(state.modeId, plan.formation) ?? getFormation(state.modeId, defaultFormationId(state.modeId));
}

function renderPitch(container, formation, phase = 'out', players = null, options = {}) {
  if (!container || !formation) return;
  container.innerHTML = '';
  const both = options.both === true;
  formation.slots.forEach((slot, i) => {
    const phases = both ? ['out', 'in'] : [phase];
    for (const mode of phases) {
      if (both && mode === 'in' && slot.role === 'GK') continue;
      const anchor = mode === 'in' ? makePhaseAnchor(slot) : { h: slot.h, v: slot.v };
      const player = players?.find((p) => p.slotIndex === i && !p.sentOff);
      const dot = document.createElement('div');
      const group = roleMeta(slot.role).group.toLowerCase();
      dot.className = `pitch-dot ${group}${mode === 'in' ? ' in' : ''}`;
      dot.style.left = `${anchor.v * 100}%`;
      dot.style.top = `${anchor.h * 100}%`;
      dot.title = `${player?.name ?? ROLE_LABELS[slot.role] ?? slot.role} · ${mode === 'in' ? 'IN' : 'OUT'} · ${slot.duty}`;
      dot.textContent = both && mode === 'in' ? '' : (player?.name ?? roleMeta(slot.role).short);
      if (!both && options.humanSlot === i) dot.classList.add('human');
      container.appendChild(dot);
    }
  });
}

function rebuildGamePlanOptions() {
  const plan = gamePlanFor(state.modeId);
  const formationSelect = $('formation-select');
  const tacticSelect = $('tactic-select');
  formationSelect.innerHTML = '';
  for (const formation of formationsForMode(state.modeId)) {
    const option = document.createElement('option');
    option.value = formation.id;
    option.textContent = `${formation.name} — ${formation.description}`;
    formationSelect.appendChild(option);
  }
  tacticSelect.innerHTML = '';
  for (const tactic of TACTIC_OPTIONS) {
    const option = document.createElement('option');
    option.value = tactic.id;
    option.textContent = tactic.label;
    tacticSelect.appendChild(option);
  }
  formationSelect.value = plan.formation;
  tacticSelect.value = plan.tactic;
}

function renderLobbyGamePlan() {
  const plan = gamePlanFor(state.modeId);
  const formation = selectedLobbyFormation();
  if (!formation) return;
  $('lobby-plan-title').textContent = `${formation.name} · ${tacticLabel(plan.tactic)}`;
  renderPitch($('lobby-pitch'), formation, 'out', null, { both: true });
}

function buildLobby() {
  const p = profile.get();
  $('lobby-name').value = p.name;
  const schemeSelect = $('control-scheme-select');
  schemeSelect.innerHTML = '';
  for (const scheme of SCHEME_LIST) {
    const option = document.createElement('option');
    option.value = scheme.id;
    option.textContent = `${scheme.name} — ${scheme.movementLabel}`;
    schemeSelect.appendChild(option);
  }
  schemeSelect.value = p.controlScheme ?? DEFAULT_SCHEME;
  schemeSelect.onchange = () => {
    const scheme = state.input.setScheme(schemeSelect.value);
    profile.update({ controlScheme: scheme.id });
    applyControlScheme(scheme);
  };
  state.controlMode = profile.get().controlMode === 'team' ? 'team' : 'player';
  const controlModeSelect = $('control-mode-select');
  controlModeSelect.value = state.controlMode;
  controlModeSelect.onchange = () => {
    state.controlMode = controlModeSelect.value === 'team' ? 'team' : 'player';
    profile.update({ controlMode: state.controlMode });
    updateControlsHint();
  };
  updateControlsHint();
  $('lobby-name').addEventListener('change', (e) => profile.update({ name: e.target.value.toUpperCase() || 'STRIKER' }));
  const formationSelect = $('formation-select');
  formationSelect.onchange = () => {
    saveGamePlan(state.modeId, { formation: formationSelect.value });
    rebuildRoleSelect();
    renderLobbyGamePlan();
  };
  const tacticSelect = $('tactic-select');
  tacticSelect.onchange = () => {
    saveGamePlan(state.modeId, { tactic: tacticSelect.value });
    renderLobbyGamePlan();
  };
  const cards = $('mode-cards');
  cards.innerHTML = '';
  for (const cfg of Object.values(MODE_CONFIGS)) {
    const b = document.createElement('button');
    b.textContent = cfg.name;
    b.dataset.mode = cfg.id;
    b.classList.toggle('sel', cfg.id === state.modeId);
    b.addEventListener('click', () => {
      state.modeId = cfg.id;
      profile.update({ selectedMode: cfg.id });
      for (const c of cards.children) c.classList.toggle('sel', c.dataset.mode === cfg.id);
      rebuildGamePlanOptions();
      rebuildRoleSelect();
      renderLobbyGamePlan();
    });
    cards.appendChild(b);
  }
  rebuildGamePlanOptions();
  rebuildRoleSelect();
  renderLobbyGamePlan();
  $('ai-select').value = '2';
  $('btn-start').addEventListener('click', () => startMatch());
  $('btn-sound-lobby').addEventListener('click', (e) => {
    state.sfx.init();
    const on = state.sfx.toggle();
    e.target.textContent = `SOUND: ${on ? 'ON' : 'OFF'}`;
    profile.update({ soundOn: on });
  });
  $('btn-cam').addEventListener('click', () => state.input.onCameraCycle());
  $('btn-tactics').addEventListener('click', () => toggleTacticsPanel());
  $('btn-tactics-close').addEventListener('click', () => closeTacticsPanel());
  $('btn-tactics-apply').addEventListener('click', () => applyTacticsDraft());
  $('tactics-phase').addEventListener('click', (e) => {
    const button = e.target.closest('button[data-phase]');
    if (!button) return;
    state.tacticsPhase = button.dataset.phase === 'in' ? 'in' : 'out';
    for (const b of $('tactics-phase').querySelectorAll('button')) b.classList.toggle('sel', b === button);
    renderTacticsPitch();
  });
  $('btn-setpiece-cancel').addEventListener('click', cancelSetPiece);
  $('btn-setpiece-strike').addEventListener('click', strikeSetPiece);
  $('dive-grid').addEventListener('click', (e) => {
    const button = e.target.closest('button[data-dive]');
    if (!button) return;
    for (const b of $('dive-grid').querySelectorAll('button')) b.classList.toggle('sel', b === button);
    divePenalty(Number(button.dataset.dive));
  });
  $('btn-subs').addEventListener('click', () => toggleSubsPanel());
  $('btn-subs-close').addEventListener('click', () => closeSubsPanel());
  $('btn-ht-subs').addEventListener('click', () => openSubsPanel());
  $('btn-ht-continue').addEventListener('click', () => continueSecondHalf());
  $('btn-keys').addEventListener('click', () => toggleControlsPanel());
  $('btn-tutorial-close').addEventListener('click', () => setControlsVisible(false));
  $('btn-quality').addEventListener('click', () => {
    const tier = state.scene.quality === 'HIGH' ? 'LIGHT' : 'HIGH';
    state.scene.setQuality(tier);
    state.stadium.setQuality(tier);
    $('btn-quality').textContent = tier === 'HIGH' ? 'HIGH' : 'LITE';
    profile.update({ quality: tier });
    $('btn-quality').textContent = tier === 'HIGH' ? 'HIGH' : 'LITE';
  });
  $('btn-quality').textContent = state.scene.quality === 'HIGH' ? 'HIGH' : 'LITE';
  $('btn-sound').addEventListener('click', () => { state.sfx.init(); state.sfx.toggle(); });
  $('btn-leave').addEventListener('click', () => leaveMatch());
  $('btn-retake').addEventListener('click', () => state.host?.retakeSlot());
  $('btn-again').addEventListener('click', () => startMatch());
  $('btn-lobby').addEventListener('click', () => { leaveMatch(); showScreen(Screens.LOBBY); });
}

function rebuildRoleSelect() {
  const sel = $('role-select');
  const formation = selectedLobbyFormation();
  const roles = formation ? [...new Set(formation.slots.map((s) => s.role))] : MODE_CONFIGS[state.modeId].roles;
  sel.innerHTML = '';
  for (const r of roles) {
    const o = document.createElement('option');
    o.value = r; o.textContent = ROLE_LABELS[r] ?? r;
    sel.appendChild(o);
  }
  if (!roles.includes(state.role)) {
    const legacy = { FWD: 'ST', MID: 'CM', DEF: 'CB', ST: 'FWD', CB: 'DEF', FB: 'DEF', WB: 'DEF', DM: 'MID', CM: 'MID', AM: 'MID', W: 'FWD' };
    const direct = legacy[state.role];
    if (direct && roles.includes(direct)) state.role = direct;
    else {
      const group = roleMeta(state.role).group;
      state.role = roles.find((r) => r !== 'GK' && roleMeta(r).group === group) ??
        roles.find((r) => r !== 'GK') ?? roles[0] ?? 'FWD';
    }
  }
  sel.value = state.role;
  sel.onchange = () => {
    state.role = sel.value;
    profile.update({ selectedRole: state.role });
    renderLobbyGamePlan();
  };
}

function startMatch() {
  leaveMatch(true);
  state.subsOpen = false;
  state.subsQueued = false;
  state.halfTimeOpen = false;
  state.tacticsOpen = false;
  state.setPieceOpen = false;
  state.tacticsDraft = null;
  state.setPieceType = null;
  clearTimeout(state.setPieceTimer);
  $('subs-panel').classList.add('hidden');
  $('halftime-panel').classList.add('hidden');
  $('tactics-panel').classList.add('hidden');
  $('setpiece-panel').classList.add('hidden');
  $('card-cutscene').classList.add('hidden');
  $('ref-strip').classList.add('hidden');
  const cfg = MODE_CONFIGS[state.modeId];
  const plan = gamePlanFor(state.modeId);
  const formation = getFormation(state.modeId, plan.formation) ?? getFormation(state.modeId, defaultFormationId(state.modeId));
  const selectedSlot = formation?.slots.findIndex((s) => s.role === state.role) ?? -1;
  const firstOutfield = formation?.slots.findIndex((s, i) => i > 0 && s.role !== 'GK') ?? 1;
  const humanSlot = selectedSlot >= 0 ? selectedSlot : firstOutfield;
  state.controlMode = $('control-mode-select').value === 'team' ? 'team' : 'player';
  profile.update({ controlMode: state.controlMode });
  const aiFormation = defaultFormationId(state.modeId) ?? plan.formation;
  state.host = new LocalMatchHost(cfg, {
    humanSlot: humanSlot < 0 ? 1 : humanSlot,
    aiLevel: +$('ai-select').value,
    seed: randomSeed(),
    controlMode: state.controlMode,
    teamOpts: [
      { formation: plan.formation, tactic: plan.tactic },
      { formation: aiFormation, tactic: 'Balanced' }
    ]
  });
  state.matchView = new MatchView(state.scene, cfg, state.ballMesh, state.athletes);
  state.scene.cameraMode = profile.get().cameraMode;
  state.hud.set('camMode', `CAM ${CAMERA_MODES[state.scene.cameraMode]}`);
  state.hud.set('role', `${state.controlMode === 'team' ? 'TEAM' : 'PLAYER'} • ${ROLE_LABELS[state.role]}`);
  state.hud.cache = {};
  state.exhaustedWarned = false;
  updateControlsHint();
  wireMatchEvents();
  state.sfx.init();
  state.sfx.startCrowd();
  state.sfx.ctx?.resume();
  showScreen(Screens.MATCH);
  state.input.setActive(true);
  state.hud.setAfk(false);
  state.hud.showBanner('KICK-OFF', 'HOME TO START', 1800);
  setRefMessage('KICK-OFF', 1600);
  state.scene.focusSetPiece('KICKOFF', 2.4);
  if (!profile.get().controlsTutorialSeen) setControlsVisible(true);
  else setControlsVisible(false);
}

function leaveMatch(silent = false) {
  if (state.penaltyControl) endPenaltyControl();
  setControlsVisible(false);
  state.subsOpen = false;
  state.subsQueued = false;
  state.halfTimeOpen = false;
  state.tacticsOpen = false;
  state.setPieceOpen = false;
  state.tacticsDraft = null;
  state.setPieceType = null;
  $('subs-panel')?.classList.add('hidden');
  $('halftime-panel')?.classList.add('hidden');
  $('tactics-panel')?.classList.add('hidden');
  $('setpiece-panel')?.classList.add('hidden');
  $('card-cutscene')?.classList.add('hidden');
  $('ref-strip')?.classList.add('hidden');
  clearTimeout(state.refTimer);
  clearTimeout(state.cardTimer);
  clearTimeout(state.setPieceTimer);
  state.input?.setActive(false);
  state.matchView?.dispose();
  state.matchView = null;
  state.host?.dispose();
  state.host = null;
  state.exhaustedWarned = false;
  state.hud?.setAfk(false);
  if (!silent) {
    state.sfx.setCrowdLevel(0);
    showScreen(Screens.LOBBY);
    state.scene.resetLobbyCamera();
  }
}

function setRefMessage(text, ms = 2200) {
  const strip = $('ref-strip');
  $('ref-message').textContent = text;
  strip.classList.remove('hidden');
  clearTimeout(state.refTimer);
  state.refTimer = setTimeout(() => strip.classList.add('hidden'), ms);
}

function displayName(id) {
  if (!state.host) return id;
  const p = state.host.match.players.find((q) => q.id === id) ??
    state.host.match.teams.flatMap((t) => t.bench).find((q) => q.id === id);
  return p?.name ?? id;
}

function showCardCutscene(ev) {
  const shape = $('card-shape');
  shape.className = `card-shape ${ev.card === 'red' ? 'red' : 'yellow'}`;
  $('card-player').textContent = `${ev.player?.name ?? 'PLAYER'} · ${ev.card === 'red' ? 'RED' : 'YELLOW'} CARD`;
  $('card-reason').textContent = ev.reason || 'OFFENCE';
  $('card-cutscene').classList.remove('hidden');
  clearTimeout(state.cardTimer);
  state.cardTimer = setTimeout(() => $('card-cutscene').classList.add('hidden'), 2600);
}

function openSubsPanel() {
  if (!state.host || state.setPieceOpen) return;
  if (state.controlsOpen) setControlsVisible(false);
  if (state.tacticsOpen) closeTacticsPanel();
  if (!state.host.match.isDeadBall()) {
    state.subsQueued = true;
    state.hud.toast('SUBS WILL OPEN AT THE NEXT STOPPAGE');
    return;
  }
  state.subsQueued = false;
  state.subsOpen = true;
  state.host.setPaused(true);
  state.input.setActive(false);
  renderSubsPanel();
  $('subs-panel').classList.remove('hidden');
}

function closeSubsPanel() {
  state.subsOpen = false;
  $('subs-panel').classList.add('hidden');
  if (!state.halfTimeOpen && !state.tacticsOpen) {
    state.host?.setPaused(false);
    if (!state.controlsOpen) state.input.setActive(true);
  }
}

function toggleSubsPanel() {
  if (state.subsOpen) closeSubsPanel();
  else openSubsPanel();
}

function openTacticsPanel() {
  if (!state.host || state.setPieceOpen) return;
  if (state.controlsOpen) setControlsVisible(false);
  if (state.subsOpen) closeSubsPanel();
  if (state.tacticsOpen) return;
  const teamId = state.host.human?.team ?? state.host.match.players.find((p) => p.team === 0)?.team ?? 0;
  const team = state.host.match.teams[teamId];
  const current = team.formation ?? getFormation(state.modeId, defaultFormationId(state.modeId));
  if (!current) return;
  const copy = cloneFormation(current);
  state.tacticsDraft = {
    formationId: copy.id,
    name: copy.name,
    slots: copy.slots.map((s) => ({ ...s })),
    tactic: team.tactic
  };
  state.tacticsPhase = 'out';
  for (const button of $('tactics-phase').querySelectorAll('button')) {
    button.classList.toggle('sel', button.dataset.phase === 'out');
  }
  state.tacticsOpen = true;
  state.host.setPaused(true);
  state.input.setActive(false);
  renderTacticsPanel();
  $('tactics-panel').classList.remove('hidden');
}

function closeTacticsPanel() {
  if (!state.tacticsOpen) return;
  state.tacticsOpen = false;
  state.tacticsDraft = null;
  $('tactics-panel').classList.add('hidden');
  if (!state.halfTimeOpen && !state.subsOpen && !state.controlsOpen) {
    state.host?.setPaused(false);
    state.input.setActive(true);
  }
}

function toggleTacticsPanel() {
  if (state.tacticsOpen) closeTacticsPanel();
  else openTacticsPanel();
}

function renderTacticsPitch() {
  const draft = state.tacticsDraft;
  if (!draft || !state.host) return;
  const base = getFormation(state.modeId, draft.formationId);
  if (!base) return;
  const formation = { ...base, slots: draft.slots };
  renderPitch($('tactics-pitch'), formation, state.tacticsPhase, state.host.match.players, {
    humanSlot: state.host.human?.slotIndex
  });
  $('tactics-phase-note').textContent = state.tacticsPhase === 'in'
    ? 'IN POSSESSION · DUTY-DRIVEN SHAPE'
    : 'OUT OF POSSESSION · BASE SHAPE';
}

function renderTacticsPanel() {
  const draft = state.tacticsDraft;
  if (!draft || !state.host) return;
  const teamId = state.host.human?.team ?? state.host.match.players.find((p) => p.team === 0)?.team ?? 0;
  const team = state.host.match.teams[teamId];
  $('tactics-meta').textContent = `${draft.name} · ${tacticLabel(draft.tactic)}`;

  const formations = $('tactics-formations');
  formations.innerHTML = '';
  for (const formation of formationsForMode(state.modeId)) {
    const button = document.createElement('button');
    button.className = `chip-btn${formation.id === draft.formationId ? ' sel' : ''}`;
    button.textContent = formation.name;
    button.title = formation.description;
    button.addEventListener('click', () => {
      draft.formationId = formation.id;
      draft.name = formation.name;
      draft.slots = formation.slots.map((s) => ({ ...s }));
      renderTacticsPanel();
    });
    formations.appendChild(button);
  }

  const tacticWrap = $('tactics-tactics');
  tacticWrap.innerHTML = '';
  for (const tactic of TACTIC_OPTIONS) {
    const button = document.createElement('button');
    button.className = `tactic-btn${tactic.id === draft.tactic ? ' sel' : ''}`;
    button.textContent = tactic.label;
    const small = document.createElement('small');
    small.textContent = tactic.description;
    button.appendChild(small);
    button.addEventListener('click', () => {
      draft.tactic = tactic.id;
      renderTacticsPanel();
    });
    tacticWrap.appendChild(button);
  }

  const roles = $('tactics-roles');
  roles.innerHTML = '';
  const active = state.host.match.players
    .filter((p) => p.team === teamId && !p.sentOff && p.slotIndex != null)
    .sort((a, b) => a.slotIndex - b.slotIndex);
  for (const player of active) {
    const index = player.slotIndex;
    const slot = draft.slots[index];
    if (!slot) continue;
    const row = document.createElement('div');
    row.className = 'role-row';
    const name = document.createElement('div');
    name.className = 'nm';
    name.textContent = `${player.name}${player.isHuman ? ' ★' : ''}`;
    const roleSelect = document.createElement('select');
    const roleChoices = slot.role === 'GK' ? ['GK'] : roleOptionsForMode(state.modeId, false);
    for (const role of roleChoices) {
      const option = document.createElement('option');
      option.value = role;
      option.textContent = roleMeta(role).short;
      roleSelect.appendChild(option);
    }
    roleSelect.value = slot.role;
    roleSelect.disabled = slot.role === 'GK';
    roleSelect.addEventListener('change', () => {
      slot.role = roleSelect.value;
      slot.duty = defaultDuty(slot.role);
      renderTacticsPanel();
    });
    const dutySelect = document.createElement('select');
    for (const duty of roleDuties(slot.role)) {
      const option = document.createElement('option');
      option.value = duty;
      option.textContent = duty.toUpperCase();
      dutySelect.appendChild(option);
    }
    dutySelect.value = slot.duty;
    dutySelect.disabled = roleDuties(slot.role).length <= 1;
    dutySelect.addEventListener('change', () => {
      slot.duty = dutySelect.value;
      renderTacticsPitch();
      updateTacticsState();
    });
    row.append(name, roleSelect, dutySelect);
    roles.appendChild(row);
  }

  const preset = TACTIC_PRESETS[draft.tactic] ?? TACTIC_PRESETS.Balanced;
  const summary = $('tactics-tactic-summary');
  summary.innerHTML = '';
  const values = [
    ['MENTALITY', preset.DefenceAttackSlider, 0.18, 0.80],
    ['WIDTH', preset.width, 0.74, 1.04],
    ['DEPTH', preset.depth, 0.78, 1.06],
    ['PRESS', preset.press, 0.30, 0.90],
    ['LINE', preset.lineHeight, 0.30, 0.66]
  ];
  for (const [label, value, min, max] of values) {
    const row = document.createElement('div');
    row.className = 'tactic-bar';
    const caption = document.createElement('span');
    caption.textContent = label;
    const track = document.createElement('i');
    track.style.width = `${Math.round(((value - min) / (max - min)) * 100)}%`;
    row.append(caption, track);
    summary.appendChild(row);
  }

  renderTacticsPitch();
  updateTacticsState(team);
}

function updateTacticsState(team = null) {
  const draft = state.tacticsDraft;
  if (!draft || !state.host) return;
  const current = team ?? state.host.match.teams[state.host.human?.team ?? 0];
  const changedFormation = draft.formationId !== current.formationId;
  const changedRoles = draft.slots.some((s, i) => {
    const c = current.formation?.slots?.[i];
    return !c || c.role !== s.role || c.duty !== s.duty;
  });
  const changedTactic = draft.tactic !== current.tactic;
  const shapeNow = state.host.match.isDeadBall();
  const shapeText = !(changedFormation || changedRoles) ? 'UNCHANGED'
    : shapeNow ? 'APPLIES NOW' : 'NEXT STOPPAGE';
  $('tactics-state').innerHTML = `SHAPE: <b>${shapeText}</b> · MENTALITY: <b>${changedTactic ? 'LIVE' : 'UNCHANGED'}</b>`;
}

function applyTacticsDraft() {
  const draft = state.tacticsDraft;
  if (!draft || !state.host) return;
  const teamId = state.host.human?.team ?? state.host.match.players.find((p) => p.team === 0)?.team ?? 0;
  const team = state.host.match.teams[teamId];
  const changedFormation = draft.formationId !== team.formationId;
  const changedRoles = draft.slots.some((s, i) => {
    const c = team.formation?.slots?.[i];
    return !c || c.role !== s.role || c.duty !== s.duty;
  });
  let shape = { applied: true, pending: false };
  if (changedFormation || changedRoles) {
    shape = state.host.requestFormation(draft.formationId, draft.slots.map((s) => ({ role: s.role, duty: s.duty })));
  }
  if (draft.tactic !== team.tactic) state.host.requestTactic(draft.tactic);
  if (!shape.ok) {
    state.hud.toast(`TACTICS FAILED · ${shape.reason ?? 'UNKNOWN'}`);
    return;
  }
  closeTacticsPanel();
  if (shape.pending) state.hud.toast('GAME PLAN QUEUED · NEXT STOPPAGE');
}

function setPieceText(kind, mode, data) {
  const sub = $('setpiece-sub');
  if (kind === 'freeKick') {
    sub.textContent = `${Math.round(data.distance ?? 0)}M · WALL 9.15M`;
    $('setpiece-note').textContent = 'AIM OVER OR AROUND THE WALL · CURVE WITH THE SLIDER';
  } else if (mode === 'keeper') {
    sub.textContent = 'READ THE TAKER';
    $('setpiece-note').textContent = 'PICK YOUR DIVE';
  } else {
    sub.textContent = 'CHOOSE YOUR CORNER';
    $('setpiece-note').textContent = 'POWER 65–85% IS SAFEST';
  }
}

function renderSetPieceZones() {
  const wrap = $('goal-zones');
  wrap.innerHTML = '';
  const labels = { '1': 'HIGH', '0': 'LOW' };
  for (const y of [1, 0]) {
    for (const z of [-1, 0, 1]) {
      const button = document.createElement('button');
      button.dataset.z = String(z);
      button.dataset.y = String(y);
      button.textContent = `${labels[String(y)]} ${z === 0 ? 'CENTRE' : z < 0 ? 'LEFT' : 'RIGHT'}`;
      button.classList.toggle('sel', state.setPieceZone.z === z && state.setPieceZone.y === y);
      button.addEventListener('click', () => {
        state.setPieceZone = { z, y };
        for (const b of wrap.querySelectorAll('button')) b.classList.toggle('sel', b === button);
        $('setpiece-hint').textContent = `${labels[String(y)]} ${z === 0 ? 'CENTRE' : z < 0 ? 'LEFT' : 'RIGHT'} SELECTED`;
      });
      wrap.appendChild(button);
    }
  }
}

function openSetPiecePanel(kind, data, mode = 'taker') {
  if (!state.host || state.setPieceOpen) return;
  if (state.controlsOpen) setControlsVisible(false);
  if (state.subsOpen) closeSubsPanel();
  if (state.tacticsOpen) closeTacticsPanel();
  state.setPieceOpen = true;
  state.setPieceType = kind;
  state.setPieceData = data;
  state.setPieceMode = mode;
  state.setPieceZone = { z: 0, y: 0 };
  state.setPieceDive = 0;
  $('setpiece-title').textContent = kind === 'freeKick' ? 'FREE KICK' : mode === 'keeper' ? 'DEFEND PENALTY' : 'PENALTY';
  setPieceText(kind, mode, data);
  $('setpiece-goal-wrap').classList.toggle('hidden', mode === 'keeper');
  $('setpiece-controls').classList.toggle('hidden', mode === 'keeper');
  $('setpiece-keeper').classList.toggle('hidden', mode !== 'keeper');
  $('curve-wrap').classList.toggle('hidden', kind !== 'freeKick');
  $('wall-mark').classList.toggle('hidden', kind !== 'freeKick');
  $('btn-setpiece-strike').classList.toggle('hidden', mode === 'keeper');
  $('setpiece-hint').textContent = mode === 'keeper' ? 'PICK A DIVE' : 'PICK A ZONE, THEN STRIKE';
  $('setpiece-power').value = '68';
  $('setpiece-curve').value = '0';
  for (const button of $('dive-grid').querySelectorAll('button')) button.classList.remove('sel');
  renderSetPieceZones();
  state.host.setPaused(true);
  state.input.setActive(false);
  $('setpiece-panel').classList.remove('hidden');
}

function closeSetPiecePanel({ cancel = false } = {}) {
  if (!state.setPieceOpen) return;
  const type = state.setPieceType;
  clearTimeout(state.setPieceTimer);
  state.setPieceOpen = false;
  state.setPieceType = null;
  state.setPieceData = null;
  state.setPieceMode = 'taker';
  state.setPieceDive = 0;
  $('setpiece-panel').classList.add('hidden');
  if (cancel && type === 'penalty') state.host?.cancelPenalty();
  if (!state.halfTimeOpen && !state.subsOpen && !state.tacticsOpen && !state.controlsOpen) {
    state.host?.setPaused(false);
    state.input.setActive(true);
  }
}

function cancelSetPiece() {
  closeSetPiecePanel({ cancel: true });
}

function strikeSetPiece() {
  if (!state.host || !state.setPieceOpen) return;
  const { z, y } = state.setPieceZone;
  const power = Number($('setpiece-power').value) / 100;
  const curve = Number($('setpiece-curve').value) / 100;
  let result;
  if (state.setPieceType === 'freeKick') result = state.host.takeFreeKick({ zoneZ: z, zoneY: y, power, curve });
  else result = state.host.takePenalty({ zoneZ: z, zoneY: y, power });
  if (!result?.ok) {
    state.hud.toast(`SET PIECE FAILED · ${result?.reason ?? 'UNKNOWN'}`);
    return;
  }
  closeSetPiecePanel();
}

function startPenaltyControl(ev, mode) {
  if (!state.host || state.penaltyControl) return;
  if (state.setPieceOpen) closeSetPiecePanel({ cancel: true });
  if (state.tacticsOpen) closeTacticsPanel();
  if (state.subsOpen) closeSubsPanel();
  if (state.controlsOpen) setControlsVisible(false);
  state.penaltyControl = {
    mode, aimZ: 0, aimY: 0.35, power: 0.68, charging: false,
    startedAt: performance.now()
  };
  state.host.setPaused(true);
  state.input.setActive(true);
  state.input.resetAll();
  $('hud').classList.add('penalty-cinema');
  state.scene.focusSetPiece(mode === 'keeper' ? 'PENALTY_KEEPER' : 'PENALTY', 60);
  state.scene._forceCut = true;
  const penalty = state.host.match.penalty;
  if (mode === 'taker' && penalty?.taker) {
    const goal = state.host.match.teams[penalty.team].attackGoal;
    penalty.taker.facing = Math.atan2(goal.z - penalty.taker.pos.z, goal.x - penalty.taker.pos.x);
    state.scene.setPenaltyAim({ z: 0, y: 0.35 });
  } else {
    state.scene.setPenaltyAim(null);
  }
  state.host.latestSnapshot = state.host.match.getSnapshot();
  state.host.prevSnapshot = state.host.latestSnapshot;
}

function endPenaltyControl() {
  if (!state.penaltyControl) return;
  state.sfx.stopCharge();
  state.penaltyControl = null;
  $('hud').classList.remove('penalty-cinema');
  state.scene.setPenaltyAim(null);
  state.scene.clearFocus();
  state.host?.setPaused(false);
  if (currentScreen() === Screens.MATCH && !state.controlsOpen && !state.subsOpen &&
    !state.halfTimeOpen && !state.tacticsOpen && !state.setPieceOpen) {
    state.input.setActive(true);
  }
}

function updatePenaltyControl(dt) {
  const pc = state.penaltyControl;
  const m = state.host?.match;
  const penalty = m?.penalty;
  if (!pc || !m || !penalty || penalty.taken) { endPenaltyControl(); return; }
  const humanTeam = state.host.human?.team ?? 0;
  const attackDir = m.dirFor(humanTeam);
  const intent = state.input.sample(dt);

  if (pc.mode === 'taker') {
    const move = state.scene.movementDirection(intent.moveX, intent.moveZ, humanTeam, attackDir);
    if (move) {
      pc.aimZ = clamp(pc.aimZ + move.z * dt * 1.15, -0.95, 0.95);
      pc.aimY = clamp(pc.aimY + intent.moveZ * dt * 0.75, 0, 1);
    }
    const goal = m.teams[penalty.team].attackGoal;
    if (penalty.taker) {
      const aimWorldZ = pc.aimZ * (m.cfg.goalW / 2);
      penalty.taker.facing = Math.atan2(aimWorldZ - penalty.taker.pos.z, goal.x - penalty.taker.pos.x);
    }
    state.scene.setPenaltyAim({ z: pc.aimZ, y: pc.aimY });
    if (state.input.isHeld('shoot')) {
      if (!pc.charging) { pc.charging = true; state.sfx.startCharge(); }
      pc.power = clamp(0.25 + state.input.heldSeconds('shoot') * 0.95, 0.25, 1);
      state.sfx.setCharge(pc.power);
    }
    if (intent.shoot) {
      state.sfx.stopCharge();
      state.host.takePenalty({ zoneZ: pc.aimZ, zoneY: pc.aimY, power: intent.shootPower ?? pc.power });
      endPenaltyControl();
      return;
    }
    if (performance.now() - pc.startedAt > 12000) {
      state.host.takePenalty({ zoneZ: 0, zoneY: 0.35, power: 0.7 });
      endPenaltyControl();
      return;
    }
  } else {
    const move = state.scene.movementDirection(intent.moveX, 0, penalty.team, attackDir);
    if (penalty.keeper && move) {
      penalty.keeper.pos.z = clamp(penalty.keeper.pos.z + move.z * dt * 2.8, -3.2, 3.2);
    }
    if (intent.tackle || intent.slide) {
      const side = intent.moveX < -0.2 ? -1 : intent.moveX > 0.2 ? 1 : 0;
      state.host.takePenaltyDefense(side);
      endPenaltyControl();
      return;
    }
    if (performance.now() - pc.startedAt > 12000) {
      state.host.takePenaltyDefense(0);
      endPenaltyControl();
      return;
    }
  }
  state.host.latestSnapshot = m.getSnapshot();
  state.host.prevSnapshot = state.host.latestSnapshot;
}

function renderSubsPanel() {
  if (!state.host) return;
  const teamId = state.host.human?.team ?? state.host.match.players.find((p) => p.team === 0)?.team ?? 0;
  const team = state.host.match.teams[teamId];
  const subs = state.host.match.getSnapshot().substitutions[teamId];
  $('subs-meta').textContent = `${subs.used}/5 USED · ${subs.windows}/3 WINDOWS` +
    (state.host.match.phase === 'HALF_TIME' ? ' · HALF TIME FREE' : '');
  $('subs-rule').textContent = state.host.match.phase === 'HALF_TIME'
    ? 'HALF-TIME SUBSTITUTIONS DO NOT USE A WINDOW'
    : '5 SUBSTITUTIONS · 3 WINDOWS · HALF TIME FREE';
  $('btn-subs-close').textContent = state.host.match.phase === 'HALF_TIME' ? 'BACK TO HALF TIME' : 'RESUME';
  const list = $('subs-list');
  list.innerHTML = '';
  const bench = team.bench.slice();
  for (const out of team.players.filter((p) => !p.sentOff)) {
    const row = document.createElement('div');
    row.className = 'sub-row';
    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = `${out.name}${out.isHuman ? ' ★' : ''}`;
    const role = document.createElement('div');
    role.className = 'rl';
    role.textContent = ROLE_LABELS[out.role] ?? out.role;
    const stam = document.createElement('div');
    stam.className = 'stam';
    const bar = document.createElement('i');
    bar.style.width = `${Math.max(4, out.stamina)}px`;
    bar.style.maxWidth = '40px';
    bar.style.opacity = out.stamina < 30 ? '0.55' : '1';
    const val = document.createElement('span');
    val.textContent = Math.round(out.stamina);
    stam.append(bar, val);
    const benchOptions = out.isGoalKeeper ? bench.filter((p) => p.isGoalKeeper) : bench;
    const select = document.createElement('select');
    for (const incoming of benchOptions) {
      const option = document.createElement('option');
      option.value = incoming.id;
      option.textContent = `${incoming.name} · ${ROLE_LABELS[incoming.role] ?? incoming.role} · ${Math.round(incoming.stamina)}`;
      select.appendChild(option);
    }
    const sameRole = benchOptions.find((p) => p.anchor?.band === out.anchor?.band) ?? benchOptions[0];
    if (sameRole) select.value = sameRole.id;
    const button = document.createElement('button');
    button.textContent = 'ON';
    const windowLocked = subs.windows >= 3 && !subs.windowOpen && state.host.match.phase !== 'HALF_TIME';
    button.disabled = subs.used >= 5 || benchOptions.length === 0 || windowLocked;
    button.addEventListener('click', () => {
      const result = state.host.requestSubstitution(out.id, select.value);
      if (!result.ok) {
        const reasons = {
          NOT_STOPPAGE: 'ONLY AT A STOPPAGE',
          NO_WINDOWS: 'NO SUBSTITUTION WINDOWS LEFT',
          NO_SUBSTITUTIONS: 'ALL 5 SUBSTITUTIONS USED',
          SENT_OFF: 'SENT-OFF PLAYER CANNOT BE REPLACED'
        };
        state.hud.toast(reasons[result.reason] ?? result.reason);
        return;
      }
      renderSubsPanel();
      updateSubsCount();
      state.hud.toast(`SUB · ${out.name} OFF · ${displayName(select.value)} ON`);
    });
    row.append(nm, role, stam, select, button);
    list.appendChild(row);
  }
  if (team.players.filter((p) => !p.sentOff).length === 0) {
    const empty = document.createElement('div');
    empty.textContent = 'NO PLAYERS AVAILABLE';
    list.appendChild(empty);
  }
}

function updateSubsCount() {
  const n = state.host?.match?.teams?.[0]?.subsUsed ?? 0;
  const el = $('subs-count');
  if (el && el.textContent !== `${n}/5`) el.textContent = `${n}/5`;
}

function statRow(label, home, away, withBar = true) {
  const row = document.createElement('div');
  row.className = 'ht-stat';
  const left = document.createElement('b');
  left.textContent = String(home);
  const mid = document.createElement('div');
  mid.className = 'mid';
  const name = document.createElement('span');
  name.textContent = label;
  mid.appendChild(name);
  if (withBar) {
    const track = document.createElement('div');
    track.className = 'ht-bar';
    const a = document.createElement('i');
    const b = document.createElement('i');
    b.className = 'away';
    const hv = parseFloat(home) || 0;
    const av = parseFloat(away) || 0;
    const total = Math.max(0.0001, hv + av);
    a.style.width = `${(hv / total) * 100}%`;
    b.style.width = `${(av / total) * 100}%`;
    track.append(a, b);
    mid.appendChild(track);
  }
  const right = document.createElement('b');
  right.textContent = String(away);
  row.append(left, mid, right);
  return row;
}

function renderStatsInto(container, stats) {
  container.innerHTML = '';
  if (!stats) return;
  container.appendChild(statRow('POSSESSION', `${stats.possession[0]}%`, `${stats.possession[1]}%`));
  container.appendChild(statRow('SHOTS (ON TARGET)', `${stats.shots[0]} (${stats.onTarget[0]})`, `${stats.shots[1]} (${stats.onTarget[1]})`));
  container.appendChild(statRow('EXPECTED GOALS', stats.xg[0].toFixed(2), stats.xg[1].toFixed(2)));
  container.appendChild(statRow('PASSES COMPLETED', `${stats.passesCompleted[0]}/${stats.passes[0]}`, `${stats.passesCompleted[1]}/${stats.passes[1]}`));
  container.appendChild(statRow('CROSSES', stats.crosses[0], stats.crosses[1]));
  container.appendChild(statRow('CORNERS', stats.corners[0], stats.corners[1]));
  container.appendChild(statRow('FOULS', stats.fouls[0], stats.fouls[1]));
  container.appendChild(statRow('OFFSIDES', stats.offsides[0], stats.offsides[1]));
  container.appendChild(statRow('SAVES', stats.saves[0], stats.saves[1]));
  container.appendChild(statRow('DUELS WON', stats.duelsWon?.[0] ?? 0, stats.duelsWon?.[1] ?? 0));
  container.appendChild(statRow('CARDS Y/R', `${stats.cards[0].yellow}/${stats.cards[0].red}`, `${stats.cards[1].yellow}/${stats.cards[1].red}`));
}

function openHalfTime(ev) {
  state.halfTimeOpen = true;
  state.host.setPaused(true);
  state.input.setActive(false);
  $('ht-score').textContent = `HOME ${ev.score[0]} — ${ev.score[1]} AWAY`;
  renderStatsInto($('ht-stats'), ev.stats ?? state.host.match.statsSnapshot());
  $('halftime-panel').classList.remove('hidden');
}

function continueSecondHalf() {
  $('halftime-panel').classList.add('hidden');
  state.halfTimeOpen = false;
  state.host?.startSecondHalf();
  if (!state.subsOpen && !state.controlsOpen) state.input.setActive(true);
  state.hud.showBanner('SECOND HALF', 'ENDS SWITCHED • KICK-OFF');
}

function wireMatchEvents() {
  const e = state.host.events;
  const banner = (t, s, ms = 2200) => state.hud.showBanner(t, s, ms);
  e.on('Goal', (ev) => { banner('GOAL!', `${ev.team === 0 ? 'HOME' : 'AWAY'} SCORE • ${ev.score[0]}-${ev.score[1]}`); state.sfx.play('Goal'); state.sfx.setCrowdLevel(1); });
  e.on('KeeperSavesTheBall', () => { banner('GREAT SAVE!', 'SAFE HANDS!'); state.sfx.play('KeeperSavesTheBall'); });
  e.on('KeeperParry', () => { banner('PARRIED!', 'KEEPER GETS A HAND TO IT'); state.sfx.play('KeeperSavesTheBall'); });
  e.on('BallHitWoodwork', (ev) => { banner(ev.part === 'POST' ? 'OFF THE POST!' : 'OFF THE CROSSBAR!', ''); state.sfx.play('BallHitWoodwork'); });
  e.on('PlayerHeader', () => state.sfx.play('PlayerShoot', { gain: 0.55 }));
  e.on('PlayerTackled', () => { banner('CLEAN TACKLE!', ''); state.sfx.play('PlayerTackled'); });
  e.on('PlayerPass', () => state.sfx.play('PlayerPass'));
  e.on('PlayerShoot', () => state.sfx.play('PlayerShoot'));
  e.on('PlayerTouchTheBall', () => state.sfx.play('PlayerTouchTheBall', { gain: 0.25 }));
  e.on('Whistle', (ev) => { state.sfx.play('Whistle'); if (ev.reason) setRefMessage(ev.reason, 1700); });
  e.on('FirstWhistle', () => { state.sfx.play('FirstWhistle'); setRefMessage('KICK-OFF', 1500); });
  e.on('ThrowIn', () => { banner('THROW-IN', '', 1500); state.scene.focusSetPiece('THROWIN', 2.4); });
  e.on('Corner', () => { banner('CORNER', '', 1700); state.scene.focusSetPiece('CORNER', 3.2); });
  e.on('GoalKick', () => { banner('GOAL KICK', '', 1500); state.scene.focusSetPiece('GOALKICK', 2.2); });
  e.on('KickOff', (ev) => {
    banner('KICK-OFF', `${ev.team === 0 ? 'HOME' : 'AWAY'} TO START`, 1600);
    setRefMessage('KICK-OFF', 1600);
    state.sfx.play('Whistle');
    state.scene.focusSetPiece('KICKOFF', 2.2);
  });
  e.on('HalfTime', (ev) => openHalfTime(ev));
  e.on('SecondHalf', () => {
    $('halftime-panel').classList.add('hidden');
    state.halfTimeOpen = false;
    state.host.setPaused(false);
    if (!state.subsOpen && !state.controlsOpen) state.input.setActive(true);
    banner('SECOND HALF', 'ENDS SWITCHED • KICK-OFF');
  });
  e.on('Card', (ev) => {
    showCardCutscene(ev);
    setRefMessage(`${ev.card === 'red' ? 'RED' : 'YELLOW'} CARD · ${ev.reason || 'OFFENCE'}`, 2800);
    state.scene.focusSetPiece('CARD', 2.5, { playerId: ev.player.id });
    state.sfx.play('Whistle');
  });
  e.on('PlayerSentOff', (ev) => {
    banner('SENT OFF', `${ev.player.name} · ${ev.reason || ''}`, 2600);
    if (state.host.spectating) state.hud.toast('YOU ARE SENT OFF — SPECTATING');
  });
  e.on('PenaltyAwarded', (ev) => {
    state.sfx.play('Whistle');
    if (state.host?.match?.hasHuman && state.host?.human && !state.host.spectating) {
      const humanTeam = state.host.human.team;
      startPenaltyControl(ev, ev.team === humanTeam ? 'taker' : 'keeper');
      return;
    }
    banner('PENALTY!', ev.team === 0 ? 'HOME SPOT KICK' : 'AWAY SPOT KICK', 2600);
    setRefMessage('PENALTY AWARDED', 2600);
    state.scene.focusSetPiece('PENALTY', 3.4);
  });
  e.on('FreeKickAwarded', (ev) => {
    banner(ev.indirect ? 'INDIRECT FREE KICK' : 'FREE KICK',
      `${ev.team === 0 ? 'HOME' : 'AWAY'} · ${Math.round(ev.distance)}M`, 2300);
    setRefMessage(ev.indirect ? 'INDIRECT FREE KICK' : 'FREE KICK · 9.15M WALL', 2300);
    state.scene.focusSetPiece('FREEKICK', 3.2);
    if (ev.team === 0 && ev.canShoot && !ev.indirect && state.host?.human && !state.host.spectating) {
      clearTimeout(state.setPieceTimer);
      state.setPieceTimer = setTimeout(() => {
        if (!state.host || state.host.match.setPiece !== 'FREEKICK' || !state.host.match.freeKickInfo) return;
        openSetPiecePanel('freeKick', ev, 'taker');
      }, 600);
    }
  });
  e.on('PenaltyTaken', () => {
    if (state.setPieceOpen) closeSetPiecePanel();
    if (state.penaltyControl) endPenaltyControl();
    banner('PENALTY TAKEN', '', 1400);
  });
  e.on('PenaltyCancelled', () => {
    if (state.setPieceOpen) closeSetPiecePanel();
    if (state.penaltyControl) endPenaltyControl();
  });
  e.on('FreeKickTaken', () => {
    if (state.setPieceOpen) closeSetPiecePanel();
  });
  e.on('RefereeDecision', (ev) => { if (ev.type === 'ADVANTAGE') setRefMessage('ADVANTAGE — PLAY ON', 1800); });
  e.on('AdvantagePlayed', () => setRefMessage('ADVANTAGE PLAYED', 1600));
  e.on('Offside', (ev) => { banner('OFFSIDE', ev.player.name, 1500); setRefMessage('OFFSIDE', 1800); });
  e.on('PlayerHandball', (ev) => { banner('HANDBALL', ev.player.name, 1500); setRefMessage('HANDBALL', 1800); });
  e.on('Backpass', () => { state.hud.toast('BACKPASS — KEEPER MUST USE FEET'); setRefMessage('BACKPASS', 1800); });
  e.on('KeeperHoldWarning', () => { state.hud.toast('SIX-SECOND LIMIT — RELEASE THE BALL'); setRefMessage('6-SECOND LIMIT', 1800); });
  e.on('Substitution', (ev) => {
    banner('SUBSTITUTION', `${ev.out.name} OFF · ${ev.incoming.name} ON`, 2200);
    setRefMessage(`SUB · ${ev.out.name} OFF · ${ev.incoming.name} ON`, 2200);
    state.scene.focusSetPiece('SUBSTITUTION', 2.2);
    updateSubsCount();
    if (state.subsOpen) renderSubsPanel();
    if (ev.humanChanged) state.hud.toast(`YOU ARE NOW ${ev.incoming.name}`);
  });
  e.on('FormationChanged', (ev) => {
    const who = ev.team === 0 ? 'YOU' : 'AWAY';
    state.hud.toast(`${who} · SHAPE ${ev.name}`);
    if (state.tacticsOpen) updateTacticsState();
  });
  e.on('TacticChanged', (ev) => {
    const who = ev.team === 0 ? 'YOU' : 'AWAY';
    state.hud.toast(`${who} · ${tacticLabel(ev.tactic)}`);
  });
  e.on('SlotCoveredByBot', () => state.hud.setAfk(true, 'AFK: a bot is covering your slot'));
  e.on('SlotRetaken', () => { state.hud.setAfk(false); state.hud.toast('SLOT RETAKEN'); });
  e.on('CallForPass', () => state.hud.toast('CALL FOR PASS'));
  e.on('PlayerSwitched', (ev) => { if (ev.manual) state.hud.toast(`SWITCH • ${ROLE_LABELS[ev.role] ?? ev.role}`); });
  e.on('FinalWhistle', (ev) => {
    state.sfx.play('FinalWhistle');
    if (state.penaltyControl) endPenaltyControl();
    state.subsOpen = false;
    state.halfTimeOpen = false;
    state.tacticsOpen = false;
    state.setPieceOpen = false;
    state.tacticsDraft = null;
    state.setPieceType = null;
    clearTimeout(state.setPieceTimer);
    $('subs-panel').classList.add('hidden');
    $('halftime-panel').classList.add('hidden');
    $('tactics-panel').classList.add('hidden');
    $('setpiece-panel').classList.add('hidden');
    $('card-cutscene').classList.add('hidden');
    state.host.setPaused(false);
    showResults(ev);
  });
}

function showResults(ev) {
  state.input.setActive(false);
  state.host?.resetInput();
  const matchSnapshot = state.host?.match.getSnapshot() ?? state.host?.latestSnapshot;
  const snap = { ...matchSnapshot, score: ev.score };
  const won = snap.score[0] > snap.score[1];
  const drew = snap.score[0] === snap.score[1];
  $('res-title').textContent = won ? 'VICTORY' : drew ? 'DRAW' : 'DEFEAT';
  $('res-scoreline').textContent = `HOME ${snap.score[0]} — ${snap.score[1]} AWAY • ${MODE_CONFIGS[state.modeId].name}`;
  const xp = 120 + snap.score[0] * 40 + (won ? 150 : drew ? 60 : 0);
  const coins = Math.round(xp / 4);
  const p = profile.get();
  const newXp = p.xp + xp;
  const level = Math.floor(newXp / 400) + 1;
  $('res-stats').innerHTML = `
    <div class="wide"><div class="ht-stats" id="res-stat-grid"></div></div>
    <div class="wide" id="res-ratings"></div>
    <div>XP EARNED <b>+${xp}</b></div><div>COINS <b>+${coins}</b></div>
    <div>LEVEL <b>${level}</b></div><div>NEXT LEVEL <b>${xpForLevel(level) - (newXp % 400)} XP</b></div>
    <div>MATCHES <b>${p.stats.matches + 1}</b></div><div>WINS <b>${p.stats.wins + (won ? 1 : 0)}</b></div>`;
  if (snap.stats) renderStatsInto($('res-stat-grid'), snap.stats);
  const top = (snap.playerStats ?? []).slice().sort((a, b) => b.rating - a.rating).slice(0, 4);
  if (top.length) {
    const wrap = $('res-ratings');
    const title = document.createElement('div');
    title.textContent = 'TOP RATINGS';
    title.style.cssText = 'color:#9fb4d0;font-size:10px;letter-spacing:.12em;margin:10px 0 4px;';
    wrap.appendChild(title);
    for (const s of top) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:space-between;gap:16px;font-size:13px;padding:3px 0;';
      row.innerHTML = `<span>${s.name} <span style="color:#9fb4d0">${s.team === 0 ? 'HOME' : 'AWAY'} · ${s.goals}G ${s.assists}A</span></span>`;
      const rating = document.createElement('b');
      rating.textContent = s.rating.toFixed(1);
      row.appendChild(rating);
      wrap.appendChild(row);
    }
  }
  profile.update({
    xp: newXp, level, coins: p.coins + coins,
    stats: { ...p.stats, matches: p.stats.matches + 1, wins: p.stats.wins + (won ? 1 : 0) },
    mmr: { ...p.mmr, [state.modeId]: (p.mmr[state.modeId] ?? 1000) + (won ? 24 : drew ? 0 : -18) }
  });
  void ev;
  showScreen(Screens.RESULTS);
}

// interpolate 30 Hz sim snapshots for smooth 60+ fps rendering
function interpolatedSnapshot(host) {
  const a = host.prevSnapshot, b = host.latestSnapshot, t = host.alpha;
  if (!a || a.players.length !== b.players.length) return b;
  return {
    ...b,
    ball: {
      x: lerp(a.ball.x, b.ball.x, t), y: lerp(a.ball.y, b.ball.y, t), z: lerp(a.ball.z, b.ball.z, t),
      vx: b.ball.vx, vy: b.ball.vy, vz: b.ball.vz, holderId: b.ball.holderId
    },
    players: b.players.map((p, i) => ({
      ...p, x: lerp(a.players[i].x, p.x, t), z: lerp(a.players[i].z, p.z, t),
      facing: p.facing, speed: p.speed
    }))
  };
}

function loop(ts) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (ts - state.lastTs) / 1000 || 0.016);
  state.lastTs = ts;
  state.perf.frames++;
  state.perf.elapsed += dt;
  if (state.perf.elapsed >= 1) {
    state.perf.fps = Math.round(state.perf.frames / state.perf.elapsed);
    state.perf.frames = 0; state.perf.elapsed = 0;
  }

  if (currentScreen() === Screens.MATCH && state.host && state.penaltyControl) {
    updatePenaltyControl(dt);
    const penaltySnap = state.host.latestSnapshot;
    if (state.matchView) state.matchView.update(dt, penaltySnap, state.host.humanId);
    state.scene.updateCamera(dt, penaltySnap, state.host.humanId);
    state.scene.render();
    return;
  }
  if (currentScreen() === Screens.MATCH && state.host) {
    if (state.subsQueued && !state.subsOpen && state.host.match.isDeadBall() && state.host.match.phase !== 'ENDED') {
      state.subsQueued = false;
      openSubsPanel();
    }
    const overlayOpen = state.controlsOpen || state.subsOpen || state.halfTimeOpen || state.tacticsOpen || state.setPieceOpen;
    let snap = state.host.latestSnapshot;
    if (!overlayOpen) {
      const intent = state.input.sample(dt);
      const localPlayer = state.host.match.players.find((p) => p.id === state.host.humanId);
      const move = state.scene.movementDirection(intent.moveX, intent.moveZ, localPlayer?.team ?? 0,
        localPlayer ? state.host.match.dirFor(localPlayer.team) : 1);
      if (move) {
        intent.worldX = move.x;
        intent.worldZ = move.z;
        intent.aimX = move.x;
        intent.aimZ = move.z;
      }
      intent.speedScale = Math.min(1, Math.hypot(intent.moveX ?? 0, intent.moveZ ?? 0));
      state.host.receiveIntent(intent);
      snap = state.host.tick(dt);
    }
    const view = interpolatedSnapshot(state.host);
    state.matchView.update(dt, view, state.host.humanId);
    state.scene.updateCamera(dt, snap, state.host.humanId);
    updateSubsCount();
    const localSnap = snap.players.find((p) => p.id === state.host.humanId);
    if (localSnap) {
      const goalX = snap.goalX?.[1 - localSnap.team] ?? (localSnap.team === 0 ? snap.cfg.pitchLength / 2 : -snap.cfg.pitchLength / 2);
      const toward = { x: goalX - localSnap.x, z: -localSnap.z };
      const length = Math.hypot(toward.x, toward.z) || 1;
      state.hud.setCompass(state.scene.screenDirection(
        { x: localSnap.x, z: localSnap.z },
        { x: localSnap.x + toward.x / length * 6, z: localSnap.z + toward.z / length * 6 }
      ));
      if (localSnap.stamina < 15 && !state.exhaustedWarned) {
        state.hud.toast('EXHAUSTED — STOP SPRINTING');
        state.exhaustedWarned = true;
      } else if (localSnap.stamina > 35) state.exhaustedWarned = false;
    }
    const plan = snap.teams?.[0];
    state.hud.update(snap, {
      camMode: state.scene.cameraLabel,
      shape: plan ? `${plan.formationName} · ${tacticLabel(plan.tactic)}` : '',
      role: `${state.controlMode === 'team' ? 'TEAM' : 'PLAYER'} • ${ROLE_LABELS[localSnap?.role ?? state.role] ?? localSnap?.role ?? state.role}`,
      perf: `${state.perf.fps} FPS • ${state.scene.getStats().calls} CALLS`,
      stamina: localSnap?.stamina ?? 100,
      carry: localSnap?.carryMode ?? '',
      added: snap.displayAdded ?? 0
    });
    state.sfx.setCrowdLevel(snap.phase === 'GOAL_CELEB' ? 1 : 0.25);
    state.stadium.update(dt, snap.phase === 'GOAL_CELEB' ? 1 : 0.18);
  }
  state.scene.render();
}

// Debug/automation handle (used by headless verification and the ws test client).
window.__pitchline = {
  get state() { return state; },
  get host() { return state.host; },
  get snapshot() { return state.host?.latestSnapshot ?? null; },
  get stats() {
    return {
      ...state.scene.getStats(), fps: state.perf.fps, quality: state.scene.quality,
      athletes: !!state.athletes, crowd: state.stadium.body?.count ?? 0
    };
  },
  penaltyTick: (dt = 1 / 60) => updatePenaltyControl(dt),
  startMatch, leaveMatch, showScreen
};

boot().catch((err) => {
  console.error('BOOT FAILED', err);
  window.__pitchlineBootError = String(err?.stack ?? err);
  setBoot(100, `ERROR: ${err?.message ?? err}`);
});

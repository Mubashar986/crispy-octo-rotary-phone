const KEY = 'pl_profile_v2';
const VERSION = 2;

const DEFAULT_PROFILE = () => ({
  version: VERSION,
  name: 'STRIKER', tag: '0001', region: 'EU-Central',
  kit: { number: 9, primary: '#2aa8e0', secondary: '#0d2b45', pattern: 'STRIPES' },
  cameraMode: 0, soundOn: true, quality: 'STANDARD', controlScheme: 'arrows', controlMode: 'player',
  controlsTutorialSeen: false,
  xp: 0, level: 1, coins: 0,
  mmr: {}, stats: { matches: 0, wins: 0, goals: 0, assists: 0 },
  selectedMode: 'classic5', selectedRole: 'FWD', gamePlans: {}
});

const deepMerge = (base, patch) => {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(patch ?? {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object'
      ? deepMerge(base[k], v) : v;
  }
  return out;
};

class ProfileStore {
  constructor() {
    this.state = DEFAULT_PROFILE();
    this.listeners = new Set();
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved?.version === VERSION) this.state = deepMerge(DEFAULT_PROFILE(), saved);
      }
    } catch { /* corrupt save: start clean rather than silently half-merging */ }
  }
  get() { return this.state; }
  update(patch) {
    this.state = deepMerge(this.state, patch);
    this.save();
    this.listeners.forEach((fn) => fn(this.state));
    return this.state;
  }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  save() { try { localStorage.setItem(KEY, JSON.stringify(this.state)); } catch { /* quota */ } }
  reset() { this.state = DEFAULT_PROFILE(); this.save(); this.listeners.forEach((fn) => fn(this.state)); }
}

export const profile = new ProfileStore();
export const xpForLevel = (level) => 500 + (level - 1) * 350;

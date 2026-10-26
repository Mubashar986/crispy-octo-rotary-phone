// Single source of truth for which screen is live. The original kept a parallel
// `currentScreen` that drifted from the sim phase (C3); here routing is one value.
export const Screens = { BOOT: 'boot', LOBBY: 'lobby', MATCH: 'match', RESULTS: 'results' };

let current = Screens.BOOT;
const listeners = new Set();

export function showScreen(name) {
  if (current === name) return current;
  current = name;
  for (const el of document.querySelectorAll('[data-screen]')) {
    el.classList.toggle('hidden', el.dataset.screen !== name);
  }
  listeners.forEach((fn) => fn(name));
  return current;
}

export const currentScreen = () => current;
export const onScreenChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

const fmtClock = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

// HUD writer with change-diffing: DOM is touched only when a value actually
// changes (the original wrote ~12 nodes every frame — F3).
export class Hud {
  constructor(ids) {
    this.el = {};
    for (const [k, id] of Object.entries(ids)) this.el[k] = document.getElementById(id);
    this.cache = {};
    this.bannerTimer = 0;
  }

  set(key, value) {
    const node = this.el[key];
    if (!node || this.cache[key] === value) return;
    this.cache[key] = value;
    node.textContent = value;
  }

  update(snap, extras = {}) {
    this.set('homeScore', String(snap.score[0]));
    this.set('awayScore', String(snap.score[1]));
    this.set('clock', snap.phase === 'COUNTDOWN' ? 'KICK-OFF' : `${fmtClock(snap.displayClockSec ?? snap.clockSec)}${extras.added ? ` +${extras.added}` : ''}`);
    this.set('phase', snap.phase === 'GOAL_CELEB' ? 'GOAL!' : snap.phase === 'HALF_TIME' ? 'HALF TIME' : snap.phase === 'COUNTDOWN' ? 'READY' : snap.phase === 'ENDED' ? 'FULL TIME' : 'LIVE');
    const streak = snap.passStreak[0];
    this.set('streak', streak > 0 ? `${streak} PASS STREAK` : 'BUILD-UP');
    this.set('camMode', extras.camMode ?? '');
    this.set('shape', extras.shape ?? '');
    this.set('perf', extras.perf ?? '');
    const stamina = Math.round(extras.stamina ?? 100);
    this.set('stamina', String(stamina));
    const carry = extras.carry ?? '';
    if (this.el.carry && this.cache.carryVisible !== !!carry) {
      this.cache.carryVisible = !!carry;
      this.el.carry.style.display = carry ? '' : 'none';
    }
    this.set('carry', carry ? `CARRY · ${carry}` : '');
    if (this.el.staminaFill && this.cache.staminaWidth !== stamina) {
      this.cache.staminaWidth = stamina;
      this.el.staminaFill.style.width = `${stamina}%`;
      this.el.staminaFill.style.background = stamina < 20 ? '#f43f5e' : stamina < 45 ? '#f59e0b' : '';
    }
    this.set('role', extras.role ?? '');
    this.drawRadar(snap);
  }

  showBanner(title, sub = '', ms = 2200) {
    const b = this.el.banner;
    if (!b) return;
    b.querySelector('.banner-title').textContent = title;
    b.querySelector('.banner-sub').textContent = sub;
    b.classList.remove('hidden');
    clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(() => b.classList.add('hidden'), ms);
  }

  setCompass(angle) {
    if (!this.el.compass) return;
    const value = Math.round(angle * 100) / 100;
    if (this.cache.compass === value) return;
    this.cache.compass = value;
    this.el.compass.style.transform = `rotate(${angle + Math.PI / 2}rad)`;
  }

  setAfk(visible, text) {
    const a = this.el.afk;
    if (!a) return;
    a.classList.toggle('hidden', !visible);
    if (visible && text) this.el.afkText.textContent = text;
  }

  toast(msg) {
    const wrap = this.el.toasts;
    if (!wrap) return;
    while (wrap.children.length > 3) wrap.firstChild.remove(); // cap (F26)
    const n = document.createElement('div');
    n.className = 'toast';
    n.textContent = msg;
    wrap.appendChild(n);
    setTimeout(() => n.remove(), 2600);
  }

  drawRadar(snap) {
    const c = this.el.radar;
    if (!c || c.offsetParent === null) return;
    const g = c.getContext('2d');
    const W = c.width, H = c.height;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(6,20,12,0.85)'; g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(255,255,255,0.35)'; g.strokeRect(2, 2, W - 4, H - 4);
    g.beginPath(); g.moveTo(W / 2, 2); g.lineTo(W / 2, H - 2); g.stroke();
    const hx = snap.cfg.pitchLength / 2, hz = snap.cfg.pitchWidth / 2;
    for (const p of snap.players) {
      const x = 2 + ((p.x + hx) / (2 * hx)) * (W - 4);
      const y = 2 + ((p.z + hz) / (2 * hz)) * (H - 4);
      g.fillStyle = p.team === 0 ? '#39d3ff' : '#ff5d47';
      if (p.hasBall) { g.fillStyle = '#ffffff'; }
      g.beginPath(); g.arc(x, y, p.hasBall ? 3.4 : 2.4, 0, Math.PI * 2); g.fill();
    }
    g.fillStyle = '#fff';
    const bx = 2 + ((snap.ball.x + hx) / (2 * hx)) * (W - 4);
    const by = 2 + ((snap.ball.z + hz) / (2 * hz)) * (H - 4);
    g.beginPath(); g.arc(bx, by, 2, 0, Math.PI * 2); g.fill();
  }
}

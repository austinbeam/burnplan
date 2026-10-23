import { BUILTIN_TYPES } from './types.js';
import * as P from './planner.js';
import * as S from './store.js';

export const APP_NAME = 'Burnplan';
const MIN = 60000;
const HOUR = 3600000;

let state = S.load();
const ui = {
  route: 'setup', sub: null,
  sheet: null, sd: {},          // open sheet + its data
  viewTime: null,               // manual "what time is it" for the Fly view
  draft: null,                  // setup form
  fired: new Set(), alert: null,
  wake: null, audio: null
};

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const f1 = (n) => (n == null || !isFinite(n) ? '—' : (Math.round(n * 10) / 10).toFixed(1));
const pad = (n) => String(n).padStart(2, '0');
const hm = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const zt = (ms) => { const d = new Date(ms); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`; };
const tz = (ms) => `${hm(ms)} <span class="z">${zt(ms)}</span>`;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : NaN; };
const dur = P.fmtDur;
const now = () => Date.now();
const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

const ICON = {
  warn: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 L22 20 H2 Z"/><path d="M12 10 v4"/><path d="M12 17 v.5"/></svg>',
  info: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11 v5"/><path d="M12 8 v.5"/></svg>',
  x: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6 L18 18"/><path d="M18 6 L6 18"/></svg>',
  del: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 7h14"/><path d="M9 7V4h6v3"/><path d="M7 7l1 13h8l1-13"/></svg>',
  bell: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/></svg>'
};

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

function persist() {
  if (!S.save(state)) toast('Could not save — storage full or blocked');
}

// ---------- types / tails / config ----------
const allTypes = () => [...BUILTIN_TYPES, ...Object.values(state.customTypes)];
const typeById = (id) => allTypes().find((t) => t.id === id);
function cfgForTail(tailId, flightOv) {
  const tail = state.tails[tailId];
  const type = tail && typeById(tail.typeId);
  return type ? P.resolveConfig(type, tail, flightOv) : null;
}
const sideCls = (cfg, id) => ((cfg.tanks.find((t) => t.id === id) || {}).side === 'R' ? 'tankR' : 'tankL');
const fullLevels = (cfg) => Object.fromEntries(cfg.tanks.map((t) => [t.id, t.capacity]));

// ---------- flights ----------
const activeFlight = () => (state.activeFlightId ? state.flights[state.activeFlightId] : null);
const MS = (f, min) => f.engineStart + min * MIN;
// The pilot's flight timer starts at takeoff; taxi happens before it.
const takeoffOf = (f) => (f && (f.takeoff ?? (f.engineStart ? f.engineStart + (f.taxiMin || 0) * MIN : null))) || null;
const timerAt = (f, ms) => (ms - takeoffOf(f)) / MIN;
const fmtTimer = (min) => (min < -0.5 ? 'taxi' : '+' + dur(Math.max(0, min)));
const timerZ = (f, ms) => `<span class="mono">${fmtTimer(timerAt(f, ms))}</span> <span class="z">${hm(ms)} · ${zt(ms)}</span>`;
const timeMode = () => state.settings.timeMode || 'timer';

function requiredLanding(f, atMs) {
  const cfg = f.cfg;
  let alt = 0;
  if (f.alt && f.alt.on) {
    alt = +f.alt.fuel || 0;
    const etes = (f.events || []).filter((e) => e.type === 'ete' && (atMs == null || e.at <= atMs) && e.altFuel > 0);
    if (etes.length) alt = etes[etes.length - 1].altFuel;
  }
  return P.reserveGal(cfg) + alt;
}

function planCheck(f) {
  const p = f.plan;
  return P.checkPlan({ cfg: f.cfg, segs: p.segs, legs: p.legs, levels: p.levels, startMin: p.startMin, endMin: p.endMin, requiredLanding: requiredLanding(f), fromEngineStart: p.startMin === 0 });
}

function planAbs(f) {
  if (!f.engineStart) return [];
  let t = f.plan.startMin;
  return f.plan.legs.map((l) => { const a = { tank: l.tank, start: MS(f, t), end: MS(f, t + l.min) }; t += l.min; return a; });
}

function savePlanHistory(f, reason) {
  f.planHistory = f.planHistory || [];
  f.planHistory.push({ at: now(), reason, startMin: f.plan.startMin, legs: f.plan.legs.map((l) => ({ ...l })), source: f.plan.source });
  if (f.planHistory.length > 60) f.planHistory.shift();
}

function generateFor(f, { startMin, endMin, segs, levels, currentTank }) {
  const g = P.generatePlan({ cfg: f.cfg, segs, startMin, endMin, levels, currentTank, requiredLanding: requiredLanding(f) });
  return { startMin, endMin, segs, levels: { ...levels }, legs: g.legs.map((l) => ({ tank: l.tank, min: l.min })), source: currentTank ? 'rebuilt' : 'generated', at: now() };
}

function rebuildFrom(f, atMs, reason) {
  const est = P.estimate(f, f.cfg, atMs);
  const rs = P.remainingSegs(f, atMs);
  savePlanHistory(f, reason || 'rebuild');
  f.plan = generateFor(f, { startMin: rs.startMin, endMin: rs.endMin, segs: rs.segs, levels: est.levels, currentTank: est.active });
}

function flightTitle(f) {
  const to = f.divert ? `${esc(f.divert.ident || 'stop')}` : esc(f.to || '—');
  return `${esc(f.from || '—')} → ${to}`;
}

function arrivalMs(f) {
  if (!f.engineStart) return null;
  const rs = P.remainingSegs(f, Math.max(now(), f.engineStart));
  return MS(f, rs.endMin);
}

// ---------- alerts / wake lock / sound ----------
function unlockAudio() {
  if (ui.audio) return;
  try { ui.audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { ui.audio = null; }
}
function beep(times = 3) {
  const ctx = ui.audio;
  if (!ctx) return;
  try {
    if (ctx.state === 'suspended') ctx.resume();
    for (let i = 0; i < times; i++) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 880; o.type = 'square';
      const t0 = ctx.currentTime + i * 0.35;
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.25);
      o.connect(g).connect(ctx.destination); o.start(t0); o.stop(t0 + 0.27);
    }
  } catch (e) { /* ignore */ }
}
async function keepAwake(on) {
  try {
    if (on && !ui.wake && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      ui.wake = await navigator.wakeLock.request('screen');
      ui.wake.addEventListener('release', () => { ui.wake = null; });
    } else if (!on && ui.wake) { await ui.wake.release(); ui.wake = null; }
  } catch (e) { ui.wake = null; }
}

function checkAlerts() {
  const f = activeFlight();
  if (!f || f.status !== 'active' || ui.viewTime) return;
  const t = now();
  const est = P.estimate(f, f.cfg, t);
  const legs = planAbs(f);
  const pre = (f.cfg.alerts?.preMin ?? 2) * MIN;
  for (let i = 1; i < legs.length; i++) {
    const L = legs[i];
    if (L.tank === legs[i - 1].tank) continue;
    for (const kind of ['pre', 'due']) {
      const at = kind === 'pre' ? L.start - pre : L.start;
      const key = `${f.id}:${Math.round(L.start / 1000)}:${L.tank}:${kind}`;
      if (t >= at && t - at < 5 * MIN && !ui.fired.has(key)) {
        ui.fired.add(key);
        if (est.active === L.tank) continue; // already switched early
        if (kind === 'pre' && t >= L.start) continue;
        ui.alert = { kind, tank: L.tank, from: est.active, at: L.start, key };
        renderAlert();
        if (f.cfg.alerts?.sound !== false) beep(kind === 'pre' ? 1 : 3);
        if (f.cfg.alerts?.vibrate !== false && navigator.vibrate) navigator.vibrate(kind === 'pre' ? [200] : [400, 150, 400, 150, 400]);
      }
    }
  }
  if (ui.alert && ui.alert.kind === 'pre' && t >= ui.alert.at) { ui.alert = null; renderAlert(); }
}

function renderAlert() {
  const bar = $('#alertbar');
  if (activeFlight()?.status !== 'active') ui.alert = null;
  const a = ui.alert;
  if (!a) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
  const mins = Math.max(0, Math.round((a.at - now()) / MIN));
  bar.classList.remove('hidden');
  bar.innerHTML = `<div class="inner ${a.kind === 'pre' ? 'pre' : ''}" role="alert">
    <div class="row between"><span>${a.kind === 'pre' ? `Switch in ${mins} min` : 'Switch tanks now'}</span><span>${timerZ(activeFlight(), a.at)}</span></div>
    <div class="big">${esc(a.from)} → ${esc(a.tank)}</div>
    <div class="row"><button class="btn grow" data-act="alertSwitch">Record switch</button><button class="btn grow" data-act="alertDismiss">Dismiss</button></div>
  </div>`;
}

// ---------- idle auto-save ----------
function checkIdle() {
  const f = activeFlight();
  if (!f) return false;
  const idleH = f.cfg.idleHours || 3;
  let base = state.lastInputAt || 0;
  if (f.status === 'active') { const arr = arrivalMs(f); if (arr) base = Math.max(base, arr); }
  if (now() - base < idleH * HOUR) return false;
  if (f.status === 'active') { f.status = 'closed'; f.autoSaved = true; f.shutdown = f.shutdown || Math.max(state.lastInputAt, f.engineStart); }
  else { f.status = 'saved'; f.autoSaved = true; }
  state.activeFlightId = null;
  ui.draft = null;
  persist();
  toast(`Previous flight auto-saved after ${idleH} h idle`);
  go('setup');
  return true;
}

function markInput() {
  state.lastInputAt = now();
  clearTimeout(markInput._t);
  markInput._t = setTimeout(persist, 1500);
}

// ---------- routing ----------
function go(route, sub = null) {
  const h = '#' + route + (sub ? '/' + sub : '');
  if (location.hash !== h) location.hash = h;
  else render();
}
function readHash() {
  const [r, s] = location.hash.replace(/^#/, '').split('/');
  ui.route = ['setup', 'plan', 'fly', 'log', 'aircraft'].includes(r) ? r : (activeFlight()?.status === 'active' ? 'fly' : 'setup');
  ui.sub = s || null;
}

function renderTabs() {
  const tabs = [['setup', 'Setup'], ['plan', 'Plan'], ['fly', 'Fly'], ['log', 'Log'], ['aircraft', 'Aircraft']];
  $('#tabs').innerHTML = tabs.map(([r, l]) => `<a href="#${r}" class="${ui.route === r ? 'on' : ''}">${l}</a>`).join('');
}

function render() {
  renderTabs();
  const v = { setup: viewSetup, plan: viewPlan, fly: viewFly, log: viewLog, aircraft: viewAircraft }[ui.route];
  $('#app').innerHTML = v();
  if (ui.route === 'fly') renderFlyLive();
  if (ui.route === 'setup') renderSetupCalc();
  renderSheet();
  renderAlert();
  const f = activeFlight();
  keepAwake(!!(f && f.status === 'active' && ui.route === 'fly'));
}

// =====================================================================
// SETUP
// =====================================================================
function defaultDraft() {
  const tail = state.settings.lastTail && state.tails[state.settings.lastTail] ? state.settings.lastTail : Object.keys(state.tails)[0] || '';
  const cfg = tail ? cfgForTail(tail) : null;
  return {
    tail, from: '', to: '', ete: '', fuel: '', taxi: String(state.settings.lastTaxi?.[tail] ?? 15), climbMin: '', climbGph: '', cruiseGph: '',
    alt: { on: false, ident: '', ete: '', fuel: '' },
    levels: cfg ? Object.fromEntries(Object.entries(fullLevels(cfg)).map(([k, v]) => [k, String(v)])) : {},
    resMin: '', resGph: ''
  };
}

function draftFromFlight(f) {
  return {
    tail: f.tail, from: f.from, to: f.to, ete: dur(f.eteMin), fuel: String(f.totalFuel || ''), taxi: String(f.taxiMin), climbMin: f.profileInput?.climbMin || '', climbGph: f.profileInput?.climbGph || '', cruiseGph: f.profileInput?.cruiseGph || '',
    alt: { on: !!f.alt?.on, ident: f.alt?.ident || '', ete: f.alt?.eteMin ? dur(f.alt.eteMin) : '', fuel: f.alt?.fuel ? String(f.alt.fuel) : '' },
    levels: Object.fromEntries(Object.entries(f.startLevels).map(([k, v]) => [k, String(v)])),
    resMin: f.resOverride?.min != null ? dur(f.resOverride.min) : '', resGph: f.resOverride?.gph != null ? String(f.resOverride.gph) : ''
  };
}

function draftCalc(d) {
  if (!d.tail || !state.tails[d.tail]) return { error: 'Add an aircraft first' };
  const resMin = P.parseDur(d.resMin), resGph = num(d.resGph);
  const ov = {};
  if (isFinite(resMin) || isFinite(resGph)) {
    ov.rules = { reserve: {} };
    if (isFinite(resMin)) ov.rules.reserve.min = resMin;
    if (isFinite(resGph)) { ov.rules.reserve.rate = 'custom'; ov.rules.reserve.customGph = resGph; }
  }
  const cfg = cfgForTail(d.tail, ov);
  const eteMin = P.parseDur(d.ete);
  const totalFuel = num(d.fuel);
  const taxiMin = isFinite(num(d.taxi)) ? num(d.taxi) : 0;
  const levels = {};
  for (const t of cfg.tanks) {
    const v = num(d.levels[t.id]);
    levels[t.id] = isFinite(v) ? Math.min(Math.max(v, 0), t.capacity) : t.capacity;
  }
  const aboard = Object.values(levels).reduce((a, b) => a + b, 0);
  const aboveFloors = cfg.tanks.reduce((a, t) => a + Math.max(0, levels[t.id] - cfg.rules.floor.gal), 0);
  const out = { cfg, ov, levels, aboard, aboveFloors, taxiMin, eteMin, totalFuel };
  if (!isFinite(eteMin) || eteMin <= 0) return { ...out, incomplete: true };
  const tl = P.buildTimeline(cfg, { taxiMin, eteMin, totalFuel: isFinite(totalFuel) ? totalFuel : 0, climbMin: P.parseDur(d.climbMin), climbGph: num(d.climbGph), cruiseGph: num(d.cruiseGph) });
  const altFuel = d.alt.on ? num(d.alt.fuel) || 0 : 0;
  const reserve = P.reserveGal(cfg);
  const required = reserve + altFuel;
  const lands = aboard - tl.totalFuel;
  return { ...out, tl, reserve, altFuel, required, lands, ok: lands >= required - P.TOL };
}

function viewSetup() {
  const f = activeFlight();
  if (f && f.status === 'active') {
    return `<div class="top"><div><div class="kicker">Flight in progress</div><h1>${flightTitle(f)}</h1></div></div>
      <div class="stack"><div class="card"><div>Took off ${hm(takeoffOf(f))} <span class="z">${zt(takeoffOf(f))}</span>. Shut down from the Fly tab to save it and start a new flight.</div>
      <a class="btn primary" href="#fly">Go to Fly</a></div></div>`;
  }
  if (!Object.keys(state.tails).length) {
    return `<div class="top"><div><div class="kicker">Welcome to ${APP_NAME}</div><h1>Add your aircraft</h1></div></div>
      <div class="stack"><div class="card"><div class="mut small">Pick the aircraft type and enter the tail number. Tank layout, burn profiles and rules come from the type; you can override any of them for this tail later.</div>
      ${tailForm()}</div></div>`;
  }
  if (!ui.draft) ui.draft = f ? draftFromFlight(f) : (state.settings.draft || defaultDraft());
  const d = ui.draft;
  if (!state.tails[d.tail]) d.tail = Object.keys(state.tails)[0];
  const cfg = cfgForTail(d.tail);
  return `<div class="top"><div><div class="kicker">${f ? 'Editing planned flight' : 'New flight'}</div><h1>Flight setup</h1></div>
    ${f ? `<button class="btn sm danger" data-act="discardDraft">Discard</button>` : ''}</div>
  <div class="stack">
    <div class="grid2">
      <div class="field span2"><label for="s-tail">Aircraft</label>
        <select id="s-tail" data-d="tail">${Object.values(state.tails).map((t) => `<option value="${esc(t.tail)}" ${t.tail === d.tail ? 'selected' : ''}>${esc(t.tail)} · ${esc(typeById(t.typeId)?.name || 'missing type')}</option>`).join('')}</select></div>
      <div class="field"><label for="s-from">From</label><input id="s-from" class="mono" data-d="from" value="${esc(d.from)}" autocapitalize="characters" placeholder="KMDD"></div>
      <div class="field"><label for="s-to">To</label><input id="s-to" class="mono" data-d="to" value="${esc(d.to)}" autocapitalize="characters" placeholder="KVBT"></div>
    </div>
    <div class="card"><h2>From ForeFlight</h2>
      <div class="grid2">
        <div class="field"><label for="s-ete">ETE (takeoff to landing)</label><input id="s-ete" class="mono key" data-fmt="hm" data-d="ete" value="${esc(d.ete)}" inputmode="numeric" placeholder="4:33"></div>
        <div class="field"><label for="s-fuel">Total fuel (incl. taxi)</label><input id="s-fuel" class="mono key" data-d="fuel" value="${esc(d.fuel)}" inputmode="decimal" placeholder="70.9"></div>
      </div>
    </div>
    <div class="card"><h2>Burn profile</h2>
      <div class="grid4">
        <div class="field"><label for="s-taxi">Taxi min</label><input id="s-taxi" class="mono" data-d="taxi" value="${esc(d.taxi)}" inputmode="numeric"></div>
        <div class="field"><label for="s-cmin">Climb</label><input id="s-cmin" class="mono" data-fmt="hm" data-d="climbMin" value="${esc(d.climbMin)}" inputmode="numeric" placeholder="${dur(cfg.burn.climbMin)}"></div>
        <div class="field"><label for="s-cgph">Climb gph</label><input id="s-cgph" class="mono" data-d="climbGph" value="${esc(d.climbGph)}" inputmode="decimal" placeholder="${f1(cfg.burn.climbGph)}"></div>
        <div class="field"><label for="s-crgph">Cruise gph</label><input id="s-crgph" class="mono" data-d="cruiseGph" value="${esc(d.cruiseGph)}" inputmode="decimal" placeholder="auto"></div>
      </div>
      <div class="mut small">Blank = aircraft defaults. Cruise "auto" is worked out so the total matches ForeFlight.</div>
      <div id="setupCalc"></div>
    </div>
    <div class="card">
      <label class="check"><input type="checkbox" data-d="alt.on" ${d.alt.on ? 'checked' : ''}>Alternate (optional)</label>
      <div class="grid3 ${d.alt.on ? '' : 'hidden'}" id="altFields">
        <div class="field"><label for="s-alt">Ident</label><input id="s-alt" class="mono" data-d="alt.ident" value="${esc(d.alt.ident)}" autocapitalize="characters"></div>
        <div class="field"><label for="s-altete">ETE</label><input id="s-altete" class="mono" data-fmt="hm" data-d="alt.ete" value="${esc(d.alt.ete)}" inputmode="numeric" placeholder="0:30"></div>
        <div class="field"><label for="s-altfuel">Fuel</label><input id="s-altfuel" class="mono" data-d="alt.fuel" value="${esc(d.alt.fuel)}" inputmode="decimal" placeholder="8.0"></div>
      </div>
      <div class="mut small">When checked, the reserve is counted after reaching the alternate.</div>
    </div>
    <div class="card"><div class="row between"><h2>Starting fuel (usable gal)</h2><button class="btn sm outline" data-act="allFull">All full</button></div>
      <div class="grid4">${cfg.tanks.map((t) => `<div class="field"><label for="lv-${t.id}">${esc(t.id)} <span class="dim">/${t.capacity}</span></label><input id="lv-${t.id}" class="mono" data-d="levels.${t.id}" value="${esc(d.levels[t.id] ?? t.capacity)}" inputmode="decimal"></div>`).join('')}</div>
    </div>
    <details class="card"><summary>Reserve for this flight</summary>
      <div class="grid2">
        <div class="field"><label for="s-rmin">Time (default ${dur(cfg.rules.reserve.min)})</label><input id="s-rmin" class="mono" data-fmt="hm" inputmode="numeric" data-d="resMin" value="${esc(d.resMin)}" placeholder="${dur(cfg.rules.reserve.min)}"></div>
        <div class="field"><label for="s-rgph">At gph (default ${f1(P.reserveGph(cfg))})</label><input id="s-rgph" class="mono" data-d="resGph" value="${esc(d.resGph)}" inputmode="decimal" placeholder="${f1(P.reserveGph(cfg))}"></div>
      </div>
      <div class="mut small">Leave blank to use the aircraft's reserve rule (${cfg.rules.reserve.mode}).</div>
    </details>
    <div id="setupWarn"></div>
    <button class="btn primary block" data-act="buildPlan">${f ? 'Rebuild plan' : 'Build plan'}</button>
  </div>`;
}

function renderSetupCalc() {
  const box = $('#setupCalc');
  if (!box || !ui.draft) return;
  const c = draftCalc(ui.draft);
  const warn = $('#setupWarn');
  if (c.error) { box.innerHTML = `<div class="mut small">${esc(c.error)}</div>`; return; }
  if (c.incomplete) {
    box.innerHTML = `<div class="mut small">Enter ForeFlight ETE and total fuel. ${f1(c.aboard)} aboard · ${f1(c.aboveFloors)} above ${c.cfg.rules.floor.gal} gal floors.</div>`;
    if (warn) warn.innerHTML = '';
    return;
  }
  const tl = c.tl, cfg = c.cfg, b = cfg.burn;
  box.innerHTML = `<div class="stack" style="gap:6px">
    <div class="kv"><span class="mut">Taxi share (${f1(b.ground)} gph, run-up incl.)</span><span class="v">${f1(tl.taxiFuel)}</span></div>
    <div class="kv"><span class="mut">Climb ${dur(tl.climbMin)} @ ${f1(tl.climbGph)} gph → level at +${dur(tl.climbMin)}</span><span class="v">${f1(tl.climbFuel)}</span></div>
    <div class="kv"><span class="mut">Cruise ${dur(tl.cruiseMin)} @ ${tl.derived ? 'auto' : num(ui.draft.cruiseGph) > 0 ? 'your' : 'typical'} rate</span><span class="v">${f1(tl.cruiseGph)} gph · ${f1((tl.cruiseMin / 60) * tl.cruiseGph)}</span></div>
    <div class="kv total"><span>Block ${dur(tl.blockMin)}</span><span class="v">${f1(tl.totalFuel)} gal</span></div>
    <div class="kv"><span class="mut">Aboard ${f1(c.aboard)} · lands with</span><span class="v" style="color:${c.ok ? 'var(--tx)' : 'var(--warn)'}">${f1(c.lands)}</span></div>
    <div class="kv"><span class="mut">Reserve ${dur(cfg.rules.reserve.min)} @ ${f1(P.reserveGph(cfg))}${c.altFuel ? ` + alternate ${f1(c.altFuel)}` : ''}</span><span class="v">${f1(c.required)}</span></div>
    ${tl.issue ? `<div class="mut small">${esc(tl.issue)}</div>` : ''}
    ${!tl.derived && !(c.totalFuel > 0) ? `<div class="mut small">No ForeFlight fuel entered — using cruise ${f1(tl.cruiseGph)} gph.</div>` : ''}
    ${num(ui.draft.cruiseGph) > 0 && c.totalFuel > 0 ? `<div class="mut small">With your cruise rate the total is ${f1(tl.totalFuel)} vs ForeFlight ${f1(c.totalFuel)} (${tl.totalFuel - c.totalFuel >= 0 ? '+' : ''}${f1(tl.totalFuel - c.totalFuel)}).</div>` : ''}
  </div>`;
  if (warn) {
    const shortRes = c.required - c.lands;
    warn.innerHTML = shortRes > P.TOL
      ? `<div class="issue error">${ICON.warn}<div>Lands with ${f1(c.lands)}; needs ${f1(c.required)}. <b>${f1(shortRes)} gal short = ${dur((Math.max(0, c.lands - c.altFuel) / P.reserveGph(cfg)) * 60)} reserve instead of ${dur(cfg.rules.reserve.min)}.</b></div></div>`
      : '';
  }
}

function setPath(obj, path, val) {
  const ks = path.split('.');
  let o = obj;
  for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]] = o[ks[i]] ?? {};
  o[ks[ks.length - 1]] = val;
}

function buildPlanFromDraft() {
  const d = ui.draft;
  const c = draftCalc(d);
  if (c.error) return toast(c.error);
  if (c.incomplete) return toast('Enter ForeFlight ETE');
  let f = activeFlight();
  if (f && f.status === 'active') return;
  const isNew = !f;
  if (isNew) f = { id: uid(), createdAt: now(), status: 'draft', events: [], planHistory: [] };
  Object.assign(f, {
    tail: d.tail, typeId: state.tails[d.tail].typeId, cfg: c.cfg,
    from: (d.from || '').toUpperCase(), to: (d.to || '').toUpperCase(),
    eteMin: c.eteMin, totalFuel: isFinite(c.totalFuel) ? c.totalFuel : 0, taxiMin: c.taxiMin,
    alt: { on: !!d.alt.on, ident: (d.alt.ident || '').toUpperCase(), eteMin: P.parseDur(d.alt.ete) || 0, fuel: num(d.alt.fuel) || 0 },
    resOverride: c.ov.rules ? { min: c.ov.rules.reserve.min, gph: c.ov.rules.reserve.customGph } : null,
    startLevels: c.levels, segs: c.tl.segments, blockMin: c.tl.blockMin, cruiseGph: c.tl.cruiseGph, plannedFuel: c.tl.totalFuel,
    climbMin: c.tl.climbMin, climbGph: c.tl.climbGph, profileInput: { climbMin: d.climbMin, climbGph: d.climbGph, cruiseGph: d.cruiseGph }
  });
  if (!isNew && f.plan) savePlanHistory(f, 'setup changed');
  f.plan = generateFor(f, { startMin: 0, endMin: f.blockMin, segs: f.segs, levels: f.startLevels, currentTank: null });
  f.plan.source = 'generated';
  state.flights[f.id] = f;
  state.activeFlightId = f.id;
  state.settings.lastTail = d.tail;
  state.settings.lastTaxi = { ...(state.settings.lastTaxi || {}), [d.tail]: c.taxiMin };
  state.settings.draft = null;
  ui.draft = null;
  persist();
  go('plan');
}

// ---------- aircraft/tail creation form (shared) ----------
function tailForm() {
  return `<div class="grid2">
    <div class="field"><label for="nt-tail">Tail number</label><input id="nt-tail" class="mono" placeholder="N12345" autocapitalize="characters"></div>
    <div class="field"><label for="nt-type">Type</label><select id="nt-type">${allTypes().map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select></div>
  </div><button class="btn primary block" data-act="addTail">Add aircraft</button>`;
}

// =====================================================================
// PLAN
// =====================================================================
function viewPlan() {
  const f = activeFlight();
  if (!f) return `<div class="top"><div><div class="kicker">Plan</div><h1>No flight</h1></div></div><div class="card empty">Set up a flight to build a plan.<br><br><a class="btn primary" href="#setup">Flight setup</a></div>`;
  const cfg = f.cfg;
  const chk = planCheck(f);
  const p = f.plan;
  const req = requiredLanding(f);
  const active = f.status === 'active';
  const nowMin = active ? (now() - f.engineStart) / MIN : -1;
  const issues = [...chk.issues].sort((a, b) => ({ error: 0, warn: 1, info: 2 }[a.severity] - { error: 0, warn: 1, info: 2 }[b.severity]));
  const groupIssues = {};
  for (const i of issues) (groupIssues[i.severity] = groupIssues[i.severity] || []).push(i);
  const shortMin = p.endMin - chk.planEnd;
  const shortFuel = shortMin > 0.5 ? P.fuelBetween(p.segs, chk.planEnd, p.endMin) : 0;
  const tm = P.tankMap(cfg);
  const colorOf = (id) => {
    const t = tm[id]; const idx = cfg.tanks.filter((x) => x.side === t.side).indexOf(t);
    const outer = t.spot === 'tip' || t.spot === 'outboard';
    return t.side === 'R' ? (outer ? 'var(--rightd)' : 'var(--right)') : (outer ? 'var(--fill)' : 'var(--blue)');
  };
  const timeLbl = (min) => (f.engineStart ? `${fmtTimer(timerAt(f, MS(f, min)))}<br><span class="z">${hm(MS(f, min))}</span>` : fmtTimer(min - f.taxiMin));
  const pastRows = active ? actualLegs(f) : [];

  return `<div class="top"><div><div class="kicker">Plan · ${esc(f.tail)}</div><h1>${flightTitle(f)}</h1></div>
    <span class="badge ${p.source === 'edited' ? 'amber' : ''}">${p.source === 'edited' ? 'Edited' : p.source === 'rebuilt' ? 'Rebuilt' : 'Generated'}</span></div>
  <div class="stack">
    <div class="chips">
      <div class="chip"><span class="k">Burn ${p.startMin > 0 ? 'remaining' : ''}</span><span class="v">${f1(P.fuelBetween(p.segs, p.startMin, p.endMin))}</span></div>
      <div class="chip"><span class="k">Lands with</span><span class="v" style="color:${chk.landing < req - P.TOL ? 'var(--warn)' : 'var(--tx)'}">${f1(chk.landing)}</span></div>
      <div class="chip"><span class="k">Reserve${f.alt?.on ? ' + alt' : ''}</span><span class="v">${f1(req)}</span></div>
    </div>
    ${['error', 'warn', 'info'].map((sv) => (groupIssues[sv] || []).map((i) => `<div class="issue ${sv}">${sv === 'info' ? ICON.info : ICON.warn}<div>${i.legIndex != null && i.legIndex >= 0 ? `<b>Leg ${i.legIndex + 1}:</b> ` : ''}${esc(i.msg)}</div></div>`).join('')).join('')}
    <div class="stack" style="gap:6px">
      <div class="row between small mut"><span>Tank use over time</span><span>max Δ ${f1(chk.maxImb)} · limit ${cfg.rules.imbalance.gal}</span></div>
      <div class="bar phasebar" aria-label="Flight phases">${P.phasesBetween(p.segs, p.startMin, p.endMin).map((x) => `<div style="flex:${x.min};background:var(--ph-${x.phase})"></div>`).join('')}</div>
      <div class="bar">${chk.rows.map((r) => `<div style="flex:${r.min};background:${colorOf(r.tank)}"></div>`).join('')}${shortMin > 0.5 ? `<div style="flex:${shortMin};background:repeating-linear-gradient(45deg,var(--warn) 0 4px,var(--warnbg) 4px 8px)"></div>` : ''}</div>
      <div class="legend"><span><span class="sw" style="background:var(--ph-taxi)"></span>taxi</span><span><span class="sw" style="background:var(--ph-climb)"></span>climb</span><span><span class="sw" style="background:var(--ph-cruise)"></span>cruise</span><span class="dim">|</span>${cfg.tanks.map((t) => `<span><span class="sw" style="background:${colorOf(t.id)}"></span>${esc(t.id)}</span>`).join('')}${shortMin > 0.5 ? '<span>hatched = short</span>' : ''}</div>
    </div>
    <div class="legs">
      <div class="legrow head"><span>#</span><span>Tank</span><span>Start</span><span>Min</span><span>Gal</span><span>After</span><span class="right">L/R Δ</span><span></span></div>
      ${pastRows.map((r) => `<div class="legrow past"><span>✓</span><span class="${sideCls(cfg, r.tank)}">${esc(r.tank)}</span><span>${fmtTimer(timerAt(f, r.start))}</span><span>${Math.round((r.end - r.start) / MIN)}</span><span>${f1(r.fuel)}</span><span>${f1(r.after)}</span><span class="right">actual</span><span></span></div>`).join('')}
      ${chk.rows.map((r, i) => {
        const bad = r.flags.filter((x) => ['empty', 'floor', 'imbalance', 'sequence'].includes(x));
        const isNow = active && nowMin >= r.startMin && nowMin < r.startMin + r.min;
        return `<div class="legrow ${isNow ? 'now' : ''}">
          <span class="${bad.length ? 'flag' : 'mut'}">${bad.length ? '!' : i + 1}</span>
          <select aria-label="Leg ${i + 1} tank" data-leg-tank="${i}" class="${sideCls(cfg, r.tank)}">${cfg.tanks.map((t) => `<option ${t.id === r.tank ? 'selected' : ''}>${esc(t.id)}</option>`).join('')}</select>
          <span>${timeLbl(r.startMin)}</span>
          <input aria-label="Leg ${i + 1} minutes" data-leg-min="${i}" value="${Math.round(r.min)}" inputmode="numeric">
          <span>${f1(r.fuel)}</span>
          <span class="${r.flags.includes('floor') || r.flags.includes('empty') ? 'flag' : ''}">${f1(r.after)}</span>
          <span class="right ${r.flags.includes('imbalance') ? 'flag' : Math.abs(r.imb) >= cfg.rules.imbalance.gal - 2 ? 'flag w' : 'mut'}">${f1(Math.abs(r.imb))}</span>
          <button class="iconbtn" style="width:28px;height:36px" aria-label="Delete leg ${i + 1}" data-act="delLeg" data-i="${i}">${ICON.del}</button>
          <div class="legsub">${P.phasesBetween(p.segs, r.startMin, r.startMin + r.min).map((x) => `<span class="ph ph-${x.phase}">${x.phase} ${Math.round(x.min)}m${x.phase === 'taxi' ? '' : ` @ ${f1(x.gph)}`}</span>`).join(' · ')} → until ${f.engineStart ? fmtTimer(timerAt(f, MS(f, r.startMin + r.min))) : fmtTimer(r.startMin + r.min - f.taxiMin)}</div>
        </div>`;
      }).join('')}
      ${shortMin > 0.5 ? `<div class="legrow short"><span>!</span><span style="font-family:var(--sans);font-weight:600">short</span><span>${timeLbl(chk.planEnd)}</span><span>${Math.round(shortMin)}</span><span>${f1(shortFuel)}</span><span>—</span><span class="right">—</span><span></span></div>` : ''}
    </div>
    <div class="row wrap"><button class="btn sm" data-act="addLeg">+ Add leg</button><span class="mut small grow">Change a tank or minutes to edit; rules are re-checked and broken ones are flagged.</span></div>
    <div class="row">
      <button class="btn grow" data-act="regen">${active ? 'Rebuild from now' : 'Regenerate'}</button>
      ${active ? `<a class="btn primary grow" href="#fly">Fly</a>` : `<button class="btn primary grow" data-act="openSheet" data-sheet="start">Start flight</button>`}
    </div>
    ${f.planHistory?.length ? `<div class="mut small">${f.planHistory.length} earlier plan version${f.planHistory.length > 1 ? 's' : ''} kept in the log.</div>` : ''}
  </div>`;
}

// Actual legs flown so far (from switch events), for display.
function actualLegs(f, until = now()) {
  if (!f.engineStart) return [];
  const sw = f.events.filter((e) => e.type === 'switch' && e.at <= until).sort((a, b) => a.at - b.at);
  const cut = MS(f, f.plan.startMin);
  const out = [];
  let tank = f.startTank, start = f.engineStart;
  for (const e of sw) { out.push({ tank, start, end: e.at }); tank = e.tank; start = e.at; }
  out.push({ tank, start, end: Math.min(until, cut) });
  return out.filter((l) => l.start < cut && l.end > l.start).map((l) => {
    const e1 = P.estimate(f, f.cfg, l.start), e2 = P.estimate(f, f.cfg, l.end);
    return { ...l, end: Math.min(l.end, cut), fuel: e1.levels[l.tank] - e2.levels[l.tank], after: e2.levels[l.tank] };
  });
}

function editLeg(i, field, value) {
  const f = activeFlight();
  const legs = f.plan.legs.map((l) => ({ ...l }));
  if (field === 'tank') legs[i].tank = value;
  else { const m = P.parseDur(value); if (!isFinite(m) || m <= 0) return render(); legs[i].min = m; }
  if (f.plan.source !== 'edited') savePlanHistory(f, 'before edit');
  f.plan = { ...f.plan, legs, source: 'edited', at: now() };
  persist(); render();
}

// =====================================================================
// FLY
// =====================================================================
function viewFly() {
  const f = activeFlight();
  if (!f) return `<div class="top"><div><div class="kicker">Fly</div><h1>No flight</h1></div></div><div class="card empty">Set up and plan a flight first.<br><br><a class="btn primary" href="#setup">Flight setup</a></div>`;
  return `<div class="top"><div><div class="kicker">${esc(f.tail)} · ${esc(typeById(f.typeId)?.name || '')}</div><h1>${flightTitle(f)}</h1></div>
    <div style="text-align:right">${f.engineStart ? `<div class="kicker">Takeoff ${hm(takeoffOf(f))} <span class="z">${zt(takeoffOf(f))}</span></div><div class="mono" style="font-size:20px" id="elapsed"></div>` : '<span class="badge">Planned</span>'}</div></div>
  <div class="stack">
    <div class="card" style="padding:10px 12px">
      <div class="timebox">
        <div class="stack" style="gap:2px;min-width:64px"><label for="flyTime" class="lbl">${ui.viewTime ? 'Showing ' : ''}${flyMode(f) === 'timer' ? 'Flight timer' : 'Clock'}</label><span class="z" id="flyZ"></span></div>
        <input id="flyTime" data-fmt="hm" inputmode="numeric" value="${flyTimeValue(f)}" aria-label="${flyMode(f) === 'timer' ? 'Flight timer' : 'Clock time'} to show levels for">
        ${f.engineStart ? `<button class="btn sm" data-act="toggleFlyMode" style="height:44px">${flyMode(f) === 'timer' ? 'Clock' : 'Timer'}</button>` : ''}
        <button class="btn sm ${ui.viewTime ? 'outline' : ''}" data-act="liveTime" style="height:44px">${ui.viewTime ? 'Live' : 'Live'}</button>
      </div>
    </div>
    <div id="flyLive"></div>
    ${f.engineStart ? `
      <button class="btn primary block" data-act="openSheet" data-sheet="switch">Record switch</button>
      <div class="row"><button class="btn outline grow" data-act="openSheet" data-sheet="ete">Update ETE</button><button class="btn grow" data-act="openSheet" data-sheet="check">Fuel check</button></div>
      <button class="btn sm danger" data-act="openSheet" data-sheet="shutdown" style="align-self:flex-start">Shut down &amp; save flight</button>`
      : `<button class="btn primary block" data-act="openSheet" data-sheet="start">Start flight</button>
         <div class="mut small">Open this any time after takeoff: enter your flight timer and catch up on what you've done so far.</div>`}
  </div>`;
}

const flyMode = (f) => (f && f.engineStart ? timeMode() : 'clock');
function flyTimeValue(f) {
  const T = ui.viewTime || now();
  return flyMode(f) === 'timer' ? dur(Math.max(0, timerAt(f, T))) : hm(T);
}

function planeSvg(cfg) {
  const tips = cfg.tanks.some((t) => t.spot === 'tip');
  return `<svg viewBox="0 0 400 300" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
    <path d="M200 14 C215 14 222 38 222 70 L222 250 C222 275 210 296 200 296 C190 296 178 275 178 250 L178 70 C178 38 185 14 200 14 Z" fill="#20252E" stroke="#3A4250" stroke-width="1.5"/>
    <rect x="${tips ? 26 : 14}" y="104" width="${tips ? 348 : 372}" height="46" rx="10" fill="#20252E" stroke="#3A4250" stroke-width="1.5"/>
    <path d="M140 262 L260 262 L260 278 L140 278 Z" fill="#20252E" stroke="#3A4250" stroke-width="1.5"/>
    ${tips ? '<ellipse cx="22" cy="127" rx="13" ry="32" fill="#2A303A" stroke="#3A4250" stroke-width="1.5"/><ellipse cx="378" cy="127" rx="13" ry="32" fill="#2A303A" stroke="#3A4250" stroke-width="1.5"/>' : ''}
    <circle cx="200" cy="18" r="5" fill="#3A4250"/>
  </svg>`;
}

function gauge(cfg, t, level, on) {
  const pct = Math.max(0, Math.min(100, (level / t.capacity) * 100));
  const fl = (cfg.rules.floor.gal / t.capacity) * 100;
  const low = level < cfg.rules.floor.gal - P.TOL;
  return `<div class="gauge ${t.spot === 'tip' ? 'tip' : ''} ${on ? 'on' : ''} ${low ? 'low' : ''}">
    <div class="nm">${esc(t.id)}${on ? ' · ON' : ''}</div>
    <div class="tube" role="img" aria-label="${esc(t.name)} ${f1(level)} of ${t.capacity} gallons"><div class="lvl" style="height:${pct}%"></div><div class="flr" style="bottom:${fl}%"></div></div>
    <div class="g">${f1(level)}</div><div class="of">of ${t.capacity}</div></div>`;
}

function renderFlyLive() {
  const box = $('#flyLive');
  const f = activeFlight();
  if (!box || !f) return;
  const cfg = f.cfg;
  const T = ui.viewTime || now();
  const started = !!f.engineStart && T >= f.engineStart;
  const est = started ? P.estimate(f, cfg, T) : { levels: f.startLevels, active: f.plan.legs[0]?.tank, total: Object.values(f.startLevels).reduce((a, b) => a + b, 0), rate: 0 };
  const L = cfg.tanks.filter((t) => t.side === 'L'), C = cfg.tanks.filter((t) => t.side === 'C'), R = cfg.tanks.filter((t) => t.side === 'R');
  const side = (arr) => arr.reduce((a, t) => a + est.levels[t.id], 0);
  const SL = side(L), SR = side(R), imb = SL - SR;
  const el = $('#elapsed'); if (el && f.engineStart) el.textContent = fmtTimer(timerAt(f, T));
  const z = $('#flyZ'); if (z) z.textContent = flyMode(f) === 'timer' ? `${hm(T)} · ${zt(T)}` : zt(T);

  let next = '';
  if (started) {
    const legs = planAbs(f);
    let idx = legs.findIndex((l) => T >= l.start && T < l.end);
    let due = null;
    if (idx >= 0 && legs[idx].tank !== est.active) due = { tank: legs[idx].tank, at: legs[idx].start, overdue: true };
    else {
      if (idx < 0 && legs.length && T < legs[0].start) idx = -1;
      for (let j = idx + 1; j < legs.length; j++) if (legs[j].tank !== est.active) { due = { tank: legs[j].tank, at: legs[j].start }; break; }
    }
    if (due) {
      const mins = (due.at - T) / MIN;
      next = `<div class="card">
        <div class="row between"><span class="mut small">${due.overdue ? 'Plan says switch now' : 'Next planned switch'}</span><span class="mono small mut">${(() => { const n = legs.filter((l, j) => j > 0 && l.start > T && l.tank !== legs[j - 1].tank).length + (due.overdue ? 1 : 0); return `${n} switch${n === 1 ? '' : 'es'} left`; })()}</span></div>
        <div class="row between"><span style="font-size:22px;font-weight:600">${esc(est.active)} → ${esc(due.tank)}</span>
          <span style="text-align:right"><span class="mono" style="font-size:22px;color:${due.overdue ? 'var(--warn)' : 'var(--amber)'}">${fmtTimer(timerAt(f, due.at))} · ${due.overdue ? `${Math.round(-mins)}m late` : 'in ' + dur(mins)}</span><br><span class="z">${hm(due.at)} · ${zt(due.at)}</span></span></div>
        <div class="row small mut">${ICON.bell}<span>Alert ${cfg.alerts?.preMin ?? 2} min before and at the switch · screen kept awake</span></div>
      </div>`;
    } else next = `<div class="card"><div class="mut">No more switches planned${legs.length ? ` — stay on ${esc(est.active)}` : ''}.</div></div>`;
  }

  let dest = '';
  if (started) {
    const rs = P.remainingSegs(f, T);
    const need = P.fuelBetween(rs.segs, rs.startMin, rs.endMin);
    const req = requiredLanding(f, T);
    const lands = est.total - need;
    const arr = MS(f, rs.endMin);
    const ok = lands >= req - P.TOL;
    const resRate = P.reserveGph(cfg);
    const reachAt = !ok && est.total > req ? MS(f, rs.startMin + P.timeForFuel(rs.segs, rs.startMin, est.total - req)) : null;
    dest = `<div class="card">
      <div class="row between"><span class="mut small">To ${esc(f.divert?.ident || f.to || 'destination')}</span><span style="text-align:right">${timerZ(f, arr)}<br><span class="z">${dur(rs.endMin - rs.startMin)} to go</span></span></div>
      <div class="kv"><span class="mut">Lands with</span><span class="v" style="color:${ok ? 'var(--tx)' : 'var(--warn)'}">${f1(lands)} = ${dur((lands / resRate) * 60)} @ ${f1(resRate)}</span></div>
      <div class="kv"><span class="mut">Reserve${f.alt?.on ? ' + alternate' : ''}</span><span class="v">${f1(req)}</span></div>
      ${!ok ? `<div class="issue error">${ICON.warn}<div>${f1(req - lands)} gal short of reserve${reachAt ? `; reserve reached at ${fmtTimer(timerAt(f, reachAt))} (${hm(reachAt)})` : ''}. Use Update ETE to replan or plan a fuel stop.</div></div>` : ''}
      <div class="mut small">Burn ${f1(est.rate)} gph · used ${f1(est.used)}</div>
    </div>`;
  }

  box.innerHTML = `<div class="plane">${planeSvg(cfg)}
      <div class="gauges">${L.map((t) => gauge(cfg, t, est.levels[t.id], t.id === est.active)).join('')}<div class="mid"></div>${C.map((t) => gauge(cfg, t, est.levels[t.id], t.id === est.active)).join('')}${C.length ? '<div class="mid"></div>' : ''}${R.map((t) => gauge(cfg, t, est.levels[t.id], t.id === est.active)).join('')}</div>
    </div>
    <div class="sides"><div><span class="mut">Left</span><span class="v">${f1(SL)}</span></div><div class="tot" style="align-items:center"><span class="mut">Total</span><span class="v">${f1(est.total)}</span></div><div style="align-items:flex-end"><span class="mut">Right</span><span class="v">${f1(SR)}</span></div></div>
    <div class="mut small" style="text-align:center;margin-top:-6px">Imbalance ${f1(Math.abs(imb))} gal${Math.abs(imb) > 0.4 ? ` (${imb < 0 ? 'left' : 'right'} light)` : ''} · limit ${cfg.rules.imbalance.gal} · dashed line = ${cfg.rules.floor.gal} gal floor</div>
    ${started ? (() => {
      const ph = est.phase || P.phaseAt(f, T);
      const climbing = ph.phase === 'climb';
      return `<div class="card" style="padding:10px 12px;margin-top:12px;flex-direction:row;justify-content:space-between;align-items:center">
        <div class="stack" style="gap:2px"><span><b class="ph-${ph.phase}" style="text-transform:capitalize">${ph.phase}</b> · <span class="mono">${f1(ph.gph)} gph</span></span>
        <span class="mut small">${climbing ? `since ${fmtTimer(timerAt(f, ph.since))}${ph.until ? ` · level ${ph.until > T ? 'expected' : ''} ${fmtTimer(timerAt(f, ph.until))}` : ''}` : ph.phase === 'taxi' ? 'before takeoff' : 'tap Climb if you start a climb'}</span></div>
        ${ph.phase === 'taxi' ? '' : climbing ? '<button class="btn outline" data-act="openSheet" data-sheet="level">Level off</button>' : '<button class="btn" data-act="openSheet" data-sheet="climb">Climb</button>'}
      </div>`;
    })() : ''}
    <div class="stack" style="margin-top:14px">${next}${dest}</div>`;
}

// =====================================================================
// SHEETS (in-flight inputs)
// =====================================================================
function openSheet(name, data = {}) {
  const f = activeFlight();
  const t = now();
  const tmode = takeoffOf(f) && f.engineStart ? timeMode() : 'clock';
  const toField = (ms) => (tmode === 'timer' ? dur(Math.max(0, timerAt(f, ms))) : hm(ms));
  const sd = { enteredAt: t, tmode, ...data };
  if (name === 'switch') {
    const est = P.estimate(f, f.cfg, t);
    const legs = planAbs(f);
    const nextLeg = legs.find((l) => l.end > t && l.tank !== est.active);
    Object.assign(sd, { at: toField(t), tank: data.tank || nextLeg?.tank || f.cfg.tanks.find((x) => x.id !== est.active)?.id, rebuild: true, planned: nextLeg || null });
  }
  if (name === 'start') Object.assign(sd, { tmode: 'timer', at: '', atStamp: t, tank: f.plan.legs[0]?.tank || f.cfg.startTank, sofar: 'plan', rows: [], used: '' });
  if (name === 'check') Object.assign(sd, { at: toField(t), used: '', gph: '', rebuild: true });
  if (name === 'ete') {
    const rs = P.remainingSegs(f, t);
    Object.assign(sd, { at: toField(t), ete: '', fuel: '', gph: '', altFuel: f.alt?.on ? String(f.alt.fuel || '') : '', divert: false, ident: '', prevEte: rs.endMin - rs.startMin });
  }
  if (name === 'shutdown') Object.assign(sd, { at: toField(t), used: '' });
  if (name === 'climb') Object.assign(sd, { at: toField(t), len: '', gph: String(f.climbGph || f.cfg.burn.climbGph), rebuild: true });
  if (name === 'level') Object.assign(sd, { at: toField(t), rebuild: true });
  if (name === 'start') sd.climb = dur(f.climbMin ?? f.cfg.burn.climbMin);
  ui.sheet = name; ui.sd = sd;
  renderSheet();
}
function closeSheet() { ui.sheet = null; ui.sd = {}; renderSheet(); }
function ask(msg, yesLabel, fn) { ui.sheet = 'confirm'; ui.sd = { msg, yesLabel, fn }; renderSheet(); }

function renderSheet() {
  const host = $('#sheet');
  if (!ui.sheet) { host.innerHTML = ''; return; }
  if (ui.sheet === 'confirm') {
    host.innerHTML = `<div class="scrim" data-act="scrim"><div class="sheet" role="alertdialog" aria-modal="true" aria-label="Confirm">
      <h2>${esc(ui.sd.msg)}</h2><div class="row"><button class="btn grow" data-act="closeSheet">Cancel</button><button class="btn danger grow" data-act="confirmYes">${esc(ui.sd.yesLabel)}</button></div></div></div>`;
    return;
  }
  const f = activeFlight();
  const body = { switch: sheetSwitch, start: sheetStart, climb: sheetClimb, level: sheetLevel, check: sheetCheck, ete: sheetEte, shutdown: sheetShutdown }[ui.sheet];
  if (!body || !f) { ui.sheet = null; host.innerHTML = ''; return; }
  const [title, inner] = body(f);
  host.innerHTML = `<div class="scrim" data-act="scrim"><div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="row between"><h2>${esc(title)}</h2><button class="iconbtn" data-act="closeSheet" aria-label="Close">${ICON.x}</button></div>${inner}</div></div>`;
  renderSheetPreview();
}

function timeField(id, label) {
  const f = activeFlight();
  const canToggle = ui.sheet === 'start' || !!(f && f.engineStart);
  const tm = ui.sd.tmode;
  const lbl = typeof label === 'function' ? label(tm) : `${label} · ${tm === 'timer' ? 'flight timer' : 'local clock'}`;
  const nowBtns = ui.sheet === 'start' && tm === 'timer' ? '' : `<button class="btn" style="width:60px;height:52px" data-act="sdMinus">−1m</button><button class="btn" style="width:64px;height:52px" data-act="sdNow">Now</button>`;
  return `<div class="field"><div class="row between"><label for="${id}">${lbl}</label>${canToggle ? `<button class="btn sm" style="height:32px" data-act="sdTmode">${tm === 'timer' ? 'Use clock' : 'Use timer'}</button>` : ''}</div>
  <div class="row"><input id="${id}" class="big key grow" data-fmt="hm" data-sd="at" value="${esc(ui.sd.at)}" inputmode="numeric" placeholder="${tm === 'timer' ? '1:12' : '15:48'}">${nowBtns}</div>
  <div class="z" id="sdAtOther"></div></div>`;
}

function sheetStart(f) {
  const tanks = f.cfg.tanks;
  const rows = ui.sd.rows || [];
  const manual = ui.sd.sofar === 'manual';
  return ['Start flight', `${timeField('sd-at', (tm) => (tm === 'timer' ? 'Flight timer right now' : 'Takeoff time (local clock)'))}
    <div class="field"><label>Takeoff tank</label><div class="tankpick">${tanks.map((t) => `<button data-act="sdTank" data-tank="${esc(t.id)}" class="${ui.sd.tank === t.id ? 'sel' : ''}"><span class="t">${esc(t.id)}</span><span class="s">${f1(f.startLevels[t.id])}</span></button>`).join('')}</div></div>
    <div class="field"><span class="lbl">Since takeoff</span><div class="grid2">
      <button class="btn ${!manual ? 'outline' : ''}" data-act="sdSofar" data-v="plan" aria-pressed="${!manual}">Followed the plan</button>
      <button class="btn ${manual ? 'outline' : ''}" data-act="sdSofar" data-v="manual" aria-pressed="${manual}">Enter what I did</button></div></div>
    ${manual ? `<div class="stack" style="gap:8px">
      ${rows.map((r, i) => `<div class="row"><span class="mut small" style="width:52px">Switch ${i + 1}</span>
        <select aria-label="Switch ${i + 1} tank" data-row="${i}.tank" class="mono" style="width:84px">${tanks.map((t) => `<option ${t.id === r.tank ? 'selected' : ''}>${esc(t.id)}</option>`).join('')}</select>
        <span class="mut small">at +</span><input aria-label="Switch ${i + 1} flight timer" class="mono grow" data-fmt="hm" data-row="${i}.at" value="${esc(r.at)}" inputmode="numeric" placeholder="0:45">
        <button class="iconbtn" data-act="delRow" data-i="${i}" aria-label="Remove switch ${i + 1}">${ICON.del}</button></div>`).join('')}
      <div class="row"><button class="btn sm" data-act="addRow">+ Add switch</button><span class="mut small grow">Flight timer reading when you switched.</span></div></div>` : ''}
    <div class="grid2">
      <div class="field"><label for="sd-climb">Initial climb took</label><input id="sd-climb" class="mono" data-fmt="hm" data-sd="climb" value="${esc(ui.sd.climb)}" inputmode="numeric"></div>
      <div class="field"><label for="sd-used">GI 275 used so far (opt.)</label><input id="sd-used" class="mono" data-sd="used" value="${esc(ui.sd.used)}" inputmode="decimal" placeholder="gal"></div>
    </div>
    <div id="sheetPreview"></div>
    <button class="btn primary block" data-act="saveStart">Start tracking</button>`];
}

// Switches implied by the plan between takeoff and now (for "Followed the plan").
function plannedSwitchesBefore(f, engineStart, tank0, untilMs) {
  let t = f.plan.startMin;
  const out = [];
  let prev = tank0;
  f.plan.legs.forEach((l, i) => {
    const at = engineStart + t * MIN;
    if (i > 0 && at <= untilMs && l.tank !== prev) out.push({ tank: l.tank, at });
    if (at <= untilMs) prev = l.tank;
    t += l.min;
  });
  return out;
}

// Parse the catch-up rows into switch events; returns {list, error}.
function manualSwitches(takeoff, tank0) {
  const out = [];
  let prev = tank0, prevAt = takeoff - 1;
  for (const [i, r] of (ui.sd.rows || []).entries()) {
    const d = P.parseDur(r.at);
    if (!isFinite(d)) return { error: `Switch ${i + 1}: enter the timer reading` };
    const at = takeoff + d * MIN;
    if (at > now() + MIN) return { error: `Switch ${i + 1} is after the timer now` };
    if (at <= prevAt) return { error: `Switch ${i + 1} must be after switch ${i}` };
    if (r.tank === prev) return { error: `Switch ${i + 1} is to the tank already on (${r.tank})` };
    out.push({ tank: r.tank, at });
    prev = r.tank; prevAt = at;
  }
  return { list: out };
}

function sheetSwitch(f) {
  const est = P.estimate(f, f.cfg, now());
  return ['Record actual switch', `
    <div class="field"><label>From ${esc(est.active)} to</label><div class="tankpick">${f.cfg.tanks.map((t) => `<button data-act="sdTank" data-tank="${esc(t.id)}" class="${ui.sd.tank === t.id ? 'sel' : ''}" ${t.id === est.active ? 'disabled' : ''}><span class="t">${esc(t.id)}</span><span class="s">${t.id === est.active ? 'current' : ui.sd.planned?.tank === t.id ? 'planned' : f1(est.levels[t.id])}</span></button>`).join('')}</div></div>
    ${timeField('sd-at', 'Switched at', ui.sd.at)}
    <div class="row between card" style="padding:10px 12px"><div class="stack" style="gap:2px"><span class="lbl">Entered at</span><span class="mono" style="font-size:18px" id="sdEntered">${tz(ui.sd.enteredAt)}</span></div><button class="btn sm outline" data-act="stampEntered" style="height:44px">Stamp now</button></div>
    <div id="sheetPreview"></div>
    <label class="check"><input type="checkbox" data-sd="rebuild" ${ui.sd.rebuild ? 'checked' : ''}>Rebuild rest of plan from this switch</label>
    <button class="btn primary block" data-act="saveSwitch">Save switch</button>`];
}

function sheetCheck(f) {
  return ['Fuel check (GI 275)', `${timeField('sd-at', 'Reading time', ui.sd.at)}
    <div class="grid2"><div class="field"><label for="sd-used">Fuel used since start</label><input id="sd-used" class="big key" data-sd="used" value="${esc(ui.sd.used)}" inputmode="decimal"></div>
    <div class="field"><label for="sd-gph">Fuel flow (opt.)</label><input id="sd-gph" class="big" data-sd="gph" value="${esc(ui.sd.gph)}" inputmode="decimal"></div></div>
    <div id="sheetPreview"></div>
    <label class="check"><input type="checkbox" data-sd="rebuild" ${ui.sd.rebuild ? 'checked' : ''}>Rebuild rest of plan with corrected levels</label>
    <button class="btn primary block" data-act="saveCheck">Save check</button>`];
}

function sheetEte(f) {
  const dest = f.divert?.ident || f.to || 'destination';
  return ['Update ETE', `${timeField('sd-at', 'As of', ui.sd.at)}
    <label class="check"><input type="checkbox" data-sd="divert" ${ui.sd.divert ? 'checked' : ''}>Fuel stop / divert</label>
    <div class="field ${ui.sd.divert ? '' : 'hidden'}" id="divIdent"><label for="sd-ident">Stop ident</label><input id="sd-ident" class="mono" data-sd="ident" value="${esc(ui.sd.ident)}" autocapitalize="characters"></div>
    <div class="grid2">
      <div class="field"><label for="sd-ete">ETE to <span id="eteDest">${esc(ui.sd.divert ? ui.sd.ident || 'stop' : dest)}</span> (was ${dur(ui.sd.prevEte)})</label><input id="sd-ete" class="big key" data-fmt="hm" data-sd="ete" value="${esc(ui.sd.ete)}" inputmode="numeric" placeholder="2:58"></div>
      <div class="field"><label for="sd-fuel">Fuel to it (ForeFlight)</label><input id="sd-fuel" class="big" data-sd="fuel" value="${esc(ui.sd.fuel)}" inputmode="decimal" placeholder="45.1"></div>
    </div>
    <div class="grid2">
      <div class="field"><label for="sd-gph">or fuel flow gph</label><input id="sd-gph" class="mono" data-sd="gph" value="${esc(ui.sd.gph)}" inputmode="decimal" placeholder="blank = current"></div>
      ${f.alt?.on ? `<div class="field"><label for="sd-alt">Alternate fuel</label><input id="sd-alt" class="mono" data-sd="altFuel" value="${esc(ui.sd.altFuel)}" inputmode="decimal"></div>` : '<div></div>'}
    </div>
    <div id="sheetPreview"></div>
    <button class="btn primary block" data-act="saveEte">Save &amp; rebuild plan</button>`];
}

function sheetClimb(f) {
  return ['Climb', `${timeField('sd-at', 'Climb started')}
    <div class="grid2">
      <div class="field"><label for="sd-len">Climb length</label><input id="sd-len" class="big" data-fmt="hm" data-sd="len" value="${esc(ui.sd.len)}" inputmode="numeric" placeholder="still climbing"></div>
      <div class="field"><label for="sd-cgph">Climb gph</label><input id="sd-cgph" class="big" data-sd="gph" value="${esc(ui.sd.gph)}" inputmode="decimal"></div>
    </div>
    <div class="mut small">Leave the length blank if you're still climbing and tap Level off when you level. Until then the plan assumes a ${dur(f.climbMin ?? f.cfg.burn.climbMin)} climb.</div>
    <div id="sheetPreview"></div>
    <label class="check"><input type="checkbox" data-sd="rebuild" ${ui.sd.rebuild ? 'checked' : ''}>Rebuild rest of plan</label>
    <button class="btn primary block" data-act="saveClimb">Save climb</button>`];
}

function sheetLevel(f) {
  return ['Level off', `${timeField('sd-at', 'Leveled at')}
    <div id="sheetPreview"></div>
    <label class="check"><input type="checkbox" data-sd="rebuild" ${ui.sd.rebuild ? 'checked' : ''}>Rebuild rest of plan</label>
    <button class="btn primary block" data-act="saveLevel">Save</button>`];
}

function sheetShutdown(f) {
  return ['Shut down', `${timeField('sd-at', 'Shutdown time', ui.sd.at)}
    <div class="field"><label for="sd-used">GI 275 total fuel used (optional)</label><input id="sd-used" class="big" data-sd="used" value="${esc(ui.sd.used)}" inputmode="decimal"></div>
    <div class="mut small">Saves the flight to the log with planned vs actual numbers and resets for the next flight.</div>
    <button class="btn primary block" data-act="saveShutdown">Save flight</button>`];
}

// The moment the sheet's time field refers to. On the start sheet that is the takeoff time.
function sheetTime() {
  const f = activeFlight();
  const tm = ui.sd.tmode;
  if (ui.sheet === 'start') {
    if (tm === 'timer') {
      const d = P.parseDur(ui.sd.at);
      return isFinite(d) ? (ui.sd.atStamp || now()) - d * MIN : NaN;
    }
    const t = P.parseClock(ui.sd.at, now());
    return isFinite(t) && t <= now() + MIN ? t : NaN;
  }
  let t;
  if (tm === 'timer' && takeoffOf(f)) {
    const d = P.parseDur(ui.sd.at);
    t = isFinite(d) ? takeoffOf(f) + d * MIN : NaN;
  } else t = P.parseClock(ui.sd.at, now());
  if (!isFinite(t)) return NaN;
  if (f.engineStart && t < f.engineStart) return NaN;
  if (t > now() + 2 * MIN) return NaN;
  return t;
}

function sheetFieldValue(ms) {
  const f = activeFlight();
  if (ui.sheet === 'start') return ui.sd.tmode === 'timer' ? dur(Math.max(0, (now() - ms) / MIN)) : hm(ms);
  return ui.sd.tmode === 'timer' ? dur(Math.max(0, timerAt(f, ms))) : hm(ms);
}

function renderSheetPreview() {
  const box = $('#sheetPreview');
  const f = activeFlight();
  if (!box || !f) return;
  const t = sheetTime();
  const other = $('#sdAtOther');
  if (!isFinite(t)) {
    if (other) other.textContent = '';
    box.innerHTML = ui.sd.at ? `<div class="issue warn">${ICON.warn}<div>${ui.sheet === 'start' ? 'Enter the flight timer (h:mm) or takeoff time.' : 'Enter a time between takeoff and now.'}</div></div>` : '';
    return;
  }
  if (other) other.innerHTML = ui.sheet === 'start'
    ? `Takeoff ${hm(t)} · ${zt(t)}`
    : ui.sd.tmode === 'timer' ? `${hm(t)} local · ${zt(t)}` : (takeoffOf(f) ? `timer ${fmtTimer(timerAt(f, t))} · ${zt(t)}` : zt(t));
  if (ui.sheet === 'start') {
    const engine = t - f.taxiMin * MIN;
    const sw = ui.sd.sofar === 'manual' ? manualSwitches(t, ui.sd.tank) : { list: plannedSwitchesBefore(f, engine, ui.sd.tank, now()) };
    if (sw.error) { box.innerHTML = `<div class="issue warn">${ICON.warn}<div>${esc(sw.error)}</div></div>`; return; }
    const lines = sw.list.map((x) => `<div class="kv"><span class="mut">Switch → ${esc(x.tank)}</span><span class="v">+${dur((x.at - t) / MIN)} · ${hm(x.at)}</span></div>`).join('');
    const cur = sw.list.length ? sw.list[sw.list.length - 1].tank : ui.sd.tank;
    const cl = P.parseDur(ui.sd.climb);
    const climbLine = isFinite(cl) ? `<div class="kv"><span class="mut">Climb ${dur(cl)} @ ${f1(f.climbGph || f.cfg.burn.climbGph)}</span><span class="v">level ${t + cl * MIN > now() ? 'expected ' : ''}+${dur(cl)}</span></div>` : '';
    box.innerHTML = `<div class="kv"><span class="mut">Taxi ${f.taxiMin} min on ${esc(ui.sd.tank)} from</span><span class="v">${hm(engine)}</span></div>${climbLine}${lines}
      <div class="kv"><span class="mut">On now</span><span class="v">${esc(cur)}</span></div>`;
    return;
  }
  if (ui.sheet === 'switch') {
    const p = ui.sd.planned;
    if (p && p.tank === ui.sd.tank) {
      const diff = Math.round((t - p.start) / MIN);
      box.innerHTML = `<div class="kv"><span class="mut">Plan said</span><span class="v">${esc(p.tank)} at ${fmtTimer(timerAt(f, p.start))} (${hm(p.start)})</span></div>
        <div class="kv"><span class="mut">Difference</span><span class="v" style="color:${Math.abs(diff) >= 2 ? 'var(--amber)' : 'var(--tx)'}">${diff >= 0 ? '+' : ''}${diff} min</span></div>`;
    } else box.innerHTML = p ? `<div class="kv"><span class="mut">Plan said</span><span class="v">${esc(p.tank)} at ${fmtTimer(timerAt(f, p.start))} — this is off plan</span></div>` : '';
  }
  if (ui.sheet === 'check') {
    const est = P.estimate(f, f.cfg, t);
    const u = num(ui.sd.used);
    box.innerHTML = `<div class="kv"><span class="mut">App estimate used</span><span class="v">${f1(est.used)}</span></div>` +
      (isFinite(u) ? `<div class="kv"><span class="mut">Correction</span><span class="v" style="color:${Math.abs(u - est.used) > 1 ? 'var(--amber)' : 'var(--tx)'}">${u - est.used >= 0 ? '+' : ''}${f1(u - est.used)} gal</span></div>
      <div class="kv"><span class="mut">Avg burn since start</span><span class="v">${f1(u / ((t - f.engineStart) / HOUR))} gph</span></div>` : '');
  }
  if (ui.sheet === 'ete') {
    const est = P.estimate(f, f.cfg, t);
    const ete = P.parseDur(ui.sd.ete);
    const fuel = num(ui.sd.fuel), gph = num(ui.sd.gph);
    const aboveFloors = f.cfg.tanks.reduce((a, x) => a + Math.max(0, est.levels[x.id] - f.cfg.rules.floor.gal), 0);
    let html = `<div class="kv"><span class="mut">Aboard (est.)</span><span class="v">${f1(est.total)} · ${f1(aboveFloors)} above floors</span></div>`;
    if (isFinite(ete) && ete > 0) {
      const rate = fuel > 0 ? fuel / (ete / 60) : gph > 0 ? gph : est.rate;
      const need = fuel > 0 ? fuel : (rate * ete) / 60;
      const alt = f.alt?.on && !ui.sd.divert ? num(ui.sd.altFuel) || 0 : 0;
      const req = P.reserveGal(f.cfg) + alt;
      const lands = est.total - need;
      const ok = lands >= req - P.TOL;
      const reach = !ok && rate > 0 ? t + ((est.total - req) / rate) * HOUR : null;
      const arr = t + ete * MIN;
      html += `<div class="issue ${ok ? 'info' : 'error'}" style="flex-direction:column;gap:4px">
        <div class="kv" style="width:100%"><b>${ok ? 'Makes it' : `${f1(req - lands)} gal short of reserve`}</b><span class="v">arr ${hm(arr)} <span class="z">${zt(arr)}</span></span></div>
        <div class="kv" style="width:100%"><span>Needs ${f1(need)} @ ${f1(rate)} gph · lands with</span><span class="v">${f1(lands)} = ${dur((lands / P.reserveGph(f.cfg)) * 60)}</span></div>
        ${reach ? `<div class="kv" style="width:100%"><span>Reserve reached</span><span class="v">${hm(reach)} · ${Math.round((arr - reach) / MIN)} min before arrival</span></div>` : ''}
      </div>`;
    }
    box.innerHTML = html;
    const dd = $('#eteDest'); if (dd) dd.textContent = ui.sd.divert ? ui.sd.ident || 'stop' : f.divert?.ident || f.to || 'destination';
  }
}

function saveSheet(kind) {
  const f = activeFlight();
  const t = sheetTime();
  if (!isFinite(t)) return toast('Check the time');
  const enteredAt = ui.sd.enteredAt || now();
  if (ui.sd.tmode) state.settings.timeMode = ui.sd.tmode;
  if (kind === 'start') {
    const takeoff = t;
    const sw = ui.sd.sofar === 'manual' ? manualSwitches(takeoff, ui.sd.tank) : null;
    if (sw && sw.error) return toast(sw.error);
    f.takeoff = takeoff; f.engineStart = takeoff - f.taxiMin * MIN; f.startTank = ui.sd.tank; f.status = 'active';
    if (f.plan.legs[0] && f.plan.legs[0].tank !== f.startTank) { f.plan.legs[0].tank = f.startTank; f.plan.source = 'edited'; }
    f.events.push({ type: 'engine', at: f.engineStart, enteredAt, tank: f.startTank, assumed: true });
    f.events.push({ type: 'takeoff', at: takeoff, enteredAt, by: ui.sd.tmode });
    const cl = P.parseDur(ui.sd.climb);
    if (isFinite(cl)) f.events.push({ type: 'climb', at: takeoff, until: takeoff + cl * MIN, gph: f.climbGph || f.cfg.burn.climbGph, enteredAt, initial: true });
    const list = sw ? sw.list : plannedSwitchesBefore(f, f.engineStart, f.startTank, now());
    const legs = planAbs(f);
    for (const x of list) {
      const pl = legs.find((l) => l.tank === x.tank && Math.abs(l.start - x.at) < 90 * MIN);
      f.events.push({ type: 'switch', tank: x.tank, at: x.at, enteredAt, catchup: sw ? 'manual' : 'plan', planned: pl ? { tank: pl.tank, at: pl.start } : null });
    }
    const used = num(ui.sd.used);
    if (isFinite(used)) f.events.push({ type: 'check', at: now(), enteredAt, used });
    if (sw || isFinite(used) || (isFinite(cl) && Math.abs(cl - (f.climbMin ?? 0)) > 0.5)) rebuildFrom(f, now(), 'catch-up at start');
    // don't alert for switches already behind us
    for (const l of planAbs(f)) if (l.start <= now()) { ui.fired.add(`${f.id}:${Math.round(l.start / 1000)}:${l.tank}:pre`); ui.fired.add(`${f.id}:${Math.round(l.start / 1000)}:${l.tank}:due`); }
    unlockAudio();
    closeSheet(); persist(); go('fly'); return;
  }
  if (kind === 'switch') {
    if (!ui.sd.tank) return toast('Pick a tank');
    f.events.push({ type: 'switch', tank: ui.sd.tank, at: t, enteredAt, planned: ui.sd.planned ? { tank: ui.sd.planned.tank, at: ui.sd.planned.start } : null });
    if (ui.sd.rebuild) rebuildFrom(f, Math.max(t, now()), 'after switch');
  }
  if (kind === 'check') {
    const u = num(ui.sd.used);
    if (!isFinite(u)) return toast('Enter fuel used');
    f.events.push({ type: 'check', at: t, enteredAt, used: u, gph: num(ui.sd.gph) || null });
    if (ui.sd.rebuild) rebuildFrom(f, Math.max(t, now()), 'after fuel check');
  }
  if (kind === 'ete') {
    const ete = P.parseDur(ui.sd.ete);
    if (!isFinite(ete) || ete <= 0) return toast('Enter ETE');
    const ev = { type: 'ete', at: t, enteredAt, eteMin: ete, fuelToDest: num(ui.sd.fuel) || null, gph: num(ui.sd.gph) || null, altFuel: num(ui.sd.altFuel) || null };
    if (ui.sd.divert) { ev.divert = (ui.sd.ident || 'STOP').toUpperCase(); f.divert = { ident: ev.divert, at: t }; ev.altFuel = 0; if (f.alt) f.alt.onBeforeDivert = f.alt.on; if (f.alt) f.alt.on = false; }
    if (!ev.fuelToDest && !ev.gph) ev.gph = P.estimate(f, f.cfg, t).rate;
    f.events.push(ev);
    rebuildFrom(f, Math.max(t, now()), ui.sd.divert ? 'divert' : 'ETE update');
  }
  if (kind === 'climb') {
    const len = P.parseDur(ui.sd.len), gph = num(ui.sd.gph);
    f.events.push({ type: 'climb', at: t, enteredAt, gph: gph > 0 ? gph : f.climbGph || f.cfg.burn.climbGph, until: isFinite(len) && len > 0 ? t + len * MIN : null });
    if (ui.sd.rebuild) rebuildFrom(f, Math.max(t, now()), 'climb');
  }
  if (kind === 'level') {
    f.events.push({ type: 'level', at: t, enteredAt });
    if (ui.sd.rebuild) rebuildFrom(f, Math.max(t, now()), 'level off');
  }
  if (kind === 'shutdown') {
    f.shutdown = t; f.finalUsed = num(ui.sd.used) || null; f.status = 'closed';
    f.events.push({ type: 'shutdown', at: t, enteredAt, used: f.finalUsed });
    state.activeFlightId = null; ui.draft = null;
    closeSheet(); persist(); toast('Flight saved'); go('log', f.id); return;
  }
  ui.alert = null;
  closeSheet(); persist(); render();
}

// =====================================================================
// LOG
// =====================================================================
function flightSummary(f) {
  const plannedBlock = f.blockMin, plannedFuel = f.plannedFuel ?? f.totalFuel;
  const actualBlock = f.engineStart && f.shutdown ? (f.shutdown - f.engineStart) / MIN : null;
  const plannedFlight = f.eteMin;
  const actualFlight = takeoffOf(f) && f.shutdown ? (f.shutdown - takeoffOf(f)) / MIN : null;
  const checks = f.events.filter((e) => e.type === 'check');
  const actualFuel = f.finalUsed ?? null;
  const flightHrs = actualBlock ? Math.max(0.01, (actualBlock - f.taxiMin) / 60) : null;
  const actualGph = actualFuel && flightHrs ? (actualFuel - (f.taxiMin / 60) * f.cfg.burn.ground) / flightHrs : (checks.length ? checks[checks.length - 1].gph : null);
  return { plannedBlock, plannedFuel, actualBlock, actualFuel, actualGph, plannedGph: f.cruiseGph, plannedFlight, actualFlight };
}

function viewLog() {
  if (ui.sub && state.flights[ui.sub]) return viewFlightDetail(state.flights[ui.sub]);
  const flights = Object.values(state.flights).sort((a, b) => (b.engineStart || b.createdAt) - (a.engineStart || a.createdAt));
  const closed = flights.filter((f) => f.status === 'closed' && f.shutdown && f.engineStart);
  const withFuel = closed.filter((f) => f.finalUsed);
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const tErr = avg(closed.map((f) => (f.shutdown - takeoffOf(f)) / MIN - f.eteMin));
  const fErr = avg(withFuel.map((f) => f.finalUsed - (f.plannedFuel ?? f.totalFuel)));
  const fPct = avg(withFuel.map((f) => (f.finalUsed / (f.plannedFuel ?? f.totalFuel) - 1) * 100));
  return `<div class="top"><div><div class="kicker">Log</div><h1>Flights</h1></div></div>
  <div class="stack">
    ${closed.length ? `<div class="card"><h2>You vs ForeFlight (${closed.length} flight${closed.length > 1 ? 's' : ''})</h2>
      <div class="kv"><span class="mut">Avg flight time vs ETE</span><span class="v">${tErr == null ? '—' : (tErr >= 0 ? '+' : '') + Math.round(tErr) + ' min'}</span></div>
      <div class="kv"><span class="mut">Avg fuel error (GI 275)</span><span class="v">${fErr == null ? '—' : `${fErr >= 0 ? '+' : ''}${f1(fErr)} gal (${fPct >= 0 ? '+' : ''}${f1(fPct)}%)`}</span></div>
      <div class="mut small">Positive = took longer / burned more than ForeFlight planned. Enter GI 275 fuel used at shutdown to fill in fuel.</div></div>` : ''}
    <div class="list">${flights.length ? flights.map((f) => `<a class="item" href="#log/${f.id}"><div><div class="t">${flightTitle(f)}</div><div class="s">${fmtDate(f.engineStart || f.createdAt)} · ${esc(f.tail)} · ${f.status === 'active' ? 'in progress' : f.status === 'draft' ? 'planned' : f.autoSaved ? 'auto-saved' : 'closed'}</div></div>
      <span class="mono ${f.id === state.activeFlightId ? '' : 'mut'}" style="color:${f.id === state.activeFlightId ? 'var(--amber)' : ''}">${f.id === state.activeFlightId ? 'active' : f1(f.finalUsed ?? f.plannedFuel) + ' gal'}</span></a>`).join('') : '<div class="card empty">No flights yet.</div>'}</div>
    <div class="card"><h2>Backup</h2><div class="mut small">Everything is stored only on this phone. Export a backup to keep a copy or move to a new phone.</div>
      <div class="row"><button class="btn grow" data-act="exportAll">Export backup</button><label class="btn grow" for="importFile">Import</label><input type="file" id="importFile" accept="application/json,.json" class="hidden"></div></div>
  </div>`;
}

function viewFlightDetail(f) {
  const s = flightSummary(f);
  const evName = (e) => ({ engine: `Taxi on ${e.tank}${e.assumed ? ` (${f.taxiMin} min)` : ''}`, takeoff: 'Takeoff', climb: `Climb @ ${f1(e.gph)}${e.until ? ` for ${dur((e.until - e.at) / MIN)}` : ''}`, level: 'Level off', switch: `Switch → ${e.tank}${e.catchup ? ' (catch-up)' : ''}`, check: `Fuel check · used ${f1(e.used)}`, ete: `ETE ${dur(e.eteMin)}${e.divert ? ' → ' + e.divert : ''}`, shutdown: 'Shutdown' }[e.type] || e.type);
  const evs = [...f.events].sort((a, b) => a.at - b.at);
  return `<div class="top"><div><div class="kicker"><a href="#log">Log</a> · ${fmtDate(f.engineStart || f.createdAt)} · ${esc(f.tail)}</div><h1>${flightTitle(f)}</h1></div>${f.autoSaved ? '<span class="badge">auto-saved</span>' : ''}</div>
  <div class="stack">
    <div class="card"><div class="evrow head" style="padding:0;grid-template-columns:1.4fr 1fr 1fr"><span>ForeFlight vs actual</span><span>Plan</span><span>Actual</span></div>
      <div class="evrow" style="padding:0;grid-template-columns:1.4fr 1fr 1fr;border:none"><span>Flight time</span><span>${dur(s.plannedFlight)}</span><span>${s.actualFlight ? dur(s.actualFlight) : '—'}</span></div>
      <div class="evrow" style="padding:0;grid-template-columns:1.4fr 1fr 1fr;border:none"><span>Fuel</span><span>${f1(s.plannedFuel)}</span><span>${f1(s.actualFuel)}</span></div>
      <div class="evrow" style="padding:0;grid-template-columns:1.4fr 1fr 1fr;border:none"><span>Cruise gph</span><span>${f1(s.plannedGph)}</span><span>${f1(s.actualGph)}</span></div>
      ${f.divert ? `<div class="mut small">Planned ${esc(f.to)}; diverted to ${esc(f.divert.ident)} at ${hm(f.divert.at)}.</div>` : ''}
    </div>
    <div class="legs"><div class="evrow head"><span>Event</span><span>Plan</span><span>Actual</span><span>Entered</span></div><div class="mut small" style="padding:6px 12px">Plan and actual are flight timer; entered is local clock.</div>
      ${evs.length ? evs.map((e) => `<div class="evrow"><span>${esc(evName(e))}</span><span class="mut">${e.planned ? fmtTimer(timerAt(f, e.planned.at)) : '—'}</span><span style="color:${e.planned && Math.abs(e.at - e.planned.at) >= 2 * MIN ? 'var(--amber)' : ''}">${fmtTimer(timerAt(f, e.at))}</span><span class="mut">${e.enteredAt ? hm(e.enteredAt) : '—'}</span></div>`).join('') : '<div class="empty">No events yet.</div>'}
    </div>
    <div class="mut small">${f.planHistory?.length || 0} plan version${f.planHistory?.length === 1 ? '' : 's'} saved. Plan edits never count as actual events.</div>
    <div class="row"><button class="btn grow" data-act="exportCsv" data-id="${f.id}">Export CSV</button>${f.id === state.activeFlightId ? '' : `<button class="btn danger grow" data-act="deleteFlight" data-id="${f.id}">Delete</button>`}</div>
    ${f.status === 'draft' && f.id !== state.activeFlightId ? `<button class="btn outline" data-act="reopen" data-id="${f.id}">Make this the current flight</button>` : ''}
  </div>`;
}

function download(name, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function flightCsv(f) {
  const rows = [['kind', 'event', 'tank', 'planned_timer', 'actual_timer', 'actual_utc', 'entered_local', 'value']];
  for (const e of [...f.events].sort((a, b) => a.at - b.at)) {
    rows.push(['event', e.type, e.tank || e.divert || '', e.planned ? fmtTimer(timerAt(f, e.planned.at)) : '', fmtTimer(timerAt(f, e.at)), new Date(e.at).toISOString(), e.enteredAt ? hm(e.enteredAt) : '', e.used ?? e.eteMin ?? '']);
  }
  let t = f.plan.startMin;
  for (const l of f.plan.legs) { rows.push(['plan', 'leg', l.tank, fmtTimer(t - f.taxiMin), '', '', '', Math.round(l.min)]); t += l.min; }
  const s = flightSummary(f);
  rows.push(['summary', 'planned_flight_min', '', '', '', '', '', s.plannedFlight]);
  rows.push(['summary', 'actual_flight_min', '', '', '', '', '', s.actualFlight ? Math.round(s.actualFlight) : '']);
  rows.push(['summary', 'planned_block_min', '', '', '', '', '', s.plannedBlock]);
  rows.push(['summary', 'actual_block_min', '', '', '', '', '', s.actualBlock ? Math.round(s.actualBlock) : '']);
  rows.push(['summary', 'planned_fuel', '', '', '', '', '', f1(s.plannedFuel)]);
  rows.push(['summary', 'actual_fuel', '', '', '', '', '', s.actualFuel ?? '']);
  return rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
}

// =====================================================================
// AIRCRAFT
// =====================================================================
const OVR_FIELDS = [
  ['Burn profiles', [
    ['burn.ground', 'Ground gph (incl. run-up)'], ['burn.climbGph', 'Climb gph'], ['burn.climbMin', 'Climb minutes'],
    ['burn.cruise', 'Typical cruise gph'], ['burn.base', 'Base cruise gph (reserve)']]],
  ['Reserve', [
    ['rules.reserve.min', 'Reserve minutes'], ['rules.reserve.rate', 'Reserve rate', ['base', 'cruise', 'custom']],
    ['rules.reserve.customGph', 'Custom reserve gph'], ['rules.reserve.mode', 'Reserve rule', ['hard', 'warn', 'off']]]],
  ['Tank rules', [
    ['rules.floor.gal', 'Tank floor gal'], ['rules.floor.mode', 'Floor rule', ['hard', 'warn']],
    ['rules.imbalance.gal', 'Max imbalance gal'], ['rules.imbalance.mode', 'Imbalance rule', ['warn', 'hard', 'off']],
    ['rules.switchMargin', 'Switch margin gal'], ['rules.minLegMin', 'Shortest normal leg min'], ['rules.landBalanced', 'Land balanced', ['true', 'false']]]],
  ['Alerts & app', [
    ['alerts.preMin', 'Alert minutes before switch'], ['alerts.sound', 'Sound', ['true', 'false']], ['alerts.vibrate', 'Vibrate', ['true', 'false']], ['idleHours', 'Auto-save after idle hours']]]
];
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);

function viewAircraft() {
  if (ui.sub && ui.sub.startsWith('type-')) return viewTypeEditor(ui.sub.slice(5));
  if (ui.sub && state.tails[decodeURIComponent(ui.sub)]) return viewTail(state.tails[decodeURIComponent(ui.sub)]);
  const tails = Object.values(state.tails);
  return `<div class="top"><div><div class="kicker">Aircraft</div><h1>Tails &amp; types</h1></div></div>
  <div class="stack">
    <div class="list">${tails.length ? tails.map((t) => `<a class="item" href="#aircraft/${encodeURIComponent(t.tail)}"><div><div class="t mono">${esc(t.tail)}</div><div class="s">${esc(typeById(t.typeId)?.name || 'missing type')}${Object.keys(t.overrides || {}).length ? ' · overrides' : ''}</div></div><span class="mut">›</span></a>`).join('') : '<div class="card empty">No aircraft yet.</div>'}</div>
    <div class="card"><h2>Add aircraft</h2>${tailForm()}</div>
    <div class="card"><h2>Aircraft types</h2>
      <div class="mut small">Built-in types ship with the app. Copy one to make your own (e.g. a different tank layout).</div>
      <div class="list">${allTypes().map((t) => `<a class="item" href="#aircraft/type-${esc(t.id)}"><div><div class="t">${esc(t.name)}</div><div class="s">${t.builtin ? 'Built-in' : 'Custom (this phone)'} · ${t.tanks.length} tanks · ${t.tanks.reduce((a, x) => a + x.capacity, 0)} gal</div></div><span class="mut">›</span></a>`).join('')}</div>
      <label class="btn" for="importFile2">Import tail or type file</label><input type="file" id="importFile2" accept="application/json,.json" class="hidden">
    </div>
  </div>`;
}

function viewTail(tail) {
  const type = typeById(tail.typeId);
  if (!type) return `<div class="card">Type missing for ${esc(tail.tail)}.</div>`;
  const cfg = P.resolveConfig(type, tail);
  const ov = tail.overrides || {};
  const fld = ([path, label, opts]) => {
    const own = getPath(ov, path);
    const def = getPath(type, path);
    const id = 'ov-' + path.replace(/\./g, '-');
    const control = opts
      ? `<select id="${id}" data-ovr="${path}"><option value="">${esc(String(def))} (type)</option>${opts.map((o) => `<option ${String(own) === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`
      : `<input id="${id}" class="mono" data-ovr="${path}" value="${own ?? ''}" placeholder="${esc(String(def ?? ''))}" inputmode="decimal">`;
    return `<label for="${id}" class="${own != null ? '' : 'mut'}">${label}${own != null ? ' •' : ''}</label>${control}`;
  };
  return `<div class="top"><div><div class="kicker"><a href="#aircraft">Aircraft</a> · ${esc(type.name)}</div><h1 class="mono">${esc(tail.tail)}</h1></div></div>
  <div class="stack">
    <div class="mut small">Blank = use the type's value (shown grey). A • marks an override for this tail only. Changes apply to new plans; flights already planned keep their settings until rebuilt from Setup.</div>
    <div class="card"><h2>Tank capacities (usable gal)</h2><div class="ovr">${cfg.tanks.map((t) => `<label for="cap-${t.id}" class="${ov.capacities?.[t.id] ? '' : 'mut'}">${esc(t.name)} (${esc(t.id)})</label><input id="cap-${t.id}" class="mono" data-cap="${esc(t.id)}" value="${ov.capacities?.[t.id] ?? ''}" placeholder="${type.tanks.find((x) => x.id === t.id).capacity}" inputmode="decimal">`).join('')}</div></div>
    ${OVR_FIELDS.map(([title, fields]) => `<div class="card"><h2>${title}</h2><div class="ovr">${fields.map(fld).join('')}</div>${title === 'Reserve' ? `<div class="mut small">= ${f1(P.reserveGal(cfg))} gal (${dur(cfg.rules.reserve.min)} @ ${f1(P.reserveGph(cfg))} gph)</div>` : ''}</div>`).join('')}
    <div class="row"><button class="btn grow" data-act="exportTail" data-tail="${esc(tail.tail)}">Share tail setup</button><button class="btn danger grow" data-act="deleteTail" data-tail="${esc(tail.tail)}">Remove</button></div>
  </div>`;
}

function viewTypeEditor(id) {
  const t = typeById(id);
  if (!t) return '<div class="card empty">Type not found.</div>';
  const ro = t.builtin ? 'disabled' : '';
  return `<div class="top"><div><div class="kicker"><a href="#aircraft">Aircraft</a> · ${t.builtin ? 'Built-in type' : 'Custom type'}</div><h1>${esc(t.name)}</h1></div></div>
  <div class="stack">
    ${t.builtin ? `<div class="mut small">Built-in types can't be edited. Copy it to make a version you can change; per-tail tweaks (capacities, burn, rules) can also be done on the tail itself.</div>` : `<div class="field"><label for="ty-name">Name</label><input id="ty-name" data-ty="name" value="${esc(t.name)}"></div>`}
    <div class="card"><h2>Tanks (left to right)</h2>
      <div class="legs" style="border:none">
        <div class="legrow head" style="grid-template-columns:52px 1fr 52px 84px 56px 28px"><span>ID</span><span>Name</span><span>Side</span><span>Spot</span><span>Gal</span><span></span></div>
        ${t.tanks.map((k, i) => `<div class="legrow" style="grid-template-columns:52px 1fr 52px 84px 56px 28px">
          <input aria-label="Tank ${i + 1} id" data-tk="${i}.id" value="${esc(k.id)}" ${ro}>
          <input aria-label="Tank ${i + 1} name" data-tk="${i}.name" value="${esc(k.name)}" ${ro} style="font-family:var(--sans)">
          <select aria-label="Tank ${i + 1} side" data-tk="${i}.side" ${ro}>${['L', 'C', 'R'].map((s) => `<option ${k.side === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
          <select aria-label="Tank ${i + 1} spot" data-tk="${i}.spot" ${ro}>${['tip', 'outboard', 'inboard', 'center'].map((s) => `<option ${k.spot === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
          <input aria-label="Tank ${i + 1} gallons" data-tk="${i}.capacity" value="${k.capacity}" ${ro} inputmode="decimal">
          ${t.builtin ? '<span></span>' : `<button class="iconbtn" style="width:28px" data-act="delTank" data-i="${i}" aria-label="Remove tank">${ICON.del}</button>`}
        </div>`).join('')}
      </div>
      ${t.builtin ? '' : '<button class="btn sm" data-act="addTank">+ Add tank</button>'}
      ${t.tanks.map((k, i) => `<label class="check"><input type="checkbox" data-tk="${i}.takeoffLanding" ${k.takeoffLanding !== false ? 'checked' : ''} ${ro}>${esc(k.id)} approved for takeoff &amp; landing</label>`).join('')}
    </div>
    <div class="card"><h2>Switching pattern</h2>
      <div class="field"><label for="ty-groups">Burn order: pairs left/right, first used first</label><input id="ty-groups" class="mono" data-ty="groups" value="${esc(t.groups.map((g) => `${g.left}/${g.right}`).join(', '))}" ${ro}></div>
      <div class="grid2">
        <div class="field"><label for="ty-start">Start on</label><select id="ty-start" data-ty="startTank" ${ro}>${t.tanks.map((k) => `<option ${t.startTank === k.id ? 'selected' : ''}>${esc(k.id)}</option>`).join('')}</select></div>
        <div class="field"><label for="ty-finish">Finish each group on</label><select id="ty-finish" data-ty="finishSide" ${ro}>${['R', 'L'].map((s) => `<option value="${s}" ${t.finishSide === s ? 'selected' : ''}>${s === 'R' ? 'Right' : 'Left'}</option>`).join('')}</select></div>
      </div>
    </div>
    <div class="row"><button class="btn grow" data-act="copyType" data-id="${esc(t.id)}">Copy as custom</button>
      ${t.builtin ? '' : `<button class="btn grow" data-act="exportType" data-id="${esc(t.id)}">Share type</button><button class="btn danger grow" data-act="deleteType" data-id="${esc(t.id)}">Delete</button>`}</div>
  </div>`;
}

function setOverride(tailId, path, raw) {
  const tail = state.tails[tailId];
  tail.overrides = tail.overrides || {};
  const ks = path.split('.');
  let o = tail.overrides;
  for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]] = o[ks[i]] || {};
  const k = ks[ks.length - 1];
  if (raw === '' || raw == null) delete o[k];
  else if (raw === 'true' || raw === 'false') o[k] = raw === 'true';
  else if (isFinite(num(raw)) && !['mode', 'rate'].includes(k)) o[k] = num(raw);
  else o[k] = raw;
  // prune empty objects
  const prune = (x) => { for (const key of Object.keys(x)) { if (x[key] && typeof x[key] === 'object') { prune(x[key]); if (!Object.keys(x[key]).length) delete x[key]; } } };
  prune(tail.overrides);
  persist();
}

function updateType(id, fn) {
  const t = state.customTypes[id];
  if (!t) return;
  fn(t);
  persist();
}

// =====================================================================
// EVENTS
// =====================================================================
const actions = {
  addTail() {
    const tail = ($('#nt-tail').value || '').trim().toUpperCase();
    const typeId = $('#nt-type').value;
    if (!tail) return toast('Enter a tail number');
    if (state.tails[tail]) return toast(`${tail} already exists`);
    state.tails[tail] = { tail, typeId, overrides: {} };
    state.settings.lastTail = tail;
    ui.draft = null;
    persist();
    toast(`${tail} added`);
    render();
  },
  allFull() {
    const cfg = cfgForTail(ui.draft.tail);
    for (const t of cfg.tanks) ui.draft.levels[t.id] = String(t.capacity);
    render();
  },
  buildPlan: buildPlanFromDraft,
  discardDraft() {
    const f = activeFlight();
    if (!f || f.status !== 'draft') return;
    ask('Discard this planned flight?', 'Discard', () => {
      delete state.flights[f.id];
      state.activeFlightId = null; ui.draft = null;
      persist(); render();
    });
  },
  regen() {
    const f = activeFlight();
    if (f.status === 'active') rebuildFrom(f, now(), 'manual rebuild');
    else { savePlanHistory(f, 'regenerate'); f.plan = generateFor(f, { startMin: 0, endMin: f.blockMin, segs: f.segs, levels: f.startLevels }); f.plan.source = 'generated'; }
    persist(); render();
  },
  addLeg() {
    const f = activeFlight();
    const last = f.plan.legs[f.plan.legs.length - 1];
    if (f.plan.source !== 'edited') savePlanHistory(f, 'before edit');
    f.plan.legs.push({ tank: last ? last.tank : f.cfg.startTank, min: 20 });
    f.plan.source = 'edited';
    persist(); render();
  },
  delLeg(el) {
    const f = activeFlight();
    if (f.plan.legs.length <= 1) return;
    if (f.plan.source !== 'edited') savePlanHistory(f, 'before edit');
    f.plan.legs.splice(+el.dataset.i, 1);
    f.plan.source = 'edited';
    persist(); render();
  },
  openSheet(el) { openSheet(el.dataset.sheet); },
  closeSheet,
  confirmYes() { const fn = ui.sd.fn; closeSheet(); if (fn) fn(); },
  scrim(el, ev) { if (ev.target === el) closeSheet(); },
  sdTank(el) { ui.sd.tank = el.dataset.tank; renderSheet(); },
  sdNow() { ui.sd.at = sheetFieldValue(now()); ui.sd.atStamp = now(); $('#sd-at').value = ui.sd.at; renderSheetPreview(); },
  sdMinus() {
    const t = sheetTime();
    if (isFinite(t)) { ui.sd.at = sheetFieldValue(t - MIN); $('#sd-at').value = ui.sd.at; renderSheetPreview(); }
  },
  stampEntered() { ui.sd.enteredAt = now(); const e = $('#sdEntered'); if (e) e.innerHTML = tz(ui.sd.enteredAt); },
  saveStart: () => saveSheet('start'),
  saveClimb: () => saveSheet('climb'),
  saveLevel: () => saveSheet('level'),
  sdTmode() {
    const t = sheetTime();
    ui.sd.tmode = ui.sd.tmode === 'timer' ? 'clock' : 'timer';
    ui.sd.at = isFinite(t) ? sheetFieldValue(t) : '';
    ui.sd.atStamp = now();
    renderSheet();
  },
  sdSofar(el) {
    ui.sd.sofar = el.dataset.v;
    if (ui.sd.sofar === 'manual' && !(ui.sd.rows || []).length) {
      const t = sheetTime();
      if (isFinite(t)) ui.sd.rows = plannedSwitchesBefore(activeFlight(), t - activeFlight().taxiMin * MIN, ui.sd.tank, now()).map((x) => ({ tank: x.tank, at: dur((x.at - t) / MIN) }));
    }
    renderSheet();
  },
  addRow() {
    const f = activeFlight();
    const rows = ui.sd.rows || (ui.sd.rows = []);
    const prev = rows.length ? rows[rows.length - 1].tank : ui.sd.tank;
    const order = f.cfg.groups.flatMap((g) => [g.left, g.right]);
    const next = order[(order.indexOf(prev) + 1) % order.length] || f.cfg.tanks.find((t) => t.id !== prev).id;
    rows.push({ tank: next, at: '' });
    renderSheet();
  },
  delRow(el) { ui.sd.rows.splice(+el.dataset.i, 1); renderSheet(); },
  toggleFlyMode() {
    state.settings.timeMode = timeMode() === 'timer' ? 'clock' : 'timer';
    persist(); render();
  },
  saveSwitch: () => saveSheet('switch'),
  saveCheck: () => saveSheet('check'),
  saveEte: () => saveSheet('ete'),
  saveShutdown: () => saveSheet('shutdown'),
  liveTime() { ui.viewTime = null; render(); },
  alertSwitch() { const a = ui.alert; ui.alert = null; renderAlert(); go('fly'); openSheet('switch', { tank: a?.tank }); },
  alertDismiss() { ui.alert = null; renderAlert(); },
  exportAll() {
    const data = { kind: 'backup', app: APP_NAME, exportedAt: new Date().toISOString(), tails: state.tails, customTypes: state.customTypes, flights: state.flights };
    download(`${APP_NAME.toLowerCase()}-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 1), 'application/json');
  },
  exportCsv(el) { const f = state.flights[el.dataset.id]; download(`${f.from || 'flight'}-${f.to || ''}-${new Date(f.engineStart || f.createdAt).toISOString().slice(0, 10)}.csv`, flightCsv(f), 'text/csv'); },
  deleteFlight(el) { const id = el.dataset.id; ask('Delete this flight from the log?', 'Delete', () => { delete state.flights[id]; persist(); go('log'); }); },
  reopen(el) {
    const cur = activeFlight();
    if (cur && cur.status === 'active') return toast('A flight is in progress');
    if (cur && cur.status === 'draft') cur.status = 'saved';
    const f = state.flights[el.dataset.id]; f.status = 'draft'; state.activeFlightId = f.id; ui.draft = null; persist(); go('plan');
  },
  exportTail(el) {
    const tail = state.tails[el.dataset.tail];
    download(`${tail.tail}.json`, JSON.stringify({ kind: 'tail', app: APP_NAME, tail, type: typeById(tail.typeId) }, null, 1), 'application/json');
  },
  deleteTail(el) {
    const id = el.dataset.tail;
    if (Object.values(state.flights).some((f) => f.tail === id && f.id === state.activeFlightId)) return toast('That aircraft has the current flight');
    ask(`Remove ${id}? Saved flights stay in the log.`, 'Remove', () => { delete state.tails[id]; persist(); go('aircraft'); });
  },
  copyType(el) {
    const src = typeById(el.dataset.id);
    const t = JSON.parse(JSON.stringify(src));
    t.id = 'c-' + uid(); t.builtin = false; t.name = src.name + ' (custom)';
    state.customTypes[t.id] = t; persist(); go('aircraft', 'type-' + t.id);
  },
  exportType(el) { const t = typeById(el.dataset.id); download(`${t.name.replace(/\W+/g, '-')}.json`, JSON.stringify({ kind: 'type', app: APP_NAME, type: t }, null, 1), 'application/json'); },
  deleteType(el) {
    const id = el.dataset.id;
    if (Object.values(state.tails).some((t) => t.typeId === id)) return toast('A tail still uses this type');
    ask('Delete this custom type?', 'Delete', () => { delete state.customTypes[id]; persist(); go('aircraft'); });
  },
  addTank() {
    const id = ui.sub.slice(5);
    updateType(id, (t) => t.tanks.push({ id: 'T' + (t.tanks.length + 1), name: 'New tank', side: 'C', spot: 'center', capacity: 10, takeoffLanding: true }));
    render();
  },
  delTank(el) {
    const id = ui.sub.slice(5);
    updateType(id, (t) => {
      const [gone] = t.tanks.splice(+el.dataset.i, 1);
      t.groups = t.groups.filter((g) => g.left !== gone.id && g.right !== gone.id);
      if (t.startTank === gone.id) t.startTank = t.tanks[0]?.id;
    });
    render();
  }
};

document.addEventListener('click', (ev) => {
  unlockAudio();
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  if (el.dataset.act === 'scrim' && ev.target !== el) return; // clicks inside a sheet
  const fn = actions[el.dataset.act];
  if (fn) { ev.preventDefault(); fn(el, ev); }
});

document.addEventListener('pointerdown', markInput, { passive: true });
document.addEventListener('keydown', markInput, { passive: true });

// Fill "433" -> "4:33", "1548" -> "15:48" from the right, so no colon key is needed.
export function autoColon(v) {
  let d = String(v).replace(/\D/g, '').slice(0, 4).replace(/^0+(?=\d)/, '');
  if (!d) return '';
  d = d.padStart(3, '0');
  return `${+d.slice(0, -2)}:${d.slice(-2)}`;
}

function onField(ev, committed) {
  const el = ev.target;
  if (el.dataset.fmt === 'hm' && !committed) {
    el.value = autoColon(el.value);
    try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) { /* ignore */ }
  }
  if (el.dataset.d !== undefined && ui.draft) {
    const v = el.type === 'checkbox' ? el.checked : el.value;
    setPath(ui.draft, el.dataset.d, v);
    if (el.dataset.d === 'tail') { const nt = el.value; ui.draft = { ...defaultDraft(), ...ui.draft, tail: nt, levels: Object.fromEntries(cfgForTail(nt).tanks.map((t) => [t.id, String(t.capacity)])) }; render(); return; }
    if (el.dataset.d === 'alt.on') $('#altFields')?.classList.toggle('hidden', !el.checked);
    state.settings.draft = activeFlight() ? null : ui.draft;
    renderSetupCalc();
    if (committed) persist();
    return;
  }
  if (el.dataset.row !== undefined) {
    const [i, k] = el.dataset.row.split('.');
    if (ui.sd.rows && ui.sd.rows[+i]) ui.sd.rows[+i][k] = el.value;
    renderSheetPreview();
    return;
  }
  if (el.dataset.sd !== undefined) {
    ui.sd[el.dataset.sd] = el.type === 'checkbox' ? el.checked : el.value;
    if (el.dataset.sd === 'at') ui.sd.atStamp = now();
    if (el.dataset.sd === 'divert') $('#divIdent')?.classList.toggle('hidden', !el.checked);
    renderSheetPreview();
    return;
  }
  if (!committed) return;
  if (el.dataset.legTank !== undefined) return editLeg(+el.dataset.legTank, 'tank', el.value);
  if (el.dataset.legMin !== undefined) return editLeg(+el.dataset.legMin, 'min', el.value);
  if (el.id === 'flyTime') {
    const f = activeFlight();
    let t;
    if (flyMode(f) === 'timer') { const d = P.parseDur(el.value); t = isFinite(d) ? takeoffOf(f) + d * MIN : NaN; }
    else t = P.parseClock(el.value, now());
    if (!isFinite(t)) { toast(flyMode(f) === 'timer' ? 'Enter the flight timer as h:mm' : 'Enter the time as HH:MM'); return; }
    ui.viewTime = Math.abs(t - now()) < MIN ? null : t;
    render();
    return;
  }
  if (el.dataset.ovr) { setOverride(decodeURIComponent(ui.sub), el.dataset.ovr, el.value.trim()); render(); return; }
  if (el.dataset.cap) {
    const tail = state.tails[decodeURIComponent(ui.sub)];
    tail.overrides = tail.overrides || {};
    tail.overrides.capacities = tail.overrides.capacities || {};
    const v = num(el.value);
    if (isFinite(v) && v > 0) tail.overrides.capacities[el.dataset.cap] = v; else delete tail.overrides.capacities[el.dataset.cap];
    if (!Object.keys(tail.overrides.capacities).length) delete tail.overrides.capacities;
    persist(); render(); return;
  }
  if (el.dataset.tk) {
    const id = ui.sub.slice(5);
    const [i, k] = el.dataset.tk.split('.');
    updateType(id, (t) => {
      const tank = t.tanks[+i];
      const old = tank.id;
      let v = el.type === 'checkbox' ? el.checked : el.value;
      if (k === 'capacity') v = num(v) || tank.capacity;
      if (k === 'id') { v = String(v).trim().toUpperCase() || old; t.groups.forEach((g) => { if (g.left === old) g.left = v; if (g.right === old) g.right = v; }); if (t.startTank === old) t.startTank = v; }
      tank[k] = v;
    });
    render(); return;
  }
  if (el.dataset.ty) {
    const id = ui.sub.slice(5);
    updateType(id, (t) => {
      if (el.dataset.ty === 'groups') {
        const ids = new Set(t.tanks.map((k) => k.id));
        const groups = el.value.split(',').map((s) => s.trim().toUpperCase().split('/')).filter((p) => p.length === 2 && ids.has(p[0]) && ids.has(p[1])).map(([l, r]) => ({ left: l, right: r }));
        if (groups.length) t.groups = groups; else toast('Use pairs like LM/RM, LT/RT');
      } else t[el.dataset.ty] = el.value;
    });
    render(); return;
  }
}
document.addEventListener('input', (ev) => onField(ev, false));
document.addEventListener('change', (ev) => {
  if (ev.target.type === 'file') return importFile(ev.target);
  onField(ev, true);
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && ev.target.id === 'flyTime') ev.target.blur();
  if (ev.key === 'Escape' && ui.sheet) closeSheet();
});

async function importFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const { state: next, summary } = S.mergeImport(state, data);
    state = next; persist(); toast(`Imported ${summary}`); render();
  } catch (e) { toast('Import failed: ' + e.message); }
  input.value = '';
}

window.addEventListener('hashchange', () => { readHash(); render(); });
document.addEventListener('visibilitychange', () => {
  const f = activeFlight();
  if (document.visibilityState === 'visible') { if (checkIdle()) return; keepAwake(!!(f && f.status === 'active' && ui.route === 'fly')); render(); }
});

// ---------- tick ----------
setInterval(() => {
  if (checkIdle()) return;
  checkAlerts();
  if (ui.route === 'fly' && !ui.viewTime && document.activeElement?.id !== 'flyTime') {
    const ft = $('#flyTime'); if (ft) ft.value = flyTimeValue(activeFlight());
    renderFlyLive();
  } else if (ui.route === 'fly') renderFlyLive();
  if (ui.alert) renderAlert();
}, 5000);

// ---------- boot ----------
document.title = APP_NAME;
readHash();
if (!checkIdle()) render();
S.requestPersistence();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

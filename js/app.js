import { BUILTIN_TYPES } from './types.js';
import * as P from './planner.js';
import * as S from './store.js';
import { loadGuide } from './guide.js';

export const APP_NAME = 'Burnplan';
export const APP_VERSION = 'v38'; // keep in step with VERSION in sw.js
// Filled in by the deploy workflow with the commit and time; 'dev' when run locally.
export const APP_BUILD = '__BUILD__';
const MIN = 60000;
const HOUR = 3600000;

let state = S.load();
// One-time tidy-up: a fuel check with a fuel flow used to save a second "cruise burn" entry.
for (const f of Object.values(state.flights || {})) {
  if (!f.events) continue;
  const extra = f.events.filter((e) => e.type === 'burn' && e.fromCheck);
  for (const b of extra) {
    const c = f.events.find((e) => e.type === 'check' && Math.abs(e.at - b.at) < 1000);
    if (c) { c.gph = b.gph; c.setsBurn = true; f.events.splice(f.events.indexOf(b), 1); }
  }
}
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
// ---- time zones -----------------------------------------------------------
// Every moment is stored as an absolute time. Clock times are shown and typed in the flight's own
// zone (where it departed), so a phone changing zones mid-flight or later changes nothing.
// "Zulu" clock mode shows and reads clock times in UTC instead; Zulu or local is always shown alongside.
const phoneTZ = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } };
const dtfCache = {};
function partsIn(ms, zone) {
  const f = dtfCache[zone] || (dtfCache[zone] = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  const o = {};
  for (const p of f.formatToParts(ms)) if (p.type !== 'literal') o[p.type] = +p.value;
  if (o.hour === 24) o.hour = 0;
  return o;
}
function offsetMs(zone, ms) {
  const p = partsIn(ms, zone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}
function zoneAbbr(zone, ms = Date.now()) {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).formatToParts(ms).find((p) => p.type === 'timeZoneName').value; } catch (e) { return zone; }
}
const clockMode = () => state.settings.clockMode || 'local';
// Zone used for clock times right now: the flight being viewed, else the phone's.
function viewZone() {
  let f = null;
  if (ui.sheet && ui.sd && ui.sd.fid) f = state.flights[ui.sd.fid];
  else if (ui.route === 'log' && ui.sub && state.flights[ui.sub]) f = state.flights[ui.sub];
  else f = state.activeFlightId ? state.flights[state.activeFlightId] : null;
  return (f && f.tz) || phoneTZ();
}
const localHM = (ms, zone = viewZone()) => { const p = partsIn(ms, zone); return `${pad(p.hour)}:${pad(p.minute)}`; };
const utcHM = (ms) => { const d = new Date(ms); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`; };
// hm = the primary clock (flight-local or Zulu), zt = the other one, labeled.
const hm = (ms) => (clockMode() === 'zulu' ? utcHM(ms) : localHM(ms));
const zt = (ms) => (clockMode() === 'zulu' ? `${localHM(ms)} ${zoneAbbr(viewZone(), ms)}` : utcHM(ms));
const tz = (ms) => `${hm(ms)} <span class="z">${zt(ms)}</span>`;
const clockLabel = (ms = Date.now()) => (clockMode() === 'zulu' ? 'Zulu' : zoneAbbr(viewZone(), ms));
// Read "15:48" in the clock in use, picking the day nearest refMs.
function parseClockZ(str, refMs) {
  const m = String(str || '').trim().match(/^(\d{1,2}):?(\d{2})Z?$/i);
  if (!m) return NaN;
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return NaN;
  const zone = clockMode() === 'zulu' ? 'UTC' : viewZone();
  const p = partsIn(refMs, zone);
  let t = Date.UTC(p.year, p.month - 1, p.day, h, mi) - offsetMs(zone, refMs);
  t = Date.UTC(p.year, p.month - 1, p.day, h, mi) - offsetMs(zone, t); // settle DST edges
  const day = 864e5;
  while (t - refMs > day / 2) t -= day;
  while (refMs - t > day / 2) t += day;
  return t;
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : NaN; };
const dur = P.fmtDur;
// Flight timer readings in input fields: h:mm:ss, matching the panel timer.
const durS = (min) => { if (!isFinite(min)) return ''; const t = Math.max(0, Math.round(min * 60)); return `${Math.floor(t / 3600)}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}`; };
const now = () => Date.now();
const fmtDate = (ms, zone) => { try { return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: zone || viewZone() }); } catch (e) { return new Date(ms).toLocaleDateString(); } };

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
// One distinct color per tank: left = cool (main blue, tip cyan), right = warm (main orange, tip yellow), center grey.
function tankColor(cfg, id) {
  if (id === P.BOTH && cfg.both) return 'var(--tk-c)';
  const t = cfg.tanks.find((x) => x.id === id);
  if (!t) return 'var(--mut)';
  const outer = t.spot === 'tip' || t.spot === 'outboard';
  if (t.side === 'C') return 'var(--tk-c)';
  return t.side === 'R' ? (outer ? 'var(--tk-ro)' : 'var(--tk-ri)') : (outer ? 'var(--tk-lo)' : 'var(--tk-li)');
}
const fullLevels = (cfg) => Object.fromEntries(cfg.tanks.map((t) => [t.id, t.capacity]));

// ---------- flights ----------
const activeFlight = () => (state.activeFlightId ? state.flights[state.activeFlightId] : null);
const MS = (f, min) => f.engineStart + min * MIN;
// The pilot's flight timer starts at takeoff; taxi happens before it.
const takeoffOf = (f) => (f && (f.takeoff ?? (f.engineStart ? f.engineStart + (f.taxiMin || 0) * MIN : null))) || null;
// Where the flight timer reads 0: at takeoff (an automatic timer such as the GTX 345's) or at engine
// start (a timer started by hand before taxi). Set in Settings; a flight keeps the mode it started with.
const timerMode = (f) => (f && f.timerFrom) || (f && f.engineStart ? 'takeoff' : state.settings.timerFrom || 'takeoff');
const timerOffMin = (f) => (timerMode(f) === 'engine' ? (f.taxiMin || 0) : 0); // taxi minutes on the timer before takeoff
const timerZero = (f) => (takeoffOf(f) ? (timerMode(f) === 'engine' && f.engineStart ? f.engineStart : takeoffOf(f) - timerOffMin(f) * MIN) : null);
const timerAt = (f, ms) => (timerZero(f) ? (ms - timerZero(f)) / MIN : NaN);
const fromTimer = (f, d) => timerZero(f) + d * MIN;
// Timer reading for a plan minute (minutes from engine start) before the flight has started.
const planTimer = (f, min) => min - (f.taxiMin || 0) + timerOffMin(f);
const fmtTimer = (min) => (!isFinite(min) ? '—' : min < -0.5 ? 'taxi' : '+' + dur(Math.max(0, min)));
const timerZ = (f, ms) => `<span class="mono">${fmtTimerS(timerAt(f, ms))}</span> <span class="z">${hm(ms)} · ${zt(ms)}</span>`;
const timeMode = () => state.settings.timeMode || 'timer';
// Flight timer with seconds (+2:17:00), matching the panel timer.
const fmtTimerS = (min) => (!isFinite(min) ? '—' : min < -0.5 ? 'taxi' : '+' + durS(min));
// Countdown to a moment: "in 0:52:10", or "0:03:12 late".
const countTxt = (at) => { const d = (at - now()) / MIN; return d >= 0 ? `in ${durS(d)}` : `${durS(-d)} late`; };
// Same countdown measured from a viewed moment on the Fly page, so it can't be read as real time.
const countFromTxt = (at, from, label) => { const d = (at - from) / MIN; return d >= 0 ? `${durS(d)} after ${label}` : `${durS(-d)} late at ${label}`; };

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
  return P.checkPlan({ cfg: f.cfg, segs: p.segs, legs: p.legs, levels: p.levels, startMin: p.startMin, endMin: p.endMin, requiredLanding: requiredLanding(f), fromEngineStart: p.startMin === 0, parked: P.parkedTanks(f) });
}

function planAbs(f, plan = f.plan) {
  if (!f.engineStart) return [];
  let t = plan.startMin;
  return plan.legs.map((l) => { const a = { tank: l.tank, start: MS(f, t), end: MS(f, t + l.min) }; t += l.min; return a; });
}

// The plan version that was in force at moment T (the first one replaced after T, else the current one).
function planAt(f, T) {
  return (f.planHistory || []).find((h) => h.at > T) || f.plan;
}

function savePlanHistory(f, reason) {
  f.planHistory = f.planHistory || [];
  f.planHistory.push({ at: now(), reason, startMin: f.plan.startMin, endMin: f.plan.endMin, legs: f.plan.legs.map((l) => ({ ...l })), source: f.plan.source, createdAt: f.plan.at, created: f.plan.reason });
  if (f.planHistory.length > 120) f.planHistory.shift();
}
// Replace the plan, keeping the old one in the flight's history with the reason for the change.
function setPlan(f, plan, reason) {
  if (f.plan) savePlanHistory(f, reason);
  f.plan = { ...plan, reason, at: now() };
}
const legTxt = (l) => `${l.tank} ${Math.round(l.min)}m`;

function generateFor(f, { startMin, endMin, segs, levels, currentTank, switchFrom }) {
  const g = P.generatePlan({ cfg: f.cfg, segs, startMin, endMin, levels, currentTank, switchFrom, requiredLanding: requiredLanding(f), parked: P.parkedTanks(f) });
  return { startMin, endMin, segs, levels: { ...levels }, legs: g.legs.map((l) => ({ tank: l.tank, min: l.min })), source: currentTank ? 'rebuilt' : 'generated', at: now() };
}

function rebuildFrom(f, atMs, reason) {
  const est = P.estimate(f, f.cfg, atMs);
  const rs = P.remainingSegs(f, atMs);
  setPlan(f, generateFor(f, { startMin: rs.startMin, endMin: rs.endMin, segs: rs.segs, levels: est.levels, currentTank: est.active }), reason ? `Rebuilt (${reason})` : 'Rebuilt');
}

// Keep plan legs 0..i exactly as they are and regenerate everything after them, starting with a
// switch off leg i's tank.
function rebuildAfterLeg(f, i) {
  const p = f.plan;
  const row = planCheck(f).rows[i];
  if (!row) return;
  const at = row.startMin + row.min;
  const kept = p.legs.slice(0, i + 1).map((l) => ({ ...l }));
  const rest = at < p.endMin - 0.5 ? generateFor(f, { startMin: at, endMin: p.endMin, segs: p.segs, levels: row.levels, switchFrom: row.tank }).legs : [];
  setPlan(f, { ...p, legs: [...kept, ...rest], source: 'rebuilt' }, `Rebuilt after leg ${i + 1} (kept ${kept.map(legTxt).join(', ')})`);
}

function flightTitle(f) {
  const to = f.divert ? `${esc(f.divert.ident || 'stop')}` : esc(f.to || '—');
  return `${esc(f.from || '—')} → ${to}`;
}

function arrivalMs(f) {
  if (!f.engineStart) return null;
  return Math.max(P.arrivalOf(f), f.snoozeUntil || 0);
}
const graceMin = (f) => f.cfg.landing?.graceMin ?? 15;

// Landing: alert at the expected arrival; after the grace period assume landed and freeze the levels.
function checkLanding() {
  const f = activeFlight();
  if (!f || f.status !== 'active' || !f.engineStart || f.shutdown) return;
  const t = now();
  const land = P.landingAt(f);
  if (land) {
    // Landing recorded: no landing alert; if nothing else is entered, assume shutdown after taxi-in.
    const end = land.at + P.taxiInMinOf(f) * MIN;
    if (!f.freezeAt && t >= end + graceMin(f) * MIN) { f.freezeAt = end; persist(); ui.alert = { kind: 'landed', at: end }; renderAlert(); if (ui.route === 'fly') renderFlyLive(); }
    return;
  }
  const arr = arrivalMs(f);
  const key = `${f.id}:land:${Math.round(arr / 1000)}`;
  if (t >= arr && t - arr < graceMin(f) * MIN && !ui.fired.has(key) && !f.freezeAt) {
    ui.fired.add(key);
    ui.alert = { kind: 'land', at: arr };
    renderAlert();
    if (f.cfg.alerts?.sound !== false) beep(2);
    if (f.cfg.alerts?.vibrate !== false && navigator.vibrate) navigator.vibrate([300, 150, 300]);
  }
  if (!f.freezeAt && t >= arr + graceMin(f) * MIN) {
    f.freezeAt = arr;
    persist();
    ui.alert = { kind: 'landed', at: arr };
    renderAlert();
    if (ui.route === 'fly') renderFlyLive();
  }
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
  if (!f || f.status !== 'active') return;
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
  if (est.empty) {
    const key = `${f.id}:empty:${est.empty.tank}:${Math.round(est.empty.at / 60000)}`;
    if (!ui.fired.has(key)) {
      ui.fired.add(key);
      ui.alert = { kind: 'empty', tank: est.empty.tank, at: est.empty.at };
      renderAlert();
      if (f.cfg.alerts?.sound !== false) beep(3);
      if (f.cfg.alerts?.vibrate !== false && navigator.vibrate) navigator.vibrate([400, 150, 400]);
    }
  }
  const ph = P.phaseAt(f, t);
  if (ph.phase === 'climb' && !ph.until) {
    const exp = ph.since + P.climbLenMin(f, P.activeClimb(f, t)) * MIN;
    const key = `${f.id}:level:${ph.since}:${Math.floor((t - exp) / (10 * MIN))}`;
    if (t >= exp && !ui.fired.has(key) && !ui.alert) {
      ui.fired.add(key);
      ui.alert = { kind: 'level', at: exp, since: ph.since };
      renderAlert();
      if (f.cfg.alerts?.sound !== false) beep(1);
      if (f.cfg.alerts?.vibrate !== false && navigator.vibrate) navigator.vibrate([200]);
    }
  }
  checkLanding();
}

function renderAlert() {
  const bar = $('#alertbar');
  if (activeFlight()?.status !== 'active') ui.alert = null;
  const a = ui.alert;
  if (!a) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
  const mins = Math.max(0, Math.round((a.at - now()) / MIN));
  bar.classList.remove('hidden');
  const f = activeFlight();
  if (a.kind === 'land' || a.kind === 'landed') {
    bar.innerHTML = `<div class="inner ${a.kind === 'land' ? 'pre' : ''}" role="alert">
      <div class="row between"><span>${a.kind === 'land' ? 'Expected landing' : P.landingAt(f) ? 'Assumed shut down after taxi-in · levels frozen' : 'Assumed landed · levels frozen'}</span><span>${timerZ(f, a.at)}</span></div>
      <div class="big">${a.kind === 'land' ? 'Tap Landed on touchdown' : P.landingAt(f) ? 'Parked?' : 'Landed?'}</div>
      <div class="row"><button class="btn grow" data-act="alertShutdown">Shut down</button><button class="btn grow" data-act="${a.kind === 'land' ? 'alertDismiss' : 'stillFlying'}">${a.kind === 'land' ? 'Dismiss' : 'Still flying'}</button></div></div>`;
    return;
  }
  if (a.kind === 'level') {
    bar.innerHTML = `<div class="inner pre" role="alert">
      <div class="row between"><span>Climb running long</span><span>${timerZ(f, a.at)}</span></div>
      <div class="big">Still climbing?</div>
      <div class="small">Burn stays at climb rate until you level off.</div>
      <div class="row"><button class="btn grow" data-act="alertLevel">Level off</button><button class="btn grow" data-act="alertDismiss">Still climbing</button></div></div>`;
    return;
  }
  if (a.kind === 'empty') {
    bar.innerHTML = `<div class="inner" role="alert">
      <div class="row between"><span>Missed switch?</span><span>${timerZ(f, a.at)}</span></div>
      <div class="big">${esc(a.tank)} would be empty</div>
      <div class="row"><button class="btn grow" data-act="emptySwitch">Record switch</button><button class="btn grow" data-act="alertDismiss">Dismiss</button></div></div>`;
    return;
  }
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
  if (f.status === 'active') { const arr = arrivalMs(f); if (arr) base = Math.max(base, arr + graceMin(f) * MIN); }
  if (now() - base < idleH * HOUR) return false;
  if (f.status === 'active') {
    const landed = f.freezeAt || (arrivalMs(f) < now() ? arrivalMs(f) : Math.max(state.lastInputAt, f.engineStart));
    f.status = 'closed'; f.autoSaved = true; f.autoEnded = true;
    f.shutdown = f.shutdown || landed;
    if (!f.events.some((e) => e.type === 'shutdown')) f.events.push({ type: 'shutdown', at: f.shutdown, enteredAt: now(), assumed: true, used: null });
  }
  else { f.status = 'saved'; f.autoSaved = true; }
  state.activeFlightId = null;
  ui.draft = null;
  persist();
  toast(f.autoEnded ? 'Previous flight ended at its assumed landing time. Check it in the Log.' : `Previous flight auto-saved after ${idleH} h idle`);
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
  ui.route = ['setup', 'plan', 'fly', 'fuel', 'log', 'aircraft', 'guide'].includes(r) ? r : (activeFlight()?.status === 'active' ? 'fly' : 'plan');
  ui.sub = s || null;
}

function renderTabs() {
  const tabs = [['plan', 'Plan'], ['fly', 'Fly'], ['fuel', 'Fuel'], ['log', 'Log'], ['aircraft', 'Settings']];
  const on = ui.route === 'setup' || ui.route === 'guide' ? 'plan' : ui.route;
  $('#tabs').innerHTML = tabs.map(([r, l]) => `<a href="#${r}" class="${on === r ? 'on' : ''}">${l}</a>`).join('');
}

function render() {
  renderTabs();
  const v = { setup: viewSetup, plan: viewPlan, fly: viewFly, fuel: viewFuel, log: viewLog, aircraft: viewAircraft, guide: viewGuide }[ui.route];
  $('#app').innerHTML = v();
  if (ui.route === 'fly') renderFlyLive();
  if (ui.route === 'setup') renderSetupCalc();
  if (ui.route === 'guide') fillGuide();
  renderSheet();
  renderAlert();
  const f = activeFlight();
  keepAwake(!!(f && f.status === 'active' && ui.route === 'fly'));
}

// =====================================================================
// GUIDE (README.md, shown in the app and cached for offline)
// =====================================================================
const GUIDE_BTN = '<a class="btn sm" href="#guide">Guide</a>';
function viewGuide() {
  return `<div class="top"><div><div class="kicker"><a href="#plan">Plan</a> · Guide</div><h1>How Burnplan works</h1></div></div>
  <div class="guide" id="guideBody"><div class="mut">Loading…</div></div>`;
}
function fillGuide() {
  loadGuide().then((html) => { const el = $('#guideBody'); if (el) el.innerHTML = html; })
    .catch(() => { const el = $('#guideBody'); if (el) el.innerHTML = '<div class="card empty">The guide isn\'t available offline yet. Open the app once with a connection.</div>'; });
}

// =====================================================================
// SETUP
// =====================================================================
function defaultDraft() {
  const tail = state.settings.lastTail && state.tails[state.settings.lastTail] ? state.settings.lastTail : Object.keys(state.tails)[0] || '';
  const cfg = tail ? cfgForTail(tail) : null;
  return {
    tail, from: '', to: '', ete: '', fuel: '', taxi: String(state.settings.lastTaxi?.[tail] ?? 15), climbMin: '', climbGph: '', cruiseGph: '', descentMin: '', descentGph: '', taxiIn: '',
    alt: { on: false, ident: '', ete: '', fuel: '' },
    levels: cfg ? startLevelsFor(tail, cfg) : {},
    resMin: '', resGph: ''
  };
}
// Starting fuel for a new flight: what the last fueling (or the last flight's end) left, else full.
function startLevelsFor(tail, cfg) {
  const st = tailFuelState(tail);
  const lv = st && st.levels ? st.levels : fullLevels(cfg);
  return Object.fromEntries(cfg.tanks.map((t) => [t.id, String(Math.round(Math.min(t.capacity, Math.max(0, lv[t.id] ?? t.capacity)) * 10) / 10)]));
}

function draftFromFlight(f) {
  return {
    tail: f.tail, from: f.from, to: f.to, ete: dur(f.eteMin), fuel: String(f.totalFuel || ''), taxi: String(f.taxiMin), climbMin: f.profileInput?.climbMin || '', climbGph: f.profileInput?.climbGph || '', cruiseGph: f.profileInput?.cruiseGph || '',
    descentMin: f.profileInput?.descentMin || '', descentGph: f.profileInput?.descentGph || '', taxiIn: f.profileInput?.taxiIn || '',
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
  const tl = P.buildTimeline(cfg, { taxiMin, eteMin, totalFuel: isFinite(totalFuel) ? totalFuel : 0, climbMin: P.parseDur(d.climbMin), climbGph: num(d.climbGph), cruiseGph: num(d.cruiseGph), descentMin: P.parseDur(d.descentMin), descentGph: num(d.descentGph), taxiInMin: d.taxiIn === '' || d.taxiIn == null ? null : num(d.taxiIn) });
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
    return `<div class="top"><div><div class="kicker">Welcome to ${APP_NAME}</div><h1>Add your aircraft</h1></div>${GUIDE_BTN}</div>
      <div class="stack"><div class="card"><div class="mut small">Pick the aircraft type and enter the tail number. Tank layout, burn profiles and rules come from the type; you can override any of them for this tail later.</div>
      ${tailForm()}</div></div>`;
  }
  if (!ui.draft) ui.draft = f ? draftFromFlight(f) : (state.settings.draft || defaultDraft());
  const d = ui.draft;
  if (!state.tails[d.tail]) d.tail = Object.keys(state.tails)[0];
  const cfg = cfgForTail(d.tail);
  return `<div class="top"><div><div class="kicker">${f ? 'Editing planned flight' : 'New flight'}</div><h1>Flight setup</h1></div>
    <div class="stack" style="gap:6px;align-items:flex-end">${GUIDE_BTN}${f ? `<button class="btn sm danger" data-act="discardDraft">Discard</button>` : ''}</div></div>
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
      <div class="grid4" style="margin-top:8px">
        <div class="field"><label for="s-dmin">Descent</label><input id="s-dmin" class="mono" data-fmt="hm" data-d="descentMin" value="${esc(d.descentMin)}" inputmode="numeric" placeholder="${dur(cfg.burn.descentMin || 0)}"></div>
        <div class="field"><label for="s-dgph">Descent gph</label><input id="s-dgph" class="mono" data-d="descentGph" value="${esc(d.descentGph)}" inputmode="decimal" placeholder="${f1(cfg.burn.descentGph || cfg.burn.cruise)}"></div>
        <div class="field"><label for="s-tin">Taxi-in min</label><input id="s-tin" class="mono" data-d="taxiIn" value="${esc(d.taxiIn)}" inputmode="numeric" placeholder="${cfg.burn.taxiInMin || 0}"></div>
        <div></div>
      </div>
      <div class="mut small">Blank = aircraft defaults. Cruise "auto" is worked out so the total matches ForeFlight (taxi, climb, cruise and descent); taxi-in is added on top.</div>
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
      ${(() => { const st = tailFuelState(d.tail); return st ? `<div class="mut small">Prefilled from ${esc(st.label)}. <a href="#fuel">Fuel tab</a></div>` : ''; })()}
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
    <div class="kv"><span class="mut">Climb ${dur(tl.climbMin)} @ ${f1(tl.climbGph)} gph → level at +${dur(tl.climbMin + ((state.settings.timerFrom || 'takeoff') === 'engine' ? (tl.segments[0]?.min || 0) : 0))}</span><span class="v">${f1(tl.climbFuel)}</span></div>
    <div class="kv"><span class="mut">Cruise ${dur(tl.cruiseMin)} @ ${tl.derived ? 'auto' : num(ui.draft.cruiseGph) > 0 ? 'your' : 'aircraft'} rate</span><span class="v">${f1(tl.cruiseGph)} gph · ${f1((tl.cruiseMin / 60) * tl.cruiseGph)}</span></div>
    ${tl.descentMin > 0 ? `<div class="kv"><span class="mut">Descent ${dur(tl.descentMin)} @ ${f1(tl.descentGph)} gph</span><span class="v">${f1(tl.descentFuel)}</span></div>` : ''}
    ${tl.taxiInMin > 0 ? `<div class="kv"><span class="mut">Taxi-in ${tl.taxiInMin} min @ ${f1(b.ground)} gph</span><span class="v">${f1(tl.taxiInFuel)}</span></div>` : ''}
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
  if (isNew) f = { id: uid(), createdAt: now(), status: 'draft', events: [], planHistory: [], tz: phoneTZ() };
  Object.assign(f, {
    tail: d.tail, typeId: state.tails[d.tail].typeId, cfg: c.cfg,
    from: (d.from || '').toUpperCase(), to: (d.to || '').toUpperCase(),
    eteMin: c.eteMin, totalFuel: isFinite(c.totalFuel) ? c.totalFuel : 0, taxiMin: c.taxiMin,
    alt: { on: !!d.alt.on, ident: (d.alt.ident || '').toUpperCase(), eteMin: P.parseDur(d.alt.ete) || 0, fuel: num(d.alt.fuel) || 0 },
    resOverride: c.ov.rules ? { min: c.ov.rules.reserve.min, gph: c.ov.rules.reserve.customGph } : null,
    startLevels: c.levels, segs: c.tl.segments, blockMin: c.tl.blockMin, cruiseGph: c.tl.cruiseGph, plannedFuel: c.tl.totalFuel,
    climbMin: c.tl.climbMin, climbGph: c.tl.climbGph, descentMin: c.tl.descentMin, descentGph: c.tl.descentGph, taxiInMin: c.tl.taxiInMin,
    profileInput: { climbMin: d.climbMin, climbGph: d.climbGph, cruiseGph: d.cruiseGph, descentMin: d.descentMin, descentGph: d.descentGph, taxiIn: d.taxiIn }
  });
  setPlan(f, { ...generateFor(f, { startMin: 0, endMin: f.blockMin, segs: f.segs, levels: f.startLevels, currentTank: null }), source: 'generated' }, isNew ? 'Built from setup' : 'Setup changed');
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
// The cruise gph sets the reserve and is the plan's fallback when ForeFlight fuel is blank, so the
// pilot confirms it here rather than taking the type's typical number unseen.
function tailForm() {
  const types = allTypes();
  return `<div class="grid2">
    <div class="field"><label for="nt-tail">Tail number</label><input id="nt-tail" class="mono" placeholder="N12345" autocapitalize="characters"></div>
    <div class="field"><label for="nt-type">Type</label><select id="nt-type" data-nt-type>${types.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select></div>
  </div>
  <div class="field"><label for="nt-cruise">Your cruise burn (gph)</label><input id="nt-cruise" class="mono" value="${types[0]?.burn.cruise ?? ''}" inputmode="decimal"></div>
  <div class="mut small">Prefilled with the type's typical number. Enter what your engine burns at your usual cruise: it sets the reserve and the plan's cruise when ForeFlight fuel is blank. In flight, burn only changes from what you enter.</div>
  <button class="btn primary block" data-act="addTail">Add aircraft</button>`;
}

// =====================================================================
// PLAN
// =====================================================================
// Phase breakdown under a leg: one line per phase when a leg covers more than one.
function phaseLines(raw, untilLbl) {
  const list = [];
  for (const x of raw) {
    const last = list[list.length - 1];
    if (last && last.phase === x.phase) { const fuel = (last.min / 60) * last.gph + (x.min / 60) * x.gph; last.min += x.min; last.gph = fuel / (last.min / 60); }
    else list.push({ ...x });
  }
  const item = (x) => `<span class="ph ph-${x.phase}">${x.phase}</span> ${Math.round(x.min)}m @ ${f1(x.gph)} gph · ${f1((x.min / 60) * x.gph)} gal`;
  if (list.length <= 1) return `<div class="legsub">${list.map(item).join('')} → until ${untilLbl}</div>`;
  return `<div class="legsub multi">${list.map((x) => `<div>${item(x)}</div>`).join('')}<div>→ until ${untilLbl}</div></div>`;
}

function viewPlan() {
  const f = activeFlight();
  if (!f) return viewSetup();
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
  const colorOf = (id) => tankColor(cfg, id);
  const timeLbl = (min) => (f.engineStart ? `${fmtTimer(timerAt(f, MS(f, min)))}<br><span class="z">${hm(MS(f, min))}</span>` : fmtTimer(planTimer(f, min)));
  const whole = active && (state.settings.planView || 'whole') === 'whole';
  const pastRows = whole ? actualLegs(f, now(), false) : [];
  // Plan rows still ahead (or in progress) — anything already flown is shown from actual history instead.
  const curMin = active ? (now() - f.engineStart) / MIN : -1;
  const estNow = active ? P.estimate(f, f.cfg, now()) : null;
  const planAtNow = active ? chk.rows.find((r) => curMin >= r.startMin && curMin < r.startMin + r.min) : null;
  const offPlan = !!(planAtNow && estNow && planAtNow.tank !== estNow.active);

  return `<div class="top"><div><div class="kicker">Plan · ${esc(f.tail)}</div><h1>${flightTitle(f)}</h1></div>
    <div class="stack" style="gap:6px;align-items:flex-end"><span class="badge ${p.source === 'edited' ? 'amber' : ''}">${p.source === 'edited' ? 'Edited' : p.source === 'rebuilt' ? 'Rebuilt' : 'Generated'}</span>${f.status === 'draft' ? '<a class="btn sm" href="#setup">Edit setup</a>' : ''}${GUIDE_BTN}</div></div>
  <div class="stack">
    <div class="chips">
      <div class="chip"><span class="k">Burn ${p.startMin > 0 ? 'remaining' : ''}</span><span class="v">${f1(P.fuelBetween(p.segs, p.startMin, p.endMin))}</span></div>
      <div class="chip"><span class="k">Lands with</span><span class="v" style="color:${chk.landing < req - P.TOL ? 'var(--warn)' : 'var(--tx)'}">${f1(chk.landing)}</span></div>
      <div class="chip"><span class="k">Reserve${f.alt?.on ? ' + alt' : ''}</span><span class="v">${f1(req)}</span></div>
    </div>
    ${['error', 'warn', 'info'].map((sv) => (groupIssues[sv] || []).map((i) => `<div class="issue ${sv}">${sv === 'info' ? ICON.info : ICON.warn}<div>${i.legIndex != null && i.legIndex >= 0 ? `<b>Leg ${i.legIndex + 1}:</b> ` : ''}${esc(i.msg)}</div></div>`).join('')).join('')}
    <div class="stack" style="gap:6px">
      ${active ? `<div class="seg" role="group" aria-label="Plan view"><button class="${whole ? 'on' : ''}" aria-pressed="${whole}" data-act="planView" data-v="whole">Whole flight</button><button class="${whole ? '' : 'on'}" aria-pressed="${!whole}" data-act="planView" data-v="remaining">Remaining</button></div>` : ''}
      <div class="row between small mut"><span>Tank use over time</span><span>${(() => {
        const sideNow = (sd) => cfg.tanks.filter((x) => x.side === sd).reduce((acc, x) => acc + estNow.levels[x.id], 0);
        const nowImb = active ? Math.abs(sideNow('L') - sideNow('R')) : null;
        const ahead = active ? chk.rows.filter((r) => r.startMin + r.min > curMin + 0.01).map((r) => Math.abs(r.imb)) : chk.rows.map((r) => Math.abs(r.imb)).concat([Math.abs(chk.startImb)]);
        const maxShown = Math.max(nowImb ?? 0, ...ahead, ...pastRows.map((r) => Math.abs(r.imb)));
        const lim = cfg.rules.imbalance.gal;
        const col = (v) => (v > lim + P.TOL ? 'var(--warn)' : v >= lim - 2 ? 'var(--amber)' : 'inherit');
        return `${nowImb != null ? `<span style="color:${col(nowImb)}">now Δ ${f1(nowImb)}</span> · ` : ''}<span style="color:${col(maxShown)}">max ${f1(maxShown)}</span> · limit ${lim}`;
      })()}</span></div>
      ${(() => {
        // Whole flight = what was actually flown (from recorded switches/climbs) up to the current time,
        // then the plan from now on. Remaining = the plan from now on only.
        const T = now();
        const nowMin = active ? Math.max(p.startMin, (T - f.engineStart) / MIN) : p.startMin;
        const flownTanks = whole ? flownLegs(f, T) : [];
        const flownPh = whole ? P.actualPhases(f, f.engineStart, T) : [];
        const flownMin = whole ? (T - f.engineStart) / MIN : 0;
        const clip = (a, b) => Math.max(0, b - Math.max(a, nowMin));
        const planTanks = chk.rows.map((r) => ({ tank: r.tank, min: clip(r.startMin, r.startMin + r.min) })).filter((x) => x.min > 0.01);
        const planPh = P.phasesBetween(p.segs, nowMin, p.endMin);
        const shortRest = shortMin > 0.5 ? clip(chk.planEnd, p.endMin) : 0;
        const restMin = Math.max(p.endMin, chk.planEnd) - nowMin;
        const total = flownMin + restMin;
        const nowPct = total > 0 ? (flownMin / total) * 100 : 0;
        const past = (x, color) => `<div style="flex:${x};background:${color}"></div>`;
        const marker = flownMin > 0.5 ? `<div class="nowmark" style="left:${nowPct}%"></div>` : '';
        return `<div class="barwrap">
          <div class="bar phasebar" aria-label="Flight phases">${flownPh.map((x) => past(x.min, `var(--ph-${x.phase})`)).join('')}${planPh.map((x) => past(x.min, `var(--ph-${x.phase})`)).join('')}</div>
          <div class="bar" aria-label="Tank use">${flownTanks.map((r) => past(r.min, colorOf(r.tank))).join('')}${planTanks.map((r) => past(r.min, colorOf(r.tank))).join('')}${shortRest > 0.5 ? `<div style="flex:${shortRest};background:repeating-linear-gradient(45deg,var(--warn) 0 4px,var(--warnbg) 4px 8px)"></div>` : ''}</div>
          ${marker}</div>
          <div class="axis mono"><span>${whole || !active ? (timerOffMin(f) ? '+0:00' : 'taxi') : 'now ' + fmtTimer(timerAt(f, T))}</span>${flownMin > 0.5 ? `<span class="nowlbl" style="left:${Math.min(84, Math.max(16, nowPct))}%">now ${fmtTimer(timerAt(f, now()))}</span>` : ''}<span>${fmtTimer((active ? timerAt(f, MS(f, p.endMin)) : planTimer(f, p.endMin)))}</span></div>`;
      })()}
      <div class="legend"><span><span class="sw" style="background:var(--ph-taxi)"></span>taxi</span><span><span class="sw" style="background:var(--ph-climb)"></span>climb</span><span><span class="sw" style="background:var(--ph-cruise)"></span>cruise</span><span><span class="sw" style="background:var(--ph-descent)"></span>descent</span><span class="dim">|</span>${cfg.tanks.map((t) => `<span><span class="sw" style="background:${colorOf(t.id)}"></span>${esc(t.id)}</span>`).join('')}${shortMin > 0.5 ? '<span>hatched = short</span>' : ''}</div>
      <div class="mut small" style="margin-top:4px">${timerOffMin(f) ? `Times are your flight timer, started at engine start: taxi is +0:00 to +${dur(f.taxiMin || 0)}, takeoff at +${dur(f.taxiMin || 0)}.` : `Times are your flight timer, which starts at takeoff (+0:00). Taxi comes before it and isn't on the timer.`} <a href="#aircraft">Change</a></div>
    </div>
    <div class="legs">
      <div class="legrow head"><span>#</span><span>Tank</span><span>Start</span><span>Min</span><span>Gal</span><span>After</span><span class="right">L/R Δ</span><span></span></div>
      ${pastRows.map((r, idx) => `<div class="legrow past"><span class="${idx === pastRows.length - 1 ? 'onnow' : ''}">${idx === pastRows.length - 1 ? '●' : '✓'}</span><span style="color:${colorOf(r.tank)};font-weight:600;font-family:var(--sans)">${esc(r.tank)}</span><span>${fmtTimer(timerAt(f, r.start))}</span><span>${Math.round((r.end - r.start) / MIN)}</span><span>${f1(r.fuel)}</span><span>${f1(r.after)}</span><span class="right ${Math.abs(r.imb) > cfg.rules.imbalance.gal + P.TOL ? 'flag' : Math.abs(r.imb) >= cfg.rules.imbalance.gal - 2 ? 'flag w' : 'mut'}">${f1(Math.abs(r.imb))}</span><span></span>${phaseLines(P.actualPhases(f, r.start, r.end), idx === pastRows.length - 1 ? 'now ' + fmtTimer(timerAt(f, r.end)) + ' · on now' : fmtTimer(timerAt(f, r.end)))}</div>`).join('')}
      ${offPlan ? `<div class="issue warn" style="margin:8px">${ICON.warn}<div>You're on <b>${esc(estNow.active)}</b>; the plan has <b>${esc(planAtNow.tank)}</b> right now. <button class="btn sm outline" data-act="regen" style="margin-top:6px">Rebuild from now</button></div></div>` : ''}
      ${chk.rows.map((r, i) => {
        if (active && r.startMin + r.min <= curMin + 0.01) return '';
        const bad = r.flags.filter((x) => ['empty', 'floor', 'imbalance', 'sequence'].includes(x));
        const isNow = active && nowMin >= r.startMin && nowMin < r.startMin + r.min;
        return `<div class="legrow ${isNow ? 'now' : ''}">
          <button class="legno ${bad.length ? 'flag' : ''}" aria-label="Keep through leg ${i + 1} and rebuild after it" data-act="keepLeg" data-i="${i}">${bad.length ? '!' : i + 1}</button>
          <select aria-label="Leg ${i + 1} tank" data-leg-tank="${i}" style="color:${colorOf(r.tank)};font-weight:600">${P.selectable(cfg).map((t) => `<option ${t.id === r.tank ? 'selected' : ''}>${esc(t.id)}</option>`).join('')}</select>
          <span>${timeLbl(r.startMin)}</span>
          <input aria-label="Leg ${i + 1} minutes" data-leg-min="${i}" value="${Math.round(r.min)}" inputmode="numeric">
          <span>${f1(r.fuel)}</span>
          <input aria-label="Leg ${i + 1} tank level after (gal)" data-leg-after="${i}" value="${f1(r.after)}" inputmode="decimal" class="${r.flags.includes('floor') || r.flags.includes('empty') ? 'flag' : ''}">
          <span class="right ${r.flags.includes('imbalance') ? 'flag' : Math.abs(r.imb) >= cfg.rules.imbalance.gal - 2 ? 'flag w' : 'mut'}">${f1(Math.abs(r.imb))}</span>
          <button class="iconbtn" style="width:28px;height:36px" aria-label="Delete leg ${i + 1}" data-act="delLeg" data-i="${i}">${ICON.del}</button>
          ${phaseLines(P.phasesBetween(p.segs, r.startMin, r.startMin + r.min), f.engineStart ? fmtTimer(timerAt(f, MS(f, r.startMin + r.min))) : fmtTimer(planTimer(f, r.startMin + r.min)))}
        </div>`;
      }).join('')}
      ${shortMin > 0.5 ? `<div class="legrow short"><span>!</span><span style="font-family:var(--sans);font-weight:600">short</span><span>${timeLbl(chk.planEnd)}</span><span>${Math.round(shortMin)}</span><span>${f1(shortFuel)}</span><span>—</span><span class="right">—</span><span></span></div>` : ''}
    </div>
    ${active ? (() => { const pk = P.parkedTanks(f); return `<div class="card" style="padding:10px 12px"><div class="row between"><span class="lbl">Tap a tank to mark it done for this flight</span></div>
      <div class="row wrap" style="gap:6px;margin-top:6px">${f.cfg.tanks.map((t) => `<button class="btn sm ${pk.includes(t.id) ? 'outline' : ''}" data-act="toggleDone" data-tank="${esc(t.id)}" aria-pressed="${!pk.includes(t.id)}" style="${pk.includes(t.id) ? 'text-decoration:line-through;opacity:.7' : `color:${tankColor(f.cfg, t.id)}`}">${esc(t.id)}${pk.includes(t.id) ? ' · done' : ''}</button>`).join('')}</div>
      ${pk.length ? `<div class="mut small" style="margin-top:6px">${esc(pk.join(', '))} done: rebuilds skip ${pk.length > 1 ? 'them' : 'it'}, but ${pk.length > 1 ? 'they count' : 'it counts'} for balance and landing fuel. Tap again to use.</div>` : ''}</div></div>`; })() : ''}
    <div class="row wrap"><button class="btn sm" data-act="addLeg">+ Add leg</button><span class="mut small grow">Change a tank, minutes or the gallons left after a leg to edit; rules are re-checked and broken ones are flagged. Tap a leg's number to keep the plan through it and rebuild after it.</span></div>
    <div class="row">
      <button class="btn grow" data-act="regen">${active ? 'Rebuild from now' : 'Regenerate'}</button>
      ${active ? `<a class="btn primary grow" href="#fly">Fly</a>` : `<button class="btn primary grow" data-act="openSheet" data-sheet="start">Start flight</button>`}
    </div>
    ${f.planHistory?.length ? `<div class="mut small">${f.planHistory.length} earlier plan version${f.planHistory.length > 1 ? 's' : ''} kept in the log.</div>` : ''}
  </div>`;
}

// Actual legs flown so far (from switch events), for display.
// Tank segments actually flown from engine start to \`until\`, from recorded switches (no plan involved).
function flownLegs(f, until) {
  const sw = f.events.filter((e) => e.type === 'switch' && e.at <= until).sort((a, b) => a.at - b.at);
  const out = [];
  let tank = f.startTank, start = f.engineStart;
  for (const e of sw) { if (e.at > start) out.push({ tank, min: (e.at - start) / MIN }); tank = e.tank; start = Math.max(start, e.at); }
  if (until > start) out.push({ tank, min: (until - start) / MIN });
  return out;
}

function actualLegs(f, until = now(), cutAtPlan = true) {
  if (!f.engineStart) return [];
  const sw = f.events.filter((e) => e.type === 'switch' && e.at <= until).sort((a, b) => a.at - b.at);
  const cut = cutAtPlan ? MS(f, f.plan.startMin) : until;
  const out = [];
  let tank = f.startTank, start = f.engineStart;
  for (const e of sw) { out.push({ tank, start, end: e.at }); tank = e.tank; start = e.at; }
  out.push({ tank, start, end: Math.min(until, cut) });
  return out.filter((l) => l.start < cut && l.end - l.start >= 0.5 * MIN).map((l) => {
    const e1 = P.estimate(f, f.cfg, l.start), e2 = P.estimate(f, f.cfg, l.end);
    const side = (s) => f.cfg.tanks.filter((x) => x.side === s).reduce((a, x) => a + e2.levels[x.id], 0);
    return { ...l, end: Math.min(l.end, cut), fuel: P.feedLevel(f.cfg, e1.levels, l.tank) - P.feedLevel(f.cfg, e2.levels, l.tank), after: P.feedLevel(f.cfg, e2.levels, l.tank), imb: side('L') - side('R') };
  });
}

function editLeg(i, field, value) {
  const f = activeFlight();
  const legs = f.plan.legs.map((l) => ({ ...l }));
  const old = f.plan.legs[i];
  let what;
  if (field === 'tank') { if (value === old.tank) return; legs[i].tank = value; what = `leg ${i + 1} tank ${old.tank} → ${value}`; }
  else if (field === 'after') {
    const chk = planCheck(f), row = chk.rows[i];
    const before = P.feedLevel(f.cfg, i > 0 ? chk.rows[i - 1].levels : f.plan.levels, old.tank);
    const target = parseFloat(value);
    if (!isFinite(target) || target < 0 || target >= before - 0.05) { toast(`Enter a level below ${f1(before)} gal`); return render(); }
    if (Math.abs(target - row.after) < 0.05) return;
    const m = P.timeForFuel(f.plan.segs, row.startMin, before - target);
    if (!isFinite(m) || m <= 0) return render();
    legs[i].min = m; what = `leg ${i + 1} ${old.tank} to ${f1(target)} gal (${Math.round(old.min)} → ${Math.round(m)} min)`;
  }
  else { const m = P.parseDur(value); if (!isFinite(m) || m <= 0) return render(); if (Math.round(m) === Math.round(old.min)) return; legs[i].min = m; what = `leg ${i + 1} ${old.tank} ${Math.round(old.min)} → ${Math.round(m)} min`; }
  setPlan(f, { ...f.plan, legs, source: 'edited' }, `Edited ${what}`);
  persist(); render();
}

// =====================================================================
// FLY
// =====================================================================
// Which zone a flight's clock times use. Shown when it differs from the phone, and in the log.
const ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'UTC'];
function zoneControl(f, always) {
  const fz = f.tz || phoneTZ(), pz = phoneTZ(), t = takeoffOf(f) || now();
  const differs = offsetMs(fz, now()) !== offsetMs(pz, now());
  if (!always && !differs) return '';
  const opts = [...new Set([fz, pz, ...ZONES])];
  return `<div class="card" style="padding:10px 12px;gap:6px">
    <div class="row between" style="gap:8px"><span class="small">${differs ? `Clock times use <b>${zoneAbbr(fz, t)}</b>${f.tz ? ' (departure)' : ''}; phone is on <b>${zoneAbbr(pz)}</b>.` : `Clock times use <b>${zoneAbbr(fz, t)}</b>.`}</span>
      <select aria-label="Time zone for this flight" data-ftz="${f.id}" style="width:auto;height:36px;font-size:13px">${opts.map((z) => `<option value="${z}" ${z === fz ? 'selected' : ''}>${zoneAbbr(z, t)} · ${z.split('/').pop().replace('_', ' ')}</option>`).join('')}</select></div>
    <div class="mut small">Flight timer and Zulu never change. Pick the zone your clock reads.</div></div>`;
}

function viewFly() {
  const f = activeFlight();
  if (!f) return `<div class="top"><div><div class="kicker">Fly</div><h1>No flight</h1></div></div><div class="card empty">Set up and plan a flight first.<br><br><a class="btn primary" href="#setup">Flight setup</a></div>`;
  return `<div class="top"><div><div class="kicker">${esc(f.tail)} · ${esc(typeById(f.typeId)?.name || '')}</div><h1>${flightTitle(f)}</h1></div>
    <div style="text-align:right">${f.engineStart ? `<div class="kicker">Takeoff ${hm(takeoffOf(f))} ${clockMode() === 'zulu' ? '' : zoneAbbr(viewZone(), takeoffOf(f))} <span class="z">${zt(takeoffOf(f))}</span></div><div class="mono" style="font-size:20px" id="elapsed"></div>` : '<span class="badge">Planned</span>'}</div></div>
  <div class="stack">
    ${f.engineStart ? `<div class="card ${ui.viewTime ? 'viewing' : ''}" style="padding:10px 12px">
      <div class="timebox">
        <div class="stack" style="gap:2px;min-width:64px"><label for="flyTime" class="lbl">${flyMode(f) === 'timer' ? 'Flight timer' : `${clockLabel()} clock`}${ui.viewTime ? '' : ' <span class="livedot" role="status" aria-label="Showing live time"><span class="dot"></span>Live</span>'}</label><span class="z" id="flyZ"></span></div>
        <input id="flyTime" data-fmt="${flyMode(f) === 'timer' ? 'hms' : 'hm'}" inputmode="numeric" value="${flyTimeValue(f)}" aria-label="${flyMode(f) === 'timer' ? 'Flight timer' : 'Clock time'} to show levels for">
        ${f.engineStart ? `<button class="btn sm" data-act="toggleFlyMode" style="height:44px">${flyMode(f) === 'timer' ? (clockMode() === 'zulu' ? 'Zulu' : 'Clock') : 'Timer'}</button>` : ''}
        ${ui.viewTime
          ? '<button class="btn sm backlive" data-act="liveTime" style="height:44px">Go live</button>'
          : ''}
      </div>
      ${ui.viewTime ? `<div class="small" style="color:var(--amber)">Not live: showing ${flyMode(f) === 'timer' ? fmtTimer(timerAt(f, ui.viewTime)) : `${hm(ui.viewTime)} (${fmtTimer(timerAt(f, ui.viewTime))})`}. Alerts still run on real time; returns to live after 2 min.</div>` : ''}
    </div>` : ''}
    ${f.engineStart && clockMode() !== 'zulu' ? zoneControl(f, false) : ''}
    <div id="flyLive"></div>
    ${f.engineStart ? `
      <section class="flightmgmt" aria-label="Flight">
        <div class="lbl">Flight</div>
        <div class="row"><a class="btn grow" href="#log/${f.id}">Edit history</a><button class="btn danger grow" data-act="openSheet" data-sheet="shutdown">End flight</button></div>
        <button class="linkbtn" data-act="resetStart">Undo start (back to planned)</button>
      </section>`
      : `<button class="btn primary block" data-act="openSheet" data-sheet="start">Start flight</button>
         <div class="mut small">Open this any time after takeoff: enter your flight timer and catch up on what you've done so far.</div>`}
  </div>`;
}

const flyMode = (f) => (f && f.engineStart ? timeMode() : 'clock');
function flyTimeValue(f) {
  const T = ui.viewTime || now();
  return flyMode(f) === 'timer' ? durS(timerAt(f, T)) : hm(T);
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

function gauge(cfg, t, level, on, done = false) {
  const pct = Math.max(0, Math.min(100, (level / t.capacity) * 100));
  const fl = (cfg.rules.floor.gal / t.capacity) * 100;
  const low = level < cfg.rules.floor.gal - P.TOL;
  return `<button type="button" class="gauge ${t.spot === 'tip' ? 'tip' : ''} ${on ? 'on' : ''} ${low ? 'low' : ''} ${done ? 'done' : ''}" data-act="tapTank" data-tank="${esc(t.id)}" aria-label="${esc(t.name)} ${f1(level)} of ${t.capacity} gallons${on ? ', selected now' : ', tap to record a switch'}">
    <div class="nm">${esc(t.id)}${on ? ' · ON' : done ? ' · DONE' : ''}</div>
    <div class="tube" aria-hidden="true"><div class="lvl" style="height:${pct}%"></div><div class="flr" style="bottom:${fl}%"></div></div>
    <div class="g">${f1(level)}</div><div class="of">of ${t.capacity}</div></button>`;
}

// Selector BOTH (only on types that have it): sits between the left and right gauges.
const bothButton = (on) => `<button type="button" class="bothbtn ${on ? 'on' : ''}" data-act="tapTank" data-tank="${P.BOTH}" aria-label="Both tanks${on ? ', selected now' : ', tap to record a switch'}">BOTH${on ? '<span>ON</span>' : ''}</button>`;

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
  const parked = P.parkedTanks(f, T);
  const onNow = (id) => P.tanksOf(cfg, est.active).includes(id);
  const el = $('#elapsed'); if (el && f.engineStart) el.textContent = fmtTimerS(timerAt(f, now())); // header is always the live timer
  const z = $('#flyZ'); if (z) z.textContent = flyMode(f) === 'timer' ? `${hm(T)} · ${zt(T)}` : zt(T);

  let landedCard = '';
  if (started && est.frozen) {
    landedCard = `<div class="issue warn" style="flex-direction:column;gap:8px"><div class="row" style="gap:10px">${ICON.warn}<div><b>Assumed landed at ${fmtTimer(timerAt(f, f.freezeAt))}</b> (${hm(f.freezeAt)}). Tank levels are frozen there so nothing keeps burning.</div></div>
      <div class="row"><button class="btn primary grow" style="height:48px;font-size:15px" data-act="alertShutdown">Shut down</button><button class="btn grow" data-act="stillFlying">Still flying</button></div></div>`;
  } else if (started && est.empty) {
    landedCard = `<div class="issue error" style="flex-direction:column;gap:8px"><div class="row" style="gap:10px">${ICON.warn}<div><b>${esc(est.empty.tank)} would be empty at ${fmtTimer(timerAt(f, est.empty.at))}</b> (${hm(est.empty.at)}), so a switch was probably missed. The estimate stops burning until you record it.</div></div>
      <button class="btn primary" style="height:48px;font-size:15px" data-act="emptySwitch">Record the switch</button></div>`;
  }
  let next = '';
  if (started && !est.frozen) {
    // While viewing another moment, use the plan that was in force then, not today's rebuilt one.
    const legs = planAbs(f, ui.viewTime ? planAt(f, T) : f.plan);
    const sw = ui.viewTime ? f.events.filter((e) => e.type === 'switch' && e.at > T).sort((a, b) => a.at - b.at)[0] : null;
    const actual = sw ? `<div class="row small mut">Actually switched to ${esc(sw.tank)} at ${fmtTimerS(timerAt(f, sw.at))} (${hm(sw.at)})</div>` : '';
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
        <div class="row between"><span class="mut small">${ui.viewTime ? `At ${fmtTimer(timerAt(f, T))}: ` : ''}${due.overdue ? (ui.viewTime ? 'plan says switch' : 'Plan says switch now') : (ui.viewTime ? 'next planned switch' : 'Next planned switch')}</span><span class="mono small mut">${(() => { const n = legs.filter((l, j) => j > 0 && l.start > T && l.tank !== legs[j - 1].tank).length + (due.overdue ? 1 : 0); return `${n} switch${n === 1 ? '' : 'es'} left`; })()}</span></div>
        <div class="row between"><span style="font-size:22px;font-weight:600">${esc(est.active)} → ${esc(due.tank)}</span>
          <span style="text-align:right"><span class="mono" style="font-size:22px;color:${due.overdue ? 'var(--warn)' : 'var(--amber)'}">${fmtTimerS(timerAt(f, due.at))}</span><br><span class="mono" style="font-size:17px;color:${due.overdue ? 'var(--warn)' : 'var(--amber)'}" ${ui.viewTime ? `data-viewcount>${countFromTxt(due.at, T, fmtTimer(timerAt(f, T)))}` : `data-count="${due.at}">${countTxt(due.at)}`}</span><br><span class="z">${hm(due.at)} · ${zt(due.at)}</span></span></div>
        ${actual}
        <div class="row small mut">${ICON.bell}<span>Alert ${cfg.alerts?.preMin ?? 2} min before and at the switch · screen kept awake</span></div>
        <button class="btn primary block" data-act="openSheet" data-sheet="switch">Record switch</button>
      </div>`;
    } else next = `<div class="card"><div class="mut">No more switches planned${legs.length ? ` — stay on ${esc(est.active)}` : ''}.</div>${actual}
        <button class="btn block" data-act="openSheet" data-sheet="switch">Record switch</button></div>`;
  }

  let burnCard = '';
  if (started && !est.frozen) {
    const ph = est.phase || P.phaseAt(f, T);
    const climbing = ph.phase === 'climb';
    burnCard = `<div class="card">
      <div class="row between"><span class="mut small">Fuel burn</span><span class="mono small mut">used ${f1(est.used)} gal</span></div>
      <div class="row between" style="align-items:baseline"><span style="font-size:20px;font-weight:600"><span class="ph-${ph.phase}" style="text-transform:capitalize">${ph.phase}</span> · <span class="mono">${f1(ph.gph)}</span> <span class="small mut">gph</span></span>
        <span class="small mut">${climbing ? `since ${fmtTimer(timerAt(f, ph.since))} · level ${ph.until ? `${ph.until > T ? 'exp. ' : ''}${fmtTimer(timerAt(f, ph.until))}` : `exp. ${fmtTimer(timerAt(f, ph.since + P.climbLenMin(f, P.activeClimb(f, T)) * MIN))}, tap Level off`}` : ph.phase === 'descent' ? `since ${fmtTimer(timerAt(f, ph.since))}${ph.until ? ` · level ${fmtTimer(timerAt(f, ph.until))}` : ' · Level off between steps'}` : ph.taxiIn ? `taxi-in since ${fmtTimer(timerAt(f, ph.since))}` : ph.phase === 'taxi' ? 'before takeoff' : ''}</span></div>
      ${ph.phase === 'taxi' && !ph.taxiIn ? '' : ph.taxiIn ? `<div class="grid2">
        <button class="btn" data-act="openSheet" data-sheet="check">GI 275</button>
        <button class="btn outline" data-act="openSheet" data-sheet="shutdown">Shut down</button></div>` : ph.phase === 'descent' ? `<div class="grid3">
        <button class="btn outline" data-act="openSheet" data-sheet="level">Level off</button>
        <button class="btn outline" data-act="openSheet" data-sheet="landed">Landed</button>
        <button class="btn" data-act="openSheet" data-sheet="check">GI 275</button></div>` : `<div class="grid2">
        ${climbing ? '<button class="btn outline" data-act="openSheet" data-sheet="level">Level off</button>' : '<button class="btn" data-act="openSheet" data-sheet="climb">Climb</button>'}
        <button class="btn" data-act="openSheet" data-sheet="descent">Descend</button>
        <button class="btn" data-act="openSheet" data-sheet="burn" ${climbing ? 'disabled' : ''}>Set burn</button>
        <button class="btn" data-act="openSheet" data-sheet="check">GI 275</button></div>`}
    </div>`;
  }
  let dest = '';
  if (started && !est.frozen && !P.landingAt(f, T)) {
    const rs = P.remainingSegs(f, T);
    const need = P.fuelBetween(rs.segs, rs.startMin, rs.endMin); // through taxi-in
    const req = requiredLanding(f, T);
    const lands = est.total - need;
    const arr = MS(f, rs.landMin ?? rs.endMin);
    const ok = lands >= req - P.TOL;
    const resRate = P.reserveGph(cfg);
    const reachAt = !ok && est.total > req ? MS(f, rs.startMin + P.timeForFuel(rs.segs, rs.startMin, est.total - req)) : null;
    dest = `<div class="card">
      <div class="row between"><span class="mut small">To ${esc(f.divert?.ident || f.to || 'destination')}</span><span style="text-align:right">${timerZ(f, arr)}<br><span class="z">${dur((rs.landMin ?? rs.endMin) - rs.startMin)} to go</span></span></div>
      <div class="kv"><span class="mut">Lands with</span><span class="v" style="color:${ok ? 'var(--tx)' : 'var(--warn)'}">${f1(lands)} = ${dur((lands / resRate) * 60)} @ ${f1(resRate)}</span></div>
      <div class="kv"><span class="mut">Reserve${f.alt?.on ? ' + alternate' : ''}</span><span class="v">${f1(req)}</span></div>
      ${!ok ? `<div class="issue error">${ICON.warn}<div>${f1(req - lands)} gal short of reserve${reachAt ? `; reserve reached at ${fmtTimer(timerAt(f, reachAt))} (${hm(reachAt)})` : ''}. Update ETE to replan or plan a fuel stop.</div></div>` : ''}
      <button class="btn outline block" data-act="openSheet" data-sheet="ete">Update ETE</button>
    </div>`;
  }

  box.innerHTML = `<div class="plane">${planeSvg(cfg)}
      <div class="gauges">${L.map((t) => gauge(cfg, t, est.levels[t.id], onNow(t.id), parked.includes(t.id))).join('')}<div class="mid">${cfg.both ? bothButton(est.active === P.BOTH) : ''}</div>${C.map((t) => gauge(cfg, t, est.levels[t.id], onNow(t.id), parked.includes(t.id))).join('')}${C.length ? '<div class="mid"></div>' : ''}${R.map((t) => gauge(cfg, t, est.levels[t.id], onNow(t.id), parked.includes(t.id))).join('')}</div>
    </div>
    <div class="sides"><div><span class="mut">Left</span><span class="v">${f1(SL)}</span></div><div class="tot" style="align-items:center"><span class="mut">Total</span><span class="v">${f1(est.total)}</span></div><div style="align-items:flex-end"><span class="mut">Right</span><span class="v">${f1(SR)}</span></div></div>
    <div class="mut small" style="text-align:center;margin-top:10px;line-height:1.4">Imbalance ${f1(Math.abs(imb))} gal${Math.abs(imb) > 0.4 ? ` (${imb < 0 ? 'left' : 'right'} light)` : ''} · limit ${cfg.rules.imbalance.gal} · dashed line = ${cfg.rules.floor.gal} gal floor</div>
    <div class="row between" style="margin-top:6px;gap:10px"><span class="mut small">Tap a tank to record a switch to it</span><button class="btn sm" data-act="openSheet" data-sheet="gauge">Log gauges</button></div>
    <div class="stack" style="margin-top:14px">${landedCard}${next}${burnCard}${dest}</div>`;
}

// =====================================================================
// SHEETS (in-flight inputs)
// =====================================================================
const sheetFlight = () => (ui.sd && ui.sd.fid ? state.flights[ui.sd.fid] : activeFlight());
// Takeoff edits use the same "timer reading now" logic as Start flight.
const takeoffField = () => ui.sheet === 'start' || (ui.sheet === 'edit' && ui.sd.kind === 'takeoff');

function openSheet(name, data = {}) {
  ui.sd = { fid: data.fid };
  const f = sheetFlight();
  const t = now();
  const tmode = takeoffOf(f) && f.engineStart ? timeMode() : 'clock';
  const toField = (ms) => (tmode === 'timer' ? durS(timerAt(f, ms)) : hm(ms));
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
    Object.assign(sd, { at: toField(t), ete: '', fuel: '', gph: '', altFuel: f.alt?.on ? String(f.alt.fuel || '') : '', divert: false, ident: '', prevEte: (rs.landMin ?? rs.endMin) - rs.startMin });
  }
  if (name === 'shutdown') Object.assign(sd, { at: toField(f.freezeAt || t), used: '' });
  if (name === 'climb') Object.assign(sd, { at: toField(t), len: '', gph: String(f.climbGph || f.cfg.burn.climbGph), rebuild: true });
  if (name === 'level') Object.assign(sd, { at: toField(t), rebuild: true });
  if (name === 'descent') { const prev = f.events.filter((e) => e.type === 'descent' && e.at <= t).sort((a, b) => a.at - b.at).pop(); Object.assign(sd, { at: toField(t), gph: String(prev ? prev.gph : P.descentGphOf(f)), rebuild: true }); }
  if (name === 'landed') Object.assign(sd, { at: toField(t), rebuild: true });
  if (name === 'gauge') Object.assign(sd, { at: f.engineStart ? toField(t) : hm(t), tmode: f.engineStart ? sd.tmode : 'clock', vals: {}, note: '' });
  if (name === 'burn') Object.assign(sd, { at: toField(t), gph: '', scope: 'now', was: P.cruiseRateAt(f, t) });
  if (name === 'start') sd.climb = dur(f.climbMin ?? f.cfg.burn.climbMin);
  if (data.atMs) { sd.at = toField(data.atMs); }
  ui.sheet = name; ui.sd = sd;
  renderSheet();
}
function closeSheet() { ui.sheet = null; ui.sd = {}; renderSheet(); if (ui.reloadPending) setTimeout(ui.reloadPending, 300); }
function ask(msg, yesLabel, fn, cls = 'danger') { ui.sheet = 'confirm'; ui.sd = { msg, yesLabel, fn, cls }; renderSheet(); }

function renderSheet() {
  const host = $('#sheet');
  if (!ui.sheet) { host.innerHTML = ''; return; }
  if (ui.sheet === 'confirm') {
    host.innerHTML = `<div class="scrim" data-act="scrim"><div class="sheet" role="alertdialog" aria-modal="true" aria-label="Confirm">
      <h2>${esc(ui.sd.msg)}</h2><div class="row"><button class="btn grow" data-act="closeSheet">Cancel</button><button class="btn ${ui.sd.cls || 'danger'} grow" data-act="confirmYes">${esc(ui.sd.yesLabel)}</button></div></div></div>`;
    return;
  }
  const f = sheetFlight();
  const body = { gauge: sheetGauge, burn: sheetBurn, edit: sheetEdit, switch: sheetSwitch, start: sheetStart, climb: sheetClimb, level: sheetLevel, check: sheetCheck, ete: sheetEte, shutdown: sheetShutdown, descent: sheetDescent, landed: sheetLanded }[ui.sheet];
  if (!body || !f) { ui.sheet = null; host.innerHTML = ''; return; }
  const [title, inner] = body(f);
  host.innerHTML = `<div class="scrim" data-act="scrim"><div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="row between"><h2>${esc(title)}</h2><button class="iconbtn" data-act="closeSheet" aria-label="Close">${ICON.x}</button></div>${inner}</div></div>`;
  renderSheetPreview();
}

function timeField(id, label) {
  const f = sheetFlight();
  const canToggle = takeoffField() || !!(f && f.engineStart);
  const tm = ui.sd.tmode;
  const lbl = typeof label === 'function' ? label(tm) : `${label} · ${tm === 'timer' ? 'flight timer' : `${clockLabel()} clock`}`;
  const nowBtns = takeoffField() && tm === 'timer' ? '' : `<button class="btn" style="width:60px;height:52px" data-act="sdMinus">−1m</button><button class="btn" style="width:64px;height:52px" data-act="sdNow">Now</button>`;
  return `<div class="field"><div class="row between"><label for="${id}">${lbl}</label>${canToggle ? `<button class="btn sm" style="height:32px" data-act="sdTmode">${tm === 'timer' ? 'Use clock' : 'Use timer'}</button>` : ''}</div>
  <div class="row"><input id="${id}" class="big key grow" data-fmt="${tm === 'timer' ? 'hms' : 'hm'}" data-sd="at" value="${esc(ui.sd.at)}" inputmode="numeric" placeholder="${tm === 'timer' ? '1:12:00' : '15:48'}">${nowBtns}</div>
  <div class="z" id="sdAtOther"></div></div>`;
}

// A takeoff more than an hour past this flight's whole ETE is almost certainly a typo
// (e.g. a minutes:seconds reading such as 20:00 typed for 20 minutes).
function startLooksWrong(f, takeoffMs) {
  const sinceMin = (now() - takeoffMs) / MIN;
  if (ui.sd.longOk || !(sinceMin > (f.eteMin || 0) + 60)) return null;
  const d = P.parseDur(ui.sd.at);
  const guess = ui.sd.tmode === 'timer' && isFinite(d) ? durS(d / 60) : null;
  return { sinceMin, guess: guess && guess !== ui.sd.at && P.parseDur(guess) <= (f.eteMin || 0) + 60 ? guess : null };
}
const hrsMins = (m) => `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, '0')} min`;

function sheetStart(f) {
  const tanks = P.selectable(f.cfg);
  const rows = ui.sd.rows || [];
  const manual = ui.sd.sofar === 'manual';
  return ['Start flight', `${timeField('sd-at', (tm) => (tm === 'timer' ? 'Flight timer right now (h:mm:ss)' : `Takeoff time (${clockLabel()} clock)`))}
    <div class="field"><label>Takeoff tank</label><div class="tankpick">${tanks.map((t) => `<button data-act="sdTank" data-tank="${esc(t.id)}" class="${ui.sd.tank === t.id ? 'sel' : ''}"><span class="t">${esc(t.id)}</span><span class="s">${f1(P.feedLevel(f.cfg, f.startLevels, t.id))}</span></button>`).join('')}</div></div>
    <div class="field"><span class="lbl">Since takeoff</span><div class="grid2">
      <button class="btn ${!manual ? 'outline' : ''}" data-act="sdSofar" data-v="plan" aria-pressed="${!manual}">Followed the plan</button>
      <button class="btn ${manual ? 'outline' : ''}" data-act="sdSofar" data-v="manual" aria-pressed="${manual}">Enter what I did</button></div></div>
    ${manual ? `<div class="stack" style="gap:8px">
      ${rows.map((r, i) => `<div class="row"><span class="mut small" style="width:52px">Switch ${i + 1}</span>
        <select aria-label="Switch ${i + 1} tank" data-row="${i}.tank" class="mono" style="width:84px">${tanks.map((t) => `<option ${t.id === r.tank ? 'selected' : ''}>${esc(t.id)}</option>`).join('')}</select>
        <span class="mut small">at +</span><input aria-label="Switch ${i + 1} flight timer" class="mono grow" data-fmt="hms" data-row="${i}.at" value="${esc(r.at)}" inputmode="numeric" placeholder="0:45:00">
        <button class="iconbtn" data-act="delRow" data-i="${i}" aria-label="Remove switch ${i + 1}">${ICON.del}</button></div>`).join('')}
      <div class="row"><button class="btn sm" data-act="addRow">+ Add switch</button><span class="mut small grow">Flight timer reading when you switched.</span></div></div>` : ''}
    <div class="grid2">
      <div class="field"><label for="sd-climb">Initial climb took</label><input id="sd-climb" class="mono" data-fmt="hm" data-sd="climb" value="${esc(ui.sd.climb)}" inputmode="numeric"></div>
      <div class="field"><label for="sd-used">GI 275 fuel used (opt.)</label><input id="sd-used" class="mono" data-sd="used" value="${esc(ui.sd.used)}" inputmode="decimal" placeholder="gal"></div>
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
    const at = takeoff - timerOffMin(sheetFlight()) * MIN + d * MIN;
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
    <div class="field"><label>From ${esc(est.active)} to</label><div class="tankpick">${P.selectable(f.cfg).map((t) => `<button data-act="sdTank" data-tank="${esc(t.id)}" class="${ui.sd.tank === t.id ? 'sel' : ''}" ${t.id === est.active ? 'disabled' : ''}><span class="t">${esc(t.id)}</span><span class="s">${t.id === est.active ? 'current' : ui.sd.planned?.tank === t.id ? 'planned' : f1(P.feedLevel(f.cfg, est.levels, t.id))}</span></button>`).join('')}</div></div>
    ${timeField('sd-at', 'Switched at', ui.sd.at)}
    <div class="row between card" style="padding:10px 12px"><div class="stack" style="gap:2px"><span class="lbl">Entered at</span><span class="mono" style="font-size:18px" id="sdEntered">${tz(ui.sd.enteredAt)}</span></div><button class="btn sm outline" data-act="stampEntered" style="height:44px">Stamp now</button></div>
    <div id="sheetPreview"></div>
    <label class="check"><input type="checkbox" data-sd="rebuild" ${ui.sd.rebuild ? 'checked' : ''}>Rebuild rest of plan from this switch</label>
    <button class="btn primary block" data-act="saveSwitch">Save switch</button>
    ${ui.sd.tank && ui.sd.tank !== P.BOTH ? `<button class="btn sm outline" data-act="toggleDone" data-tank="${esc(ui.sd.tank)}" style="align-self:flex-start">${P.parkedTanks(f).includes(ui.sd.tank) ? `Use ${esc(ui.sd.tank)} again` : `Done with ${esc(ui.sd.tank)} for this flight`}</button>` : ''}`];
}

function sheetCheck(f) {
  return ['Fuel check (GI 275)', `${timeField('sd-at', 'Reading time', ui.sd.at)}
    <div class="grid2"><div class="field"><label for="sd-used">GI 275 fuel used (gal)</label><input id="sd-used" class="big key" data-sd="used" value="${esc(ui.sd.used)}" inputmode="decimal"></div>
    <div class="field"><label for="sd-gph">Fuel flow now (opt.)</label><input id="sd-gph" class="big" data-sd="gph" value="${esc(ui.sd.gph)}" inputmode="decimal" placeholder="gph"></div></div>
    <details class="explain"><summary>What this does</summary>
      <p><b>Fuel used</b> is the GI 275 total since engine start. Burnplan treats it as correct and compares it with its own estimate. Climb is the least certain part of the estimate, so the difference goes first to the tank(s) you climbed on since the last check. Only if the GI 275 shows less than even the whole climb could account for does the rest spread over the other tanks you used. Tank levels from here on start from the corrected numbers.</p>
      <p><b>Fuel flow now</b> is optional. If you type it in, it becomes your cruise burn from this time on, the same as Set burn. Burnplan never works out a cruise burn from the check by itself; leave it blank and your cruise burn stays as it is.</p>
    </details>
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
      <div class="field"><label for="sd-fuel">ForeFlight fuel to it (opt., compare only)</label><input id="sd-fuel" class="big" data-sd="fuel" value="${esc(ui.sd.fuel)}" inputmode="decimal" placeholder="45.1"></div>
    </div>
    <div class="grid2">
      <div class="field"><label for="sd-gph">New cruise gph (opt.) · now ${f1(P.cruiseRateAt(f, now()))}</label><input id="sd-gph" class="mono" data-sd="gph" value="${esc(ui.sd.gph)}" inputmode="decimal" placeholder="${f1(P.cruiseRateAt(f, now()))} (keep)"></div>
      ${f.alt?.on ? `<div class="field"><label for="sd-alt">Alternate fuel</label><input id="sd-alt" class="mono" data-sd="altFuel" value="${esc(ui.sd.altFuel)}" inputmode="decimal"></div>` : '<div></div>'}
    </div>
    <div id="sheetPreview"></div>
    <button class="btn primary block" data-act="saveEte">Save &amp; rebuild plan</button>`];
}

const EV_LABEL = { gauge: 'Gauges', burn: 'Cruise burn', takeoff: 'Takeoff', engine: 'Taxi', switch: 'Switch', climb: 'Climb', level: 'Level off', check: 'Fuel check', ete: 'ETE update', shutdown: 'Shutdown', reactivate: 'Reactivation', note: 'Note', park: 'Tank done', unpark: 'Tank back in use', descent: 'Descent', landing: 'Landing' };

function sheetEdit(f) {
  const k = ui.sd.kind, isNew = ui.sd.i < 0;
  const title = `${isNew ? 'Add' : 'Edit'} ${EV_LABEL[k] || k}`;
  let fields = '';
  if (k === 'engine') {
    fields = `<div class="field"><label for="sd-taxi">Taxi minutes before takeoff</label><input id="sd-taxi" class="big key" data-sd="taxi" value="${esc(ui.sd.taxi)}" inputmode="numeric"></div>
      <div class="field"><label>Taxi tank</label><div class="tankpick">${P.selectable(f.cfg).map((t) => `<button data-act="sdTank" data-tank="${esc(t.id)}" class="${ui.sd.tank === t.id ? 'sel' : ''}"><span class="t">${esc(t.id)}</span></button>`).join('')}</div></div>`;
  } else {
    fields = timeField('sd-at', k === 'takeoff' ? (tm) => (tm === 'timer' ? 'Flight timer right now' : `Takeoff time (${clockLabel()} clock)`) : k === 'climb' ? 'Climb started' : k === 'switch' ? 'Switched at' : 'At');
    if (k === 'takeoff') fields += `<label class="check"><input type="checkbox" data-sd="shift" ${ui.sd.shift ? 'checked' : ''}>Keep my other entries at the same flight timer readings</label>`;
    if (k === 'switch') fields += `<div class="field"><label>Switched to</label><div class="tankpick">${P.selectable(f.cfg).map((t) => `<button data-act="sdTank" data-tank="${esc(t.id)}" class="${ui.sd.tank === t.id ? 'sel' : ''}"><span class="t">${esc(t.id)}</span></button>`).join('')}</div></div>`;
    if (k === 'climb') fields += `<div class="grid2"><div class="field"><label for="sd-len">Climb length</label><input id="sd-len" class="big" data-fmt="hm" data-sd="len" value="${esc(ui.sd.len)}" inputmode="numeric" placeholder="still climbing"></div>
      <div class="field"><label for="sd-cgph">Climb gph</label><input id="sd-cgph" class="big" data-sd="gph" value="${esc(ui.sd.gph)}" inputmode="decimal"></div></div>`;
    if (k === 'gauge') fields += `<div class="grid4">${f.cfg.tanks.map((t) => `<div class="field"><label for="g-${t.id}">${esc(t.id)} <span class="dim">/${t.capacity}</span></label><input id="g-${t.id}" class="mono" data-gauge="${esc(t.id)}" value="${esc(ui.sd.vals?.[t.id] ?? '')}" inputmode="decimal"></div>`).join('')}</div>
      <div class="field"><label for="sd-note">Note</label><input id="sd-note" data-sd="note" value="${esc(ui.sd.note || '')}"></div>`;
    if (k === 'burn') fields += `<div class="field"><label for="sd-gph">Cruise fuel flow (gph)</label><input id="sd-gph" class="big key" data-sd="gph" value="${esc(ui.sd.gph)}" inputmode="decimal"></div>
      <label class="check"><input type="checkbox" data-sd="allScope" ${ui.sd.allScope ? 'checked' : ''}>Applies to the whole cruise</label>`;
    if (k === 'descent') fields += `<div class="grid2"><div class="field"><label for="sd-len">Step length (opt.)</label><input id="sd-len" class="big" data-fmt="hm" data-sd="len" value="${esc(ui.sd.len)}" inputmode="numeric" placeholder="until next entry"></div>
      <div class="field"><label for="sd-dgph">Descent gph</label><input id="sd-dgph" class="big" data-sd="gph" value="${esc(ui.sd.gph)}" inputmode="decimal"></div></div>`;
    if (k === 'note') fields += `<div class="field"><label for="sd-note">Note</label><textarea id="sd-note" data-sd="note" rows="3" class="key" placeholder="Anything worth remembering about this flight">${esc(ui.sd.note || '')}</textarea></div>`;
    if (k === 'check' || k === 'shutdown') fields += `<div class="field"><label for="sd-used">GI 275 fuel used since start</label><input id="sd-used" class="big ${k === 'check' ? 'key' : ''}" data-sd="used" value="${esc(ui.sd.used)}" inputmode="decimal"></div>`;
    if (k === 'check') fields += `<div class="field"><label for="sd-flow">Fuel flow (sets cruise burn from here; blank = no change)</label><input id="sd-flow" class="big" data-sd="flow" value="${esc(ui.sd.flow)}" inputmode="decimal"></div>`;
    if (k === 'ete') fields += `<div class="grid2"><div class="field"><label for="sd-ete">ETE</label><input id="sd-ete" class="big key" data-fmt="hm" data-sd="ete" value="${esc(ui.sd.ete)}" inputmode="numeric"></div>
      <div class="field"><label for="sd-fuel">Fuel to it</label><input id="sd-fuel" class="big" data-sd="fuel" value="${esc(ui.sd.fuel)}" inputmode="decimal"></div></div>`;
  }
  const canDelete = !isNew && !['takeoff', 'engine'].includes(k);
  return [title, `${fields}
    <div id="sheetPreview"></div>
    <div class="mut small">${f.status === 'active' ? 'Tank levels are recalculated from the corrected history and the rest of the plan is rebuilt.' : 'The saved flight is corrected.'}</div>
    <div class="row">${canDelete ? '<button class="btn danger grow" data-act="deleteEvent">Delete</button>' : ''}<button class="btn primary grow" data-act="saveEdit">Save</button></div>`];
}

function openEdit(f, i, kind) {
  const e = i >= 0 ? f.events[i] : { type: kind, at: now() };
  ui.sheet = 'edit';
  const tmode = e.type === 'takeoff' ? 'clock' : (f.engineStart ? timeMode() : 'clock');
  ui.sd = { fid: f.id, i, kind: e.type, tmode, enteredAt: now(), atStamp: now() };
  ui.sd.at = e.type === 'takeoff' ? hm(e.at) : (tmode === 'timer' ? durS(timerAt(f, e.at)) : hm(e.at));
  Object.assign(ui.sd, {
    tank: e.tank || f.cfg.tanks[0].id,
    len: e.until ? dur((e.until - e.at) / MIN) : '',
    gph: String(e.gph || (e.type === 'burn' ? P.cruiseRateAt(f, e.at) : e.type === 'descent' ? P.descentGphOf(f) : f.climbGph || f.cfg.burn.climbGph)),
    allScope: e.scope === 'all',
    flow: e.type === 'check' && e.setsBurn ? String(e.gph) : '',
    vals: e.type === 'gauge' ? Object.fromEntries(Object.entries(e.readings || {}).map(([k, v]) => [k, String(v)])) : {},
    note: e.note || '',
    used: e.used != null ? String(e.used) : '',
    ete: e.eteMin ? dur(e.eteMin) : '', fuel: e.fuelToDest ? String(e.fuelToDest) : '',
    taxi: String(f.taxiMin), shift: true
  });
  renderSheet();
}

function afterHistoryEdit(f, reason) {
  f.events.sort((a, b) => a.at - b.at);
  if (f.status === 'active') rebuildFrom(f, now(), reason);
  persist();
}

function saveEdit() {
  const f = sheetFlight();
  const k = ui.sd.kind, i = ui.sd.i;
  if (k === 'engine') {
    const taxi = num(ui.sd.taxi);
    if (!(taxi >= 0)) return toast('Enter taxi minutes');
    const to = takeoffOf(f);
    f.taxiMin = taxi;
    f.engineStart = to - taxi * MIN;
    f.takeoff = to;
    const tl = P.buildTimeline(f.cfg, { taxiMin: taxi, eteMin: f.eteMin, climbMin: f.climbMin, climbGph: f.climbGph, cruiseGph: f.cruiseGph, descentMin: f.descentMin ?? 0, descentGph: f.descentGph, taxiInMin: f.taxiInMin ?? 0 });
    f.segs = tl.segments; f.blockMin = tl.blockMin;
    f.startTank = ui.sd.tank;
    const ev = f.events[i]; if (ev) { ev.at = f.engineStart; ev.tank = ui.sd.tank; ev.edited = now(); }
    closeSheet(); afterHistoryEdit(f, 'history edit'); toast('Taxi updated'); render(); return;
  }
  const t = sheetTime();
  if (!isFinite(t)) return toast('Check the time');
  if (k === 'takeoff') {
    const taxi = f.taxiMin || 0;
    const delta = t - takeoffOf(f);
    f.takeoff = t; f.engineStart = t - taxi * MIN;
    const ev = f.events[i]; ev.at = t; ev.edited = now();
    const eng = f.events.find((e) => e.type === 'engine'); if (eng) eng.at = f.engineStart;
    for (const e of f.events) {
      if (e === ev || e === eng) continue;
      if (ui.sd.shift || (e.type === 'climb' && e.initial)) { e.at += delta; if (e.until) e.until += delta; if (e.planned) e.planned.at += delta; }
    }
    if (ui.sd.shift && f.shutdown) f.shutdown += delta;
    closeSheet(); afterHistoryEdit(f, 'history edit'); toast('Takeoff updated'); render(); return;
  }
  const ev = i >= 0 ? f.events[i] : { type: k, enteredAt: now(), added: true };
  ev.at = t; ev.edited = now();
  if (k === 'switch') ev.tank = ui.sd.tank;
  if (k === 'gauge') {
    const readings = {};
    for (const x of f.cfg.tanks) { const v = parseGauge(ui.sd.vals?.[x.id], x.capacity); if (v == null) continue; if (!isFinite(v)) return toast(`Can't read the ${x.id} value`); readings[x.id] = Math.round(v * 10) / 10; }
    if (!Object.keys(readings).length) return toast('Enter at least one tank');
    ev.readings = readings; ev.note = (ui.sd.note || '').trim() || null; ev.phase = gaugePhase(f, t);
  }
  if (k === 'descent') { const g = num(ui.sd.gph); if (!(g > 0)) return toast('Enter the descent fuel flow'); ev.gph = g; const len = P.parseDur(ui.sd.len); ev.until = isFinite(len) && len > 0 ? t + len * MIN : null; }
  if (k === 'landing') { const other = f.events.find((x) => x.type === 'landing' && x !== f.events[i]); if (other) return toast('There is already a landing; edit that one'); f.freezeAt = null; }
  if (k === 'note') { const n = (ui.sd.note || '').trim(); if (!n) return toast('Type a note'); ev.note = n; }
  if (k === 'burn') { const g = num(ui.sd.gph); if (!(g > 0)) return toast('Enter the cruise fuel flow'); ev.gph = g; ev.scope = ui.sd.allScope ? 'all' : undefined; }
  if (k === 'climb') { const len = P.parseDur(ui.sd.len); ev.until = isFinite(len) && len > 0 ? t + len * MIN : null; ev.gph = num(ui.sd.gph) > 0 ? num(ui.sd.gph) : ev.gph || f.climbGph; }
  if (k === 'check') { const u = num(ui.sd.used); if (!isFinite(u)) return toast('Enter fuel used'); ev.used = u; const g = num(ui.sd.flow); ev.gph = g > 0 ? g : null; ev.setsBurn = g > 0; }
  if (k === 'shutdown') { const u = num(ui.sd.used); ev.used = isFinite(u) ? u : null; ev.assumed = false; f.shutdown = t; f.finalUsed = ev.used; f.autoEnded = false; }
  if (k === 'ete') { const d = P.parseDur(ui.sd.ete); if (!isFinite(d)) return toast('Enter ETE'); ev.eteMin = d; ev.fuelToDest = num(ui.sd.fuel) || null; }
  if (i < 0) f.events.push(ev);
  if (k === 'gauge' || k === 'note') { f.events.sort((a, b) => a.at - b.at); persist(); closeSheet(); toast(i < 0 ? 'Added' : 'Updated'); render(); return; } // no recalculation
  closeSheet(); afterHistoryEdit(f, 'history edit'); toast(i < 0 ? 'Added' : 'Updated'); render();
}

function sheetClimb(f) {
  return ['Climb', `${timeField('sd-at', 'Climb started')}
    <div class="grid2">
      <div class="field"><label for="sd-len">Climb length</label><input id="sd-len" class="big" data-fmt="hm" data-sd="len" value="${esc(ui.sd.len)}" inputmode="numeric" placeholder="still climbing"></div>
      <div class="field"><label for="sd-cgph">Climb gph</label><input id="sd-cgph" class="big" data-sd="gph" value="${esc(ui.sd.gph)}" inputmode="decimal"></div>
    </div>
    <div class="mut small">Leave the length blank if you're still climbing and tap Level off when you level. Until then it assumes a ${Math.round(P.climbLenMin(f, null))}-minute climb (the aircraft's mid-flight climb setting).</div>
    <div id="sheetPreview"></div>
    <label class="check"><input type="checkbox" data-sd="rebuild" ${ui.sd.rebuild ? 'checked' : ''}>Rebuild rest of plan</label>
    <button class="btn primary block" data-act="saveClimb">Save climb</button>`];
}

function sheetGauge(f) {
  return ['Log gauge readings', `
    ${timeField('sd-at', 'Read at')}
    <div class="grid4">${f.cfg.tanks.map((t) => `<div class="field"><label for="g-${t.id}" style="color:${tankColor(f.cfg, t.id)}">${esc(t.id)} <span class="dim">/${t.capacity}</span></label><input id="g-${t.id}" class="mono" data-gauge="${esc(t.id)}" value="${esc(ui.sd.vals?.[t.id] ?? '')}" placeholder="gal" inputmode="decimal"></div>`).join('')}</div>
    <div class="mut small">Gallons, or a fraction like 3/4, a percent, F or E. Leave a tank blank to skip it.</div>
    <div class="field"><label for="sd-note">Note (optional)</label><input id="sd-note" data-sd="note" value="${esc(ui.sd.note)}" placeholder="e.g. level, 10 min after level-off"></div>
    <div id="sheetPreview"></div>
    <div class="mut small">For calibration only: readings are saved to the log and never change any calculation.</div>
    <button class="btn primary block" data-act="saveGauge">Save readings</button>`];
}

function sheetBurn(f) {
  const all = ui.sd.scope === 'all';
  return ['Set cruise burn', `
    <div class="field"><label for="sd-gph">Cruise fuel flow (gph) · now ${f1(ui.sd.was)}</label><input id="sd-gph" class="big key" data-sd="gph" value="${esc(ui.sd.gph)}" inputmode="decimal" placeholder="${f1(ui.sd.was)}"></div>
    ${all ? `<div class="issue info">${ICON.info}<div>Applies to the <b>whole cruise</b>, including what you've already flown, so fuel used so far is recalculated. Climb and taxi keep their own rates.</div></div>
      <button class="btn sm" data-act="sdScope" data-v="now" style="align-self:flex-start">Only from a point forward instead</button>`
    : `${timeField('sd-at', 'Starting at')}
      <button class="btn sm" data-act="sdScope" data-v="all" style="align-self:flex-start">Readjust the whole cruise instead</button>`}
    <div id="sheetPreview"></div>
    <button class="btn primary block" data-act="saveBurn">Save &amp; rebuild plan</button>`];
}

function sheetDescent(f) {
  const cur = P.activeDescent(f, now());
  return [cur ? 'Next descent step' : 'Descend', `${timeField('sd-at', 'Started down at')}
    <div class="field"><label for="sd-dgph">Descent gph (GI 275 fuel flow)</label><input id="sd-dgph" class="big key" data-sd="gph" value="${esc(ui.sd.gph)}" inputmode="decimal"></div>
    <div class="mut small">Record each step of a stepped descent with its own fuel flow, and tap Level off between steps (burn goes back to cruise). It lasts until Level off, Climb or Landed. The rest of the plan assumes this rate until landing.</div>
    <div id="sheetPreview"></div>
    <label class="check"><input type="checkbox" data-sd="rebuild" ${ui.sd.rebuild ? 'checked' : ''}>Rebuild rest of plan</label>
    <button class="btn primary block" data-act="saveDescent">Save descent</button>`];
}

function sheetLanded(f) {
  return ['Landed', `${timeField('sd-at', 'Landed at')}
    <div class="mut small">Taxi-in burns at the ground rate (${f1(P.groundGph(f))} gph) until you shut down. The plan expects ${P.taxiInMinOf(f)} min of taxi.</div>
    <div id="sheetPreview"></div>
    <button class="btn primary block" data-act="saveLanded">Save landing</button>`];
}

function sheetLevel(f) {
  const ph = P.phaseAt(f, now());
  const exp = ph.phase === 'climb' && !ph.until ? ph.since + P.climbLenMin(f, P.activeClimb(f, now())) * MIN : null;
  return ['Level off', `${timeField('sd-at', 'Leveled at')}
    ${exp && exp < now() ? `<div class="row wrap"><button class="btn sm" data-act="sdAtMs" data-ms="${exp}">Expected ${fmtTimer(timerAt(f, exp))}</button></div>` : ''}
    <div id="sheetPreview"></div>
    <label class="check"><input type="checkbox" data-sd="rebuild" ${ui.sd.rebuild ? 'checked' : ''}>Rebuild rest of plan</label>
    <button class="btn primary block" data-act="saveLevel">Save</button>`];
}

function sheetShutdown(f) {
  const arr = arrivalMs(f);
  const picks = [];
  const landEv = P.landingAt(f);
  if (landEv && !f.freezeAt) { const end = landEv.at + P.taxiInMinOf(f) * MIN; if (end < now()) picks.push([end, `Landed + taxi-in ${fmtTimer(timerAt(f, end))}`]); }
  if (f.freezeAt) picks.push([f.freezeAt, `${landEv ? 'Assumed shutdown' : 'Assumed landing'} ${fmtTimer(timerAt(f, f.freezeAt))}`]);
  else if (arr && arr < now()) picks.push([arr, `Expected landing ${fmtTimer(timerAt(f, arr))}`]);
  return ['End flight', `${timeField('sd-at', 'Shut down at')}
    ${picks.length ? `<div class="row wrap">${picks.map(([ms, label]) => `<button class="btn sm" data-act="sdAtMs" data-ms="${ms}">${esc(label)}</button>`).join('')}</div>` : ''}
    <div class="mut small">Enter the flight timer reading (or clock time) when you actually shut down; it can be in the past. Fuel stops burning there.</div>
    <div class="field"><label for="sd-used">GI 275 total fuel used (optional)</label><input id="sd-used" class="big" data-sd="used" value="${esc(ui.sd.used)}" inputmode="decimal"></div>
    <div id="sheetPreview"></div>
    <button class="btn primary block" data-act="saveShutdown">End &amp; save flight</button>`];
}

// The moment the sheet's time field refers to. On the start sheet that is the takeoff time.
function sheetTime() {
  const f = sheetFlight();
  if (ui.sheet === 'burn' && ui.sd.scope === 'all') return now();
  if ((ui.sheet === 'gauge' || (ui.sheet === 'edit' && ui.sd.kind === 'note')) && !f.engineStart) { const c = parseClockZ(ui.sd.at, now()); return isFinite(c) && c <= now() + MIN ? c : NaN; }
  const tm = ui.sd.tmode;
  if (takeoffField()) {
    if (tm === 'timer') {
      const d = P.parseDur(ui.sd.at);
      return isFinite(d) ? (ui.sd.atStamp || now()) - d * MIN + timerOffMin(f) * MIN : NaN;
    }
    const t = parseClockZ(ui.sd.at, now());
    return isFinite(t) && t <= now() + MIN ? t : NaN;
  }
  let t;
  if (tm === 'timer' && takeoffOf(f)) {
    const d = P.parseDur(ui.sd.at);
    t = isFinite(d) ? fromTimer(f, d) : NaN;
  } else t = parseClockZ(ui.sd.at, now());
  if (!isFinite(t)) return NaN;
  if (f.engineStart && t < f.engineStart) return NaN;
  if (t > now() + 2 * MIN) return NaN;
  return t;
}

function sheetFieldValue(ms) {
  const f = sheetFlight();
  if (takeoffField()) return ui.sd.tmode === 'timer' ? durS((now() - ms) / MIN + timerOffMin(f)) : hm(ms);
  return ui.sd.tmode === 'timer' ? durS(timerAt(f, ms)) : hm(ms);
}

function renderSheetPreview() {
  const box = $('#sheetPreview');
  const f = sheetFlight();
  if (!box || !f) return;
  const t = sheetTime();
  const other = $('#sdAtOther');
  if (!isFinite(t)) {
    if (other) other.textContent = '';
    box.innerHTML = ui.sd.at ? `<div class="issue warn">${ICON.warn}<div>${takeoffField() ? 'Enter the flight timer (h:mm) or takeoff time.' : 'Enter a time between takeoff and now.'}</div></div>` : '';
    return;
  }
  if (other) other.innerHTML = takeoffField()
    ? `Takeoff ${hm(t)} · ${zt(t)}`
    : ui.sd.tmode === 'timer' ? `${hm(t)} ${clockMode() === 'zulu' ? '' : zoneAbbr(viewZone(), t)} · ${zt(t)}` : (takeoffOf(f) ? `timer ${fmtTimer(timerAt(f, t))} · ${zt(t)}` : zt(t));
  if (ui.sheet === 'start') {
    if (other && ui.sd.tmode === 'timer') other.innerHTML = `${hrsMins((now() - t) / MIN)} since takeoff · took off ${hm(t)} · ${utcHM(t)}`;
    const bad = startLooksWrong(f, t);
    if (bad) {
      box.innerHTML = `<div class="issue error" style="flex-direction:column;gap:8px"><div class="row" style="gap:10px">${ICON.warn}<div>That's <b>${hrsMins(bad.sinceMin)}</b> since takeoff, longer than this whole flight (${dur(f.eteMin)}). The flight timer is <b>h:mm:ss</b>.</div></div>
        <div class="row wrap">${bad.guess ? `<button class="btn sm outline" data-act="sdUseGuess" data-v="${bad.guess}">Use ${bad.guess} (${hrsMins(P.parseDur(bad.guess))})</button>` : ''}<button class="btn sm" data-act="sdLongOk">It's right</button></div></div>`;
      return;
    }
    const engine = t - f.taxiMin * MIN;
    const sw = ui.sd.sofar === 'manual' ? manualSwitches(t, ui.sd.tank) : { list: plannedSwitchesBefore(f, engine, ui.sd.tank, now()) };
    if (sw.error) { box.innerHTML = `<div class="issue warn">${ICON.warn}<div>${esc(sw.error)}</div></div>`; return; }
    const lines = sw.list.map((x) => `<div class="kv"><span class="mut">Switch → ${esc(x.tank)}</span><span class="v">+${dur((x.at - t) / MIN + timerOffMin(f))} · ${hm(x.at)}</span></div>`).join('');
    const cur = sw.list.length ? sw.list[sw.list.length - 1].tank : ui.sd.tank;
    const cl = P.parseDur(ui.sd.climb);
    const climbLine = isFinite(cl) ? `<div class="kv"><span class="mut">Climb ${dur(cl)} @ ${f1(f.climbGph || f.cfg.burn.climbGph)}</span><span class="v">level ${t + cl * MIN > now() ? 'expected ' : ''}+${dur(cl + timerOffMin(f))}</span></div>` : '';
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
  if (ui.sheet === 'gauge') {
    const calc = calcLevels(f, t);
    const rows = f.cfg.tanks.map((x) => {
      const ind = parseGauge(ui.sd.vals?.[x.id], x.capacity);
      // every tank always has a row, so the sheet doesn't jump as readings are typed
      if (ind == null) return `<div class="kv"><span class="mut">${esc(x.id)} indicated · calculated</span><span class="v"><span class="mut">— · ${f1(calc[x.id])}</span></span></div>`;
      if (!isFinite(ind)) return `<div class="kv"><span class="mut">${esc(x.id)}</span><span class="v" style="color:var(--warn)">can't read that</span></div>`;
      const d = ind - calc[x.id];
      return `<div class="kv"><span class="mut">${esc(x.id)} indicated · calculated</span><span class="v">${f1(ind)} · ${f1(calc[x.id])} <span style="color:${Math.abs(d) >= 2 ? 'var(--amber)' : 'var(--mut)'}">(${d >= 0 ? '+' : ''}${f1(d)})</span></span></div>`;
    }).join('');
    box.innerHTML = `<div class="kv"><span class="mut">Phase</span><span class="v">${esc(gaugePhase(f, t))}</span></div>${rows}`;
    return;
  }
  if (ui.sheet === 'burn') {
    const g = num(ui.sd.gph);
    if (!(g > 0)) { box.innerHTML = ''; return; }
    const at = ui.sd.scope === 'all' ? now() : t;
    const trial = { ...f, events: [...f.events, { type: 'burn', at, gph: g, scope: ui.sd.scope === 'all' ? 'all' : undefined }] };
    const a = P.estimate(f, f.cfg, now()), b = P.estimate(trial, f.cfg, now());
    const rsA = P.remainingSegs(f, now()), rsB = P.remainingSegs(trial, now());
    const landA = a.total - P.fuelBetween(rsA.segs, rsA.startMin, rsA.endMin), landB = b.total - P.fuelBetween(rsB.segs, rsB.startMin, rsB.endMin);
    const sg = (x) => `${x >= 0 ? '+' : ''}${f1(x)}`;
    box.innerHTML = `<div class="kv"><span class="mut">${ui.sd.scope === 'all' ? 'Whole cruise' : `From ${fmtTimer(timerAt(f, t))}`}</span><span class="v">${f1(ui.sd.was)} → ${f1(g)} gph</span></div>
      ${ui.sd.scope === 'all' || t < now() - MIN ? `<div class="kv"><span class="mut">Fuel aboard now</span><span class="v">${f1(a.total)} → ${f1(b.total)} (${sg(b.total - a.total)})</span></div>` : ''}
      <div class="kv"><span class="mut">Lands with</span><span class="v">${f1(landA)} → ${f1(landB)} (${sg(landB - landA)})</span></div>`;
    return;
  }
  if (ui.sheet === 'shutdown') {
    const est = P.estimate({ ...f, freezeAt: null }, f.cfg, t);
    const u = num(ui.sd.used);
    box.innerHTML = `<div class="kv"><span class="mut">Ends with (est.)</span><span class="v">${f.cfg.tanks.map((x) => `${esc(x.id)} ${f1(Math.max(0, est.levels[x.id]))}`).join(' · ')}</span></div>
      <div class="kv"><span class="mut">Total aboard · used</span><span class="v">${f1(est.total)} · ${f1(est.used)}${isFinite(u) ? ` (GI 275 ${f1(u)})` : ''}</span></div>
      ${est.empty ? `<div class="issue warn">${ICON.warn}<div>${esc(est.empty.tank)} would have run empty at ${fmtTimer(timerAt(f, est.empty.at))}; record the missed switch in Edit history afterwards.</div></div>` : ''}`;
  }
  if (ui.sheet === 'check') {
    const est = P.estimate(f, f.cfg, t);
    const u = num(ui.sd.used), g = num(ui.sd.gph);
    let html = `<div class="kv"><span class="mut">Burnplan's estimate of fuel used</span><span class="v">${f1(est.used)}</span></div>`;
    if (isFinite(u)) {
      const diff = u - est.used;
      const after = P.estimate({ ...f, events: [...f.events, { type: 'check', at: t, used: u }] }, f.cfg, t);
      const changed = f.cfg.tanks.filter((x) => Math.abs(after.levels[x.id] - est.levels[x.id]) >= 0.05);
      html += `<div class="kv"><span class="mut">GI 275 says you've burned</span><span class="v" style="color:${Math.abs(diff) > 1 ? 'var(--amber)' : 'var(--tx)'}">${Math.abs(diff) < 0.05 ? 'the same' : `${f1(Math.abs(diff))} gal ${diff > 0 ? 'more' : 'less'}`}</span></div>`;
      if (changed.length) html += `<div class="kv"><span class="mut">Tanks corrected</span><span class="v">${changed.map((x) => `${esc(x.id)} ${f1(est.levels[x.id])} → ${f1(after.levels[x.id])}`).join('<br>')}</span></div>`;
      html += `<div class="kv"><span class="mut">Average since engine start (info only)</span><span class="v">${f1(u / ((t - f.engineStart) / HOUR))} gph</span></div>`;
    }
    if (g > 0) html += `<div class="kv"><span class="mut">Cruise burn from ${fmtTimer(timerAt(f, t))}</span><span class="v">${f1(P.cruiseRateAt(f, t))} → ${f1(g)} gph</span></div>`;
    box.innerHTML = html;
  }
  if (ui.sheet === 'ete') {
    const est = P.estimate(f, f.cfg, t);
    const ete = P.parseDur(ui.sd.ete);
    const fuel = num(ui.sd.fuel), gph = num(ui.sd.gph);
    const aboveFloors = f.cfg.tanks.reduce((a, x) => a + Math.max(0, est.levels[x.id] - f.cfg.rules.floor.gal), 0);
    let html = `<div class="kv"><span class="mut">Aboard (est.)</span><span class="v">${f1(est.total)} · ${f1(aboveFloors)} above floors</span></div>`;
    if (isFinite(ete) && ete > 0) {
      const rate = gph > 0 ? gph : P.cruiseRateAt(f, t);
      const need = (rate * ete) / 60;
      const alt = f.alt?.on && !ui.sd.divert ? num(ui.sd.altFuel) || 0 : 0;
      const req = P.reserveGal(f.cfg) + alt;
      const lands = est.total - need;
      const ok = lands >= req - P.TOL;
      const reach = !ok && rate > 0 ? t + ((est.total - req) / rate) * HOUR : null;
      const arr = t + ete * MIN;
      html += `<div class="issue ${ok ? 'info' : 'error'}" style="flex-direction:column;gap:4px">
        <div class="kv" style="width:100%"><b>${ok ? 'Makes it' : `${f1(req - lands)} gal short of reserve`}</b><span class="v">arr ${hm(arr)} <span class="z">${zt(arr)}</span></span></div>
        <div class="kv" style="width:100%"><span>Needs ${f1(need)} @ ${f1(rate)} gph · lands with</span><span class="v">${f1(lands)} = ${dur((lands / P.reserveGph(f.cfg)) * 60)}</span></div>
        ${fuel > 0 ? `<div class="kv" style="width:100%"><span class="mut">ForeFlight says ${f1(fuel)} (${f1(fuel / (ete / 60))} gph)</span><span class="v mut">${fuel > need ? '+' : ''}${f1(fuel - need)} vs Burnplan</span></div>` : ''}
        ${reach ? `<div class="kv" style="width:100%"><span>Reserve reached</span><span class="v">${hm(reach)} · ${Math.round((arr - reach) / MIN)} min before arrival</span></div>` : ''}
      </div>`;
    }
    box.innerHTML = html;
    const dd = $('#eteDest'); if (dd) dd.textContent = ui.sd.divert ? ui.sd.ident || 'stop' : f.divert?.ident || f.to || 'destination';
  }
}

function saveSheet(kind) {
  const f = sheetFlight();
  const t = sheetTime();
  if (!isFinite(t)) return toast('Check the time');
  const enteredAt = ui.sd.enteredAt || now();
  if (ui.sd.tmode) state.settings.timeMode = ui.sd.tmode;
  if (kind === 'start') {
    const takeoff = t;
    if (startLooksWrong(f, takeoff)) { renderSheetPreview(); return toast('Check the flight timer: it is h:mm:ss'); }
    const sw = ui.sd.sofar === 'manual' ? manualSwitches(takeoff, ui.sd.tank) : null;
    if (sw && sw.error) return toast(sw.error);
    f.timerFrom = state.settings.timerFrom || 'takeoff';
    f.takeoff = takeoff; f.engineStart = takeoff - f.taxiMin * MIN; f.startTank = ui.sd.tank; f.status = 'active';
    f.tz = f.tz || phoneTZ();
    ui.viewTime = null;
    if (f.plan.legs[0] && f.plan.legs[0].tank !== f.startTank) setPlan(f, { ...f.plan, legs: f.plan.legs.map((l, i) => (i ? { ...l } : { ...l, tank: f.startTank })), source: 'edited' }, `Takeoff tank set to ${f.startTank}`);
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
  let later = null, msg = '';
  if (kind === 'switch') {
    if (!ui.sd.tank) return toast('Pick a tank');
    // A timer field rounds to the second, so "now" can land up to half a second ahead; keep it now so the switch shows at once.
    const at = t > now() && t - now() < 1000 ? now() : t;
    f.events.push({ type: 'switch', tank: ui.sd.tank, at, enteredAt, planned: ui.sd.planned ? { tank: ui.sd.planned.tank, at: ui.sd.planned.start } : null });
    if (ui.sd.rebuild) later = [Math.max(t, now()), 'after switch'];
    msg = `Switched to ${ui.sd.tank} at ${fmtTimer(timerAt(f, at))}`;
  }
  if (kind === 'check') {
    const u = num(ui.sd.used);
    if (!isFinite(u)) return toast('Enter fuel used');
    const g = num(ui.sd.gph);
    f.events.push({ type: 'check', at: t, enteredAt, used: u, gph: g > 0 ? g : null, setsBurn: g > 0 });
    if (ui.sd.rebuild) later = [Math.max(t, now()), 'after fuel check'];
    msg = `Fuel check saved · tanks corrected to ${f1(u)} gal used${g > 0 ? ` · cruise ${f1(g)} gph` : ''}`;
  }
  if (kind === 'ete') {
    const ete = P.parseDur(ui.sd.ete);
    if (!isFinite(ete) || ete <= 0) return toast('Enter ETE');
    const ev = { type: 'ete', at: t, enteredAt, eteMin: ete, fuelToDest: num(ui.sd.fuel) || null, gph: num(ui.sd.gph) || null, gphSet: num(ui.sd.gph) > 0, altFuel: num(ui.sd.altFuel) || null };
    if (ui.sd.divert) { ev.divert = (ui.sd.ident || 'STOP').toUpperCase(); f.divert = { ident: ev.divert, at: t }; ev.altFuel = 0; if (f.alt) f.alt.onBeforeDivert = f.alt.on; if (f.alt) f.alt.on = false; }
    f.events.push(ev);
    f.freezeAt = null; f.snoozeUntil = null;
    later = [Math.max(t, now()), ui.sd.divert ? 'divert' : 'ETE update'];
    msg = ui.sd.divert ? `Diverting to ${ev.divert}` : `ETE ${dur(ete)} saved`;
  }
  if (kind === 'descent') {
    const gph = num(ui.sd.gph);
    if (!(gph > 0)) return toast('Enter the descent fuel flow');
    f.events.push({ type: 'descent', at: t, enteredAt, gph });
    if (ui.sd.rebuild) later = [Math.max(t, now()), 'descent'];
    msg = `Descending at ${f1(gph)} gph`;
  }
  if (kind === 'landed') {
    if (P.landingAt(f)) return toast('Landing already recorded; edit it in history');
    f.events.push({ type: 'landing', at: t, enteredAt });
    f.freezeAt = null; f.snoozeUntil = null;
    later = [Math.max(t, now()), 'landed'];
    msg = 'Landed · taxi-in';
  }
  if (kind === 'climb') {
    const len = P.parseDur(ui.sd.len), gph = num(ui.sd.gph);
    f.events.push({ type: 'climb', at: t, enteredAt, gph: gph > 0 ? gph : f.climbGph || f.cfg.burn.climbGph, until: isFinite(len) && len > 0 ? t + len * MIN : null });
    if (ui.sd.rebuild) later = [Math.max(t, now()), 'climb'];
    msg = `Climb from ${fmtTimer(timerAt(f, t))}`;
  }
  if (kind === 'gauge') {
    const readings = {};
    for (const x of f.cfg.tanks) {
      const v = parseGauge(ui.sd.vals?.[x.id], x.capacity);
      if (v == null) continue;
      if (!isFinite(v)) return toast(`Can't read the ${x.id} value`);
      readings[x.id] = Math.round(v * 10) / 10;
    }
    if (!Object.keys(readings).length) return toast('Enter at least one tank');
    f.events.push({ type: 'gauge', at: t, enteredAt, readings, note: (ui.sd.note || '').trim() || null, phase: gaugePhase(f, t) });
    closeSheet(); persist(); render();
    return toast(`Gauge readings saved (${Object.keys(readings).length} tank${Object.keys(readings).length > 1 ? 's' : ''})`);
  }
  if (kind === 'burn') {
    const g = num(ui.sd.gph);
    if (!(g > 0)) return toast('Enter the cruise fuel flow');
    const all = ui.sd.scope === 'all';
    f.events.push({ type: 'burn', at: all ? now() : t, enteredAt, gph: g, scope: all ? 'all' : undefined });
    later = [Math.max(t, now()), 'cruise burn'];
    msg = all ? `Whole cruise set to ${f1(g)} gph` : `Cruise ${f1(g)} gph from ${fmtTimer(timerAt(f, t))}`;
  }
  if (kind === 'level') {
    f.events.push({ type: 'level', at: t, enteredAt });
    if (ui.sd.rebuild) later = [Math.max(t, now()), 'level off'];
    msg = `Level at ${fmtTimer(timerAt(f, t))}`;
  }
  if (kind === 'shutdown') {
    f.shutdown = t; f.finalUsed = num(ui.sd.used) || null; f.status = 'closed'; f.freezeAt = null; f.autoEnded = false;
    f.events.push({ type: 'shutdown', at: t, enteredAt, used: f.finalUsed });
    state.activeFlightId = null; ui.draft = null;
    closeSheet(); persist(); toast('Flight saved'); go('log', f.id); return;
  }
  // Respond instantly: close the panel, confirm, redraw. Rebuild the plan and save right after the screen updates.
  ui.alert = null;
  closeSheet();
  if (msg) toast(msg);
  render();
  requestAnimationFrame(() => setTimeout(() => {
    if (later) rebuildFrom(f, later[0], later[1]);
    persist();
    if (later) render();
  }, 30));
}

// =====================================================================
// LOG
// =====================================================================
function flightSummary(f) {
  const plannedBlock = f.blockMin, plannedFuel = f.plannedFuel ?? f.totalFuel;
  const actualBlock = f.engineStart && f.shutdown ? (f.shutdown - f.engineStart) / MIN : null;
  const plannedFlight = f.eteMin;
  const landEv = P.landingAt(f);
  const actualFlight = takeoffOf(f) && (landEv || f.shutdown) ? ((landEv ? landEv.at : f.shutdown) - takeoffOf(f)) / MIN : null; // takeoff to landing when recorded
  const checks = f.events.filter((e) => e.type === 'check');
  const actualFuel = f.finalUsed ?? null;
  const flightHrs = actualBlock ? Math.max(0.01, (actualBlock - f.taxiMin) / 60) : null;
  // Cruise burn: only what you entered (Set burn or a fuel check's flow), never worked out from fuel used.
  const setRates = f.events.filter((e) => (e.type === 'burn' || (e.type === 'check' && e.setsBurn)) && e.gph > 0).map((e) => e.gph);
  const actualGph = setRates.length ? setRates[setRates.length - 1] : null;
  const avgGph = actualFuel && actualBlock ? actualFuel / (actualBlock / 60) : null;
  return { plannedBlock, plannedFuel, actualBlock, actualFuel, actualGph, avgGph, plannedGph: f.cruiseGph, plannedFlight, actualFlight };
}

// =====================================================================
// FUEL (ground fills + gauge calibration)
// =====================================================================
const REQ = { full: 'Top off all', tabs: 'Tips full, mains to tabs', amounts: 'Specific amounts' };
const fuelings = () => Object.values(state.fuelings || {});

// What's in the tanks for a tail at a moment: the later of the last fueling and the last flight's end.
function tailFuelState(tailId, atMs = now(), excludeId = null) {
  if (!tailId || !state.tails[tailId]) return null;
  const cfg = cfgForTail(tailId);
  let best = null;
  for (const f of Object.values(state.flights)) {
    if (f.tail !== tailId || f.status !== 'closed' || !f.shutdown || f.shutdown > atMs) continue;
    if (!best || f.shutdown > best.at) best = { at: f.shutdown, levels: P.estimate(f, f.cfg, f.shutdown).levels, label: `the end of ${f.from || '—'} → ${f.divert?.ident || f.to || '—'} (calculated)` };
  }
  for (const fu of fuelings()) {
    if (fu.tail !== tailId || fu.id === excludeId || fu.at > atMs) continue;
    if (!best || fu.at > best.at) {
      const r = P.fuelingResult(fu, cfg.tanks);
      best = { at: fu.at, levels: Object.fromEntries(r.rows.map((x) => [x.tank, x.after ?? x.before ?? 0])), label: `fueling${fu.airport ? ' at ' + fu.airport : ''} ${fmtDate(fu.at)} ${localHM(fu.at, fu.tz || phoneTZ())}` };
    }
  }
  return best;
}

function newFuelDraft(tail) {
  const cfg = cfgForTail(tail);
  const st = tailFuelState(tail);
  return {
    id: null, tail, at: now(), tz: phoneTZ(), airport: '', request: 'full', amounts: {},
    before: Object.fromEntries(cfg.tanks.map((t) => [t.id, st ? Math.round(Math.max(0, st.levels[t.id]) * 10) / 10 : ''])),
    beforeLabel: st ? st.label : null,
    mode: 'tanks', totalAdded: '', startReading: '0', steps: cfg.fillOrder.map((id) => ({ tank: id, reading: '' })),
    gaugeBefore: {}, gaugeAfter: {}, note: ''
  };
}

function fuelingCalc(d) {
  const cfg = cfgForTail(d.tail);
  const fu = { ...d, before: Object.fromEntries(Object.entries(d.before || {}).map(([k, v]) => [k, v === '' || v == null ? null : num(v)])), startReading: num(d.startReading) || 0 };
  return { cfg, res: P.fuelingResult(fu, cfg.tanks) };
}

// Calculated burn of this tail's closed flights between the fueling before this one and this one.
// Used only to show the total diff as a share of the burn it measures; never turned into a rate.
function burnSinceLastFueling(tail, at, excludeId = null) {
  const prev = Math.max(0, ...fuelings().filter((x) => x.tail === tail && x.id !== excludeId && x.at < at).map((x) => x.at));
  let gal = 0;
  for (const f of Object.values(state.flights)) {
    if (f.tail !== tail || f.status !== 'closed' || !f.shutdown || f.shutdown > at || f.shutdown <= prev) continue;
    const sum = (o) => Object.values(o || {}).reduce((a, b) => a + (+b || 0), 0);
    gal += sum(f.startLevels) - sum(P.estimate(f, f.cfg, f.shutdown).levels);
  }
  return gal;
}
// One line comparing the total added with what the calculated levels said was needed.
function fuelTotalLine(x, res) {
  if (res.totalDiff == null) return `<div class="mut small">Enter every tank's before level to compare the total with the burn estimate.</div>`;
  const d = res.totalDiff, burn = burnSinceLastFueling(x.tail, x.at, x.id);
  const pct = res.calibrates && burn >= 1 ? ` · ${d >= 0 ? '+' : ''}${Math.round((d / burn) * 100)}% of the ${f1(burn)} gal calculated burn since the last fueling` : '';
  return `<div class="kv"><span>Expected</span><span class="v">${f1(res.expectedTotal)} gal</span></div>
    <div class="kv" data-totaldiff><span>${res.calibrates ? 'Diff vs burn estimate' : 'Diff vs what you asked for'}</span><span class="v" style="color:${Math.abs(d) >= 1 ? 'var(--amber)' : 'inherit'}">${d >= 0 ? '+' : ''}${f1(d)} gal</span></div>
    <div class="mut small">${res.calibrates ? `Positive = the airplane took more than calculated (the burn was under-estimated)${pct}. Shown for calibration only: cruise burn is never changed from this.` : 'Specific amounts say nothing about the burn estimate, so this fill is not used for calibration.'}</div>`;
}

function viewFuel() {
  if (ui.sub === 'edit' && state.fuelDraft) return viewFuelingEdit(state.fuelDraft);
  if (ui.sub && state.fuelings?.[ui.sub]) return viewFuelingDetail(state.fuelings[ui.sub]);
  const tails = Object.keys(state.tails);
  if (!tails.length) return `<div class="top"><div><div class="kicker">Fuel</div><h1>Fueling</h1></div></div><div class="card empty">Add an aircraft in Settings first.</div>`;
  const tail = state.settings.fuelTail && state.tails[state.settings.fuelTail] ? state.settings.fuelTail : state.settings.lastTail && state.tails[state.settings.lastTail] ? state.settings.lastTail : tails[0];
  const cfg = cfgForTail(tail);
  const st = tailFuelState(tail);
  const list = fuelings().filter((x) => x.tail === tail).sort((a, b) => b.at - a.at);
  return `<div class="top"><div><div class="kicker">Fuel</div><h1>Fueling &amp; calibration</h1></div></div>
  <div class="stack">
    ${tails.length > 1 ? `<div class="field"><label for="fuelTail">Aircraft</label><select id="fuelTail" data-fueltail>${tails.map((t) => `<option ${t === tail ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>` : ''}
    <div class="card"><div class="row between"><h2>${esc(tail)} on board now</h2><span class="mut small">${st ? 'calculated' : 'unknown'}</span></div>
      <div class="grid4">${cfg.tanks.map((t) => `<div class="chip" style="padding:8px"><span class="k" style="color:${tankColor(cfg, t.id)}">${esc(t.id)} /${t.capacity}</span><span class="v" style="font-size:16px">${st ? f1(st.levels[t.id]) : '—'}</span></div>`).join('')}</div>
      <div class="mut small">${st ? `From ${esc(st.label)}.` : 'No flight or fueling recorded yet for this aircraft.'}</div>
      ${state.fuelDraft ? `<a class="btn primary block" href="#fuel/edit">Continue fueling in progress</a>` : `<button class="btn primary block" data-act="newFueling" data-tail="${esc(tail)}">Start fueling</button>`}
    </div>
    ${fuelCalCard(tail)}
    ${calibrationCard()}
    <div class="lbl" style="text-transform:uppercase;letter-spacing:.06em;font-size:11px;margin-bottom:-6px">Fuelings</div>
    <div class="list">${list.length ? list.map((x) => { const r = P.fuelingResult(x, cfg.tanks); return `<a class="item" href="#fuel/${x.id}"><div><div class="t">${esc(REQ[x.request])}${x.airport ? ' · ' + esc(x.airport) : ''}</div><div class="s">${fmtDate(x.at, x.tz)} ${localHM(x.at, x.tz || phoneTZ())} · ${x.mode === 'total' ? `total only${r.totalDiff != null && r.calibrates ? ` · ${r.totalDiff >= 0 ? '+' : ''}${f1(r.totalDiff)} vs calc` : ''}` : r.rows.filter((y) => y.filled).map((y) => `${y.tank} ${f1(y.pumped)}`).join(' · ')}</div></div><span class="mono">${f1(r.total)} gal</span></a>`; }).join('') : '<div class="card empty">No fuelings yet.</div>'}</div>
  </div>`;
}

// How far the calculated leftovers were from what the pump said each tank needed (top-off and tabs fills).
function fuelCalCard(tail) {
  const cfg = cfgForTail(tail);
  const pts = [], tot = [];
  for (const x of fuelings()) {
    if (x.tail !== tail || x.request === 'amounts') continue;
    const res = P.fuelingResult(x, cfg.tanks);
    for (const r of res.rows) if (r.filled && r.diff != null) pts.push(r);
    if (res.totalDiff != null) tot.push({ d: res.totalDiff, burn: burnSinceLastFueling(x.tail, x.at, x.id) });
  }
  if (!pts.length && !tot.length) return '';
  const avg = (a) => a.reduce((p, q) => p + q, 0) / a.length;
  const td = tot.length ? avg(tot.map((x) => x.d)) : 0, tb = tot.reduce((a, x) => a + x.burn, 0);
  return `<div class="card"><h2>Burn estimate vs the pump</h2>
    <div class="mut small">On top-off and tabs fills: gallons pumped minus what Burnplan calculated each tank needed. Positive = the tank had less than calculated (we under-estimated the burn from it).</div>
    ${tot.length ? `<div class="kv total" data-caltotal><span>Whole airplane · ${tot.length} fill${tot.length > 1 ? 's' : ''}</span><span class="v" style="color:${Math.abs(td) >= 1 ? 'var(--amber)' : 'inherit'}">${td >= 0 ? '+' : ''}${f1(td)} gal avg${tb >= 1 ? ` · ${(td * tot.length) / tb >= 0 ? '+' : ''}${Math.round(((td * tot.length) / tb) * 100)}%` : ''}</span></div>` : ''}
    ${pts.length ? `<div class="grid4">${cfg.tanks.map((t) => { const l = pts.filter((p) => p.tank === t.id).map((p) => p.diff); return `<div class="chip" style="padding:8px"><span class="k" style="color:${tankColor(cfg, t.id)}">${esc(t.id)}${l.length ? ` ·${l.length}` : ''}</span><span class="v" style="font-size:16px;color:${l.length && Math.abs(avg(l)) >= 1 ? 'var(--amber)' : 'inherit'}">${l.length ? `${avg(l) >= 0 ? '+' : ''}${f1(avg(l))}` : '—'}</span></div>`; }).join('')}</div>` : ''}
    <div class="mut small">For information only. Burnplan never changes your cruise burn from these numbers; set it yourself if you want to.</div></div>`;
}

function viewFuelingEdit(d) {
  const { cfg, res } = fuelingCalc(d);
  const by = Object.fromEntries(res.rows.map((r) => [r.tank, r]));
  const inp = (id, attrs, val, ph = '') => `<input id="${id}" class="mono" ${attrs} value="${esc(val ?? '')}" placeholder="${ph}" inputmode="decimal">`;
  const tabsTxt = cfg.tanks.filter((t) => t.tabGal > 0).map((t) => `${t.id} ${t.tabGal}`).join(', ');
  return `<div class="top"><div><div class="kicker"><a href="#fuel">Fuel</a> · ${esc(d.tail)}</div><h1>${d.id ? 'Edit fueling' : 'Fueling'}</h1></div></div>
  <div class="stack">
    <div class="grid2">
      <div class="field"><label for="fu-at">Time (${zoneAbbr(d.tz || phoneTZ(), d.at)} clock)</label><input id="fu-at" class="mono" data-fmt="hm" data-fu="atClock" value="${localHM(d.at, d.tz || phoneTZ())}" inputmode="numeric"></div>
      <div class="field"><label for="fu-apt">Airport (opt.)</label><input id="fu-apt" class="mono" data-fu="airport" value="${esc(d.airport)}" autocapitalize="characters" placeholder="KVBT"></div>
    </div>
    <div class="field"><span class="lbl">What you asked for</span>
      <div class="seg" style="grid-template-columns:repeat(3,minmax(0,1fr))" role="group" aria-label="Fuel request">${Object.entries(REQ).map(([k, l]) => `<button class="${d.request === k ? 'on' : ''}" aria-pressed="${d.request === k}" data-act="fuReq" data-v="${k}" style="height:auto;min-height:44px;padding:4px">${l}</button>`).join('')}</div>
      ${d.request === 'tabs' ? `<div class="mut small">Tips to full, mains to the tabs (${esc(tabsTxt || 'set tab levels in Settings')} gal).</div>` : ''}
    </div>
    <div class="card"><h2>Tanks</h2>
      <div class="legs" style="border:none;overflow-x:auto">
        <div class="evrow head" style="grid-template-columns:0.6fr 1fr ${d.request === 'amounts' ? '1fr ' : ''}1fr;padding:0"><span>Tank</span><span>Before (calc)</span>${d.request === 'amounts' ? '<span>Asked for</span>' : ''}<span>Gauge before</span></div>
        ${cfg.tanks.map((t) => `<div class="evrow" style="grid-template-columns:0.6fr 1fr ${d.request === 'amounts' ? '1fr ' : ''}1fr;padding:0;border:none;min-height:50px">
          <span style="color:${tankColor(cfg, t.id)};font-weight:600;font-family:var(--sans)">${esc(t.id)} <span class="dim small">/${t.capacity}</span></span>
          ${inp('fb-' + t.id, `data-fub="${t.id}"`, d.before?.[t.id], '?')}
          ${d.request === 'amounts' ? inp('fa-' + t.id, `data-fua="${t.id}"`, d.amounts?.[t.id], 'gal') : ''}
          ${inp('fg-' + t.id, `data-fgb="${t.id}"`, d.gaugeBefore?.[t.id], 'opt.')}</div>`).join('')}
      </div>
      <div class="mut small">${d.beforeLabel ? `Before levels from ${esc(d.beforeLabel)}. Change them if you know better.` : 'Enter what you believe was in each tank, if you know.'} Gauge readings take gallons, 3/4, 60%, F or E.</div>
    </div>
    <div class="field"><span class="lbl">What you know</span>
      <div class="seg" role="group" aria-label="Fuel added">${[['tanks', 'Per tank'], ['total', 'Total only']].map(([k, l]) => `<button class="${(d.mode || 'tanks') === k ? 'on' : ''}" aria-pressed="${(d.mode || 'tanks') === k}" data-act="fuMode" data-v="${k}">${l}</button>`).join('')}</div>
      ${d.mode === 'total' ? `<div class="mut small">For when you didn't see each tank filled. Each tank is taken as ${d.request === 'amounts' ? 'getting what you asked for' : 'reaching its target'}.</div>` : ''}
    </div>
    ${d.mode === 'total' ? fuelFillTotal(d, cfg, res) : fuelFillTanks(d, cfg, res)}
    <div class="card"><h2>Gauges after (optional)</h2>
      <div class="grid4">${cfg.tanks.map((t) => `<div class="field"><label for="fga-${t.id}" style="color:${tankColor(cfg, t.id)}">${esc(t.id)}</label>${inp('fga-' + t.id, `data-fga="${t.id}"`, d.gaugeAfter?.[t.id], 'F')}</div>`).join('')}</div>
      <div class="mut small">Readings right after a top-off are the best calibration points: the true level is known.</div>
    </div>
    <div class="field"><label for="fu-note">Note</label><input id="fu-note" data-fu="note" value="${esc(d.note)}"></div>
    <div class="row"><button class="btn danger grow" data-act="fuDiscard">${d.id ? 'Cancel' : 'Discard'}</button><button class="btn primary grow" data-act="fuSave">Save fueling</button></div>
    <div class="mut small">Saving sets this aircraft's starting fuel for the next flight to the After column.</div>
  </div>`;
}

// Fill card for a fueling with per-tank pump readings.
function fuelFillTanks(d, cfg, res) {
  return `<div class="card"><h2>Fill, in order</h2>
      <div class="field"><label for="fu-start">Pump reading at start</label><input id="fu-start" class="mono" data-fu="startReading" value="${esc(d.startReading)}" inputmode="decimal"></div>
      ${d.steps.map((st, i) => `<div class="row" style="gap:8px;align-items:flex-end">
        <span class="mut small" style="width:16px;padding-bottom:14px">${i + 1}</span>
        <div class="field" style="width:84px"><label for="fs-${i}">Tank</label><select id="fs-${i}" data-fstank="${i}" class="mono">${cfg.tanks.map((t) => `<option ${t.id === st.tank ? 'selected' : ''}>${esc(t.id)}</option>`).join('')}</select></div>
        <div class="field grow"><label for="fr-${i}">Pump reading when done</label><input id="fr-${i}" class="mono key" data-fsread="${i}" value="${esc(st.reading)}" inputmode="decimal"></div>
        <span class="mono" style="width:56px;text-align:right;padding-bottom:14px">${res.stepGal[i] != null ? f1(res.stepGal[i]) : '—'}</span>
        <button class="iconbtn" data-act="fuDelStep" data-i="${i}" aria-label="Remove step ${i + 1}">${ICON.del}</button></div>`).join('')}
      <div class="row wrap"><button class="btn sm" data-act="fuAddStep">+ Add tank</button><span class="mut small grow">Order from the POH (${esc(cfg.fillOrder.join(' → '))}); change it to match what the fueler did.</span></div>
    </div>
    <div class="card"><h2>Result</h2>
      <div class="legs" style="border:none;overflow-x:auto">
        <div class="evrow head" style="grid-template-columns:0.6fr 1fr 1fr 1fr 1fr;padding:0"><span>Tank</span><span>Pumped</span><span>Expected</span><span>Diff</span><span>After</span></div>
        ${res.rows.map((r) => `<div class="evrow" style="grid-template-columns:0.6fr 1fr 1fr 1fr 1fr;padding:0;border:none;min-height:36px"><span style="color:${tankColor(cfg, r.tank)};font-family:var(--sans);font-weight:600">${esc(r.tank)}</span><span>${r.filled ? f1(r.pumped) : '—'}</span><span class="mut">${r.expected != null && r.filled ? f1(r.expected) : '—'}</span><span style="color:${r.diff != null && Math.abs(r.diff) >= 1 ? 'var(--amber)' : 'inherit'}">${r.diff != null ? `${r.diff >= 0 ? '+' : ''}${f1(r.diff)}` : '—'}</span><span>${r.after != null ? f1(r.after) : '—'}${r.known ? '' : r.after != null ? '<span class="dim">*</span>' : ''}</span></div>`).join('')}
        <div class="kv total" style="margin-top:6px"><span>Total pumped</span><span class="v">${f1(res.total)} gal</span></div>
        ${res.total > 0 ? fuelTotalLine(d, res) : ''}
      </div>
      <div class="mut small">Expected = what Burnplan calculated each tank needed${d.request === 'amounts' ? ' (the amount you asked for)' : ' to reach the target'}. Diff = pumped − expected. ${d.request === 'amounts' ? '* After = before + pumped, since there is no known full mark.' : '* Not filled, so unchanged.'}</div>
    </div>`;
}

// Fill card for a fueling where only the total added is known.
function fuelFillTotal(d, cfg, res) {
  return `<div class="card"><h2>Fuel added</h2>
      <div class="field"><label for="fu-total">Total gallons added</label><input id="fu-total" class="mono key" data-fu="totalAdded" value="${esc(d.totalAdded ?? '')}" placeholder="gal" inputmode="decimal"></div>
    </div>
    <div class="card"><h2>Result</h2>
      <div class="legs" style="border:none;overflow-x:auto">
        <div class="evrow head" style="grid-template-columns:0.6fr 1fr 1fr;padding:0"><span>Tank</span><span>Expected</span><span>After</span></div>
        ${res.rows.map((r) => `<div class="evrow" style="grid-template-columns:0.6fr 1fr 1fr;padding:0;border:none;min-height:36px"><span style="color:${tankColor(cfg, r.tank)};font-family:var(--sans);font-weight:600">${esc(r.tank)}</span><span class="mut">${r.expected != null ? f1(r.expected) : '—'}</span><span>${r.after != null ? f1(r.after) : '—'}${r.known ? '' : r.after != null ? '<span class="dim">*</span>' : ''}</span></div>`).join('')}
        <div class="kv total" style="margin-top:6px"><span>Total added</span><span class="v">${d.totalAdded !== '' && isFinite(num(d.totalAdded)) ? f1(num(d.totalAdded)) + ' gal' : '—'}</span></div>
        ${d.totalAdded !== '' && isFinite(num(d.totalAdded)) ? fuelTotalLine(d, res) : ''}
      </div>
      ${d.request === 'amounts' ? '<div class="mut small">* After = before + what you asked for, since the split is unknown.</div>' : ''}
    </div>`;
}

function viewFuelingDetail(x) {
  const cfg = cfgForTail(x.tail);
  const r = P.fuelingResult(x, cfg.tanks);
  const g = (o, id) => { const v = o?.[id]; if (v == null || v === '') return '—'; const gal = parseGauge(v, cfg.tanks.find((t) => t.id === id)?.capacity); return gal == null || !isFinite(gal) ? esc(String(v)) : f1(gal); };
  const head = `<div class="top"><div><div class="kicker"><a href="#fuel">Fuel</a> · ${esc(x.tail)} · ${fmtDate(x.at, x.tz)} ${localHM(x.at, x.tz || phoneTZ())}</div><h1>${esc(REQ[x.request])}</h1></div></div>`;
  const btns = `<div class="row"><button class="btn grow" data-act="fuEdit" data-id="${x.id}">Edit</button><button class="btn danger grow" data-act="fuDelete" data-id="${x.id}">Delete</button></div>`;
  if (x.mode === 'total') return `${head}
  <div class="stack">
    <div class="mut">Total only${x.airport ? ` · ${esc(x.airport)}` : ''}</div>
    <div class="legs" style="padding:8px 12px;overflow-x:auto">
      <div class="evrow head" style="grid-template-columns:0.6fr repeat(5, 1fr);padding:0"><span>Tank</span><span>Before</span><span>Gauge</span><span>Expected</span><span>After</span><span>Gauge</span></div>
      ${r.rows.map((y) => `<div class="evrow" style="grid-template-columns:0.6fr repeat(5, 1fr);padding:0;min-height:36px"><span style="color:${tankColor(cfg, y.tank)};font-family:var(--sans);font-weight:600">${esc(y.tank)}</span><span>${y.before != null ? f1(y.before) : '—'}</span><span class="mut">${g(x.gaugeBefore, y.tank)}</span><span class="mut">${y.expected != null ? f1(y.expected) : '—'}</span><span>${y.after != null ? f1(y.after) : '—'}</span><span class="mut">${g(x.gaugeAfter, y.tank)}</span></div>`).join('')}
      <div class="kv total"><span>Total added</span><span class="v">${f1(r.total)} gal</span></div>
      ${fuelTotalLine(x, r)}
    </div>
    ${x.note ? `<div class="mut small">${esc(x.note)}</div>` : ''}
    ${btns}
  </div>`;
  return `${head}
  <div class="stack">
    ${x.airport ? `<div class="mut">${esc(x.airport)}</div>` : ''}
    <div class="legs" style="padding:8px 12px;overflow-x:auto">
      <div class="evrow head" style="grid-template-columns:0.6fr repeat(6, 1fr);padding:0"><span>Tank</span><span>Before</span><span>Gauge</span><span>Pumped</span><span>Diff</span><span>After</span><span>Gauge</span></div>
      ${r.rows.map((y) => `<div class="evrow" style="grid-template-columns:0.6fr repeat(6, 1fr);padding:0;min-height:36px"><span style="color:${tankColor(cfg, y.tank)};font-family:var(--sans);font-weight:600">${esc(y.tank)}</span><span>${y.before != null ? f1(y.before) : '—'}</span><span class="mut">${g(x.gaugeBefore, y.tank)}</span><span>${y.filled ? f1(y.pumped) : '—'}</span><span style="color:${y.diff != null && Math.abs(y.diff) >= 1 ? 'var(--amber)' : 'inherit'}">${y.diff != null ? `${y.diff >= 0 ? '+' : ''}${f1(y.diff)}` : '—'}</span><span>${y.after != null ? f1(y.after) : '—'}</span><span class="mut">${g(x.gaugeAfter, y.tank)}</span></div>`).join('')}
      <div class="kv total"><span>Total pumped</span><span class="v">${f1(r.total)} gal</span></div>
      ${fuelTotalLine(x, r)}
    </div>
    <div class="mut small">Fill order: ${x.steps.map((s, i) => `${s.tank} ${r.stepGal[i] != null ? f1(r.stepGal[i]) : '—'}`).join(' → ')}${x.note ? ` · ${esc(x.note)}` : ''}</div>
    <div class="row"><button class="btn grow" data-act="fuEdit" data-id="${x.id}">Edit</button><button class="btn danger grow" data-act="fuDelete" data-id="${x.id}">Delete</button></div>
  </div>`;
}

// ---------- gauge calibration ----------
// A gauge reading can be typed as gallons (9.5), a fraction (3/4), a percent (60%), F or E.
function parseGauge(str, cap) {
  const v = String(str || '').trim().toLowerCase();
  if (!v) return null;
  if (v === 'f' || v === 'full') return cap;
  if (v === 'e' || v === 'empty') return 0;
  let m = v.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (m && +m[2] > 0) return (cap * +m[1]) / +m[2];
  m = v.match(/^(\d+(?:\.\d+)?)\s*%$/);
  if (m) return (cap * +m[1]) / 100;
  const n = parseFloat(v);
  return isFinite(n) ? n : NaN;
}
// Calculated level at a moment; before engine start it's the starting fuel.
function calcLevels(f, ms, e) {
  if (!f.engineStart || ms < f.engineStart || (e && e.phase === 'before start')) return { ...f.startLevels };
  return P.estimate(f, f.cfg, ms).levels;
}
function gaugePhase(f, ms) {
  if (!f.engineStart || ms < f.engineStart) return 'before start';
  if (f.shutdown && ms >= f.shutdown) return 'after shutdown';
  const ph = P.phaseAt(f, ms).phase;
  return ph === 'taxi' && takeoffOf(f) && ms > takeoffOf(f) ? 'cruise' : ph;
}
// Every gauge reading across flights, compared with the calculated level at that moment.
function gaugePoints() {
  const pts = [];
  for (const f of Object.values(state.flights)) {
    for (const e of f.events || []) {
      if (e.type !== 'gauge') continue;
      const calc = calcLevels(f, e.at, e);
      for (const t of f.cfg.tanks) {
        const ind = e.readings?.[t.id];
        if (ind == null || !isFinite(ind)) continue;
        pts.push({ f, e, tank: t.id, cap: t.capacity, ind, calc: calc[t.id], diff: ind - calc[t.id] });
      }
    }
  }
  for (const x of fuelings()) {
    if (!state.tails[x.tail]) continue;
    const cfg = cfgForTail(x.tail);
    const r = P.fuelingResult(x, cfg.tanks);
    const fake = { from: 'fueling', to: x.airport || '', tail: x.tail, engineStart: null };
    for (const y of r.rows) {
      const t = cfg.tanks.find((k) => k.id === y.tank);
      const gb = parseGauge(x.gaugeBefore?.[y.tank], t.capacity), ga = parseGauge(x.gaugeAfter?.[y.tank], t.capacity);
      if (gb != null && isFinite(gb) && y.before != null) pts.push({ f: fake, e: { at: x.at, phase: 'before fueling', note: x.note }, tank: y.tank, cap: t.capacity, ind: gb, calc: y.before, diff: gb - y.before });
      if (ga != null && isFinite(ga) && y.after != null) pts.push({ f: fake, e: { at: x.at, phase: 'after fueling', note: x.note }, tank: y.tank, cap: t.capacity, ind: ga, calc: y.after, diff: ga - y.after });
    }
  }
  return pts;
}
function calibrationCard() {
  const pts = gaugePoints();
  if (!pts.length) return '';
  const tanks = [...new Set(pts.map((p) => p.tank))];
  const bands = [[0, 0.25, 'E–¼'], [0.25, 0.5, '¼–½'], [0.5, 0.75, '½–¾'], [0.75, 1.01, '¾–F']];
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const fmt = (d) => `${d >= 0 ? '+' : ''}${f1(d)}`;
  const cell = (list) => (list.length ? `<span style="color:${Math.abs(avg(list)) >= 2 ? 'var(--amber)' : 'inherit'}">${fmt(avg(list))}</span><span class="dim"> ·${list.length}</span>` : '<span class="dim">—</span>');
  return `<div class="card"><h2>Gauge calibration</h2>
    <div class="mut small">Indicated minus calculated, in gallons, averaged over ${pts.length} reading${pts.length === 1 ? '' : 's'} and grouped by how full the tank calculated. Positive = gauge reads high. The small number is how many readings.</div>
    <div class="legs" style="border:none;overflow-x:auto"><div class="evrow head" style="grid-template-columns:0.8fr repeat(5, 1fr);padding:0"><span>Tank</span><span>All</span>${bands.map((b) => `<span>${b[2]}</span>`).join('')}</div>
      ${tanks.map((tk) => { const mine = pts.filter((p) => p.tank === tk); return `<div class="evrow" style="grid-template-columns:0.8fr repeat(5, 1fr);padding:0;min-height:36px"><span>${esc(tk)}</span><span>${cell(mine.map((p) => p.diff))}</span>${bands.map((b) => `<span>${cell(mine.filter((p) => p.calc / p.cap >= b[0] && p.calc / p.cap < b[1]).map((p) => p.diff))}</span>`).join('')}</div>`; }).join('')}
    </div>
    <div class="mut small">Calculated levels improve as you add GI 275 checks, so readings near a check compare best. Readings never change any calculation.</div>
    <button class="btn" data-act="exportGauges">Export gauge data (CSV)</button></div>`;
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
    <div class="list">${flights.length ? flights.map((f) => `<a class="item" href="#log/${f.id}"><div><div class="t">${flightTitle(f)}</div><div class="s">${fmtDate(f.engineStart || f.createdAt, f.tz || phoneTZ())} · ${esc(f.tail)} · ${f.status === 'active' ? 'in progress' : f.status === 'draft' ? 'planned' : f.autoSaved ? 'auto-saved' : 'closed'}</div></div>
      <span class="mono ${f.id === state.activeFlightId ? '' : 'mut'}" style="color:${f.id === state.activeFlightId ? 'var(--amber)' : ''}">${f.id === state.activeFlightId ? 'active' : f1(f.finalUsed ?? f.plannedFuel) + ' gal'}</span></a>`).join('') : '<div class="card empty">No flights yet.</div>'}</div>
  </div>`;
}

function viewFlightDetail(f) {
  const s = flightSummary(f);
  const evName = (e) => ({
    engine: `Taxi on ${e.tank}${e.assumed ? ` (${f.taxiMin} min)` : ''}`,
    takeoff: `Takeoff${e.by === 'timer' ? ' (from timer)' : e.by === 'clock' ? ' (clock time)' : ''}`,
    climb: `Climb @ ${f1(e.gph)} gph${e.until ? ` for ${dur((e.until - e.at) / MIN)}` : ' (until level off)'}${e.initial ? ' · initial' : ''}`,
    burn: `Cruise burn ${f1(e.gph)} gph${e.scope === 'all' ? ' · whole cruise' : ' · from here on'}`,
    gauge: `Gauges (${e.phase || gaugePhase(f, e.at)}) · ${Object.entries(e.readings || {}).map(([k, v]) => { const c = calcLevels(f, e.at, e)[k]; return `${k} ${f1(v)}${isFinite(c) ? ` (${v - c >= 0 ? '+' : ''}${f1(v - c)})` : ''}`; }).join(' · ')}${e.note ? ` · ${e.note}` : ''}`,
    level: 'Level off',
    switch: `Switch → ${e.tank}${e.catchup ? ` (catch-up${e.catchup === 'plan' ? ', as planned' : ''})` : ''}`,
    check: `GI 275 check · ${f1(e.used)} gal used${e.setsBurn ? ` · flow ${f1(e.gph)} gph` : ''}`,
    ete: `ETE ${dur(e.eteMin)}${e.divert ? ` → ${e.divert} (divert)` : ''}${e.gph > 0 && (e.gphSet || (e.gphSet === undefined && !e.fuelToDest)) ? ` · ${f1(e.gph)} gph` : ''}${e.fuelToDest ? ` · ForeFlight ${f1(e.fuelToDest)} gal` : ''}${e.altFuel ? ` · alt ${f1(e.altFuel)}` : ''}`,
    shutdown: `Shutdown${e.assumed ? ' (assumed)' : ''}${e.used ? ` · ${f1(e.used)} gal used` : ''}`,
    reactivate: 'Reactivated',
    note: `Note · ${e.note || ''}`,
    descent: `Descent @ ${f1(e.gph)} gph${e.until ? ` for ${dur((e.until - e.at) / MIN)}` : ''}`,
    landing: 'Landed',
    park: `Done with ${e.tank}${e.level != null ? ` (left at ${f1(e.level)} calc.)` : ''}`,
    unpark: `${e.tank} back in use`
  }[e.type] || e.type);
  const evs = f.events.map((e, i) => ({ ...e, i })).sort((a, b) => a.at - b.at);
  const editable = !!f.engineStart;
  return `<div class="top"><div><div class="kicker"><a href="#log">Log</a> · ${fmtDate(f.engineStart || f.createdAt, f.tz || phoneTZ())} · ${esc(f.tail)}</div><h1>${flightTitle(f)}</h1></div>${f.autoSaved ? '<span class="badge">auto-saved</span>' : ''}</div>
  <div class="stack">
    <div class="card"><div class="evrow head" style="padding:0;grid-template-columns:1.4fr 1fr 1fr"><span>ForeFlight vs actual</span><span>Plan</span><span>Actual</span></div>
      <div class="evrow" style="padding:0;grid-template-columns:1.4fr 1fr 1fr;border:none"><span>Flight time</span><span>${dur(s.plannedFlight)}</span><span>${s.actualFlight ? dur(s.actualFlight) : '—'}</span></div>
      <div class="evrow" style="padding:0;grid-template-columns:1.4fr 1fr 1fr;border:none"><span>Fuel</span><span>${f1(s.plannedFuel)}</span><span>${f1(s.actualFuel)}</span></div>
      <div class="evrow" style="padding:0;grid-template-columns:1.4fr 1fr 1fr;border:none"><span>Cruise gph (entered)</span><span>${f1(s.plannedGph)}</span><span>${f1(s.actualGph)}</span></div>
      ${s.avgGph ? `<div class="evrow" style="padding:0;grid-template-columns:1.4fr 1fr 1fr;border:none"><span>Avg gph, engine on</span><span class="mut">${f1(s.plannedFuel / (s.plannedBlock / 60))}</span><span>${f1(s.avgGph)}</span></div>` : ''}
      ${f.divert ? `<div class="mut small">Planned ${esc(f.to)}; diverted to ${esc(f.divert.ident)} at ${hm(f.divert.at)}.</div>` : ''}
    </div>
    <div class="legs"><div class="evrow head"><span>Event</span><span>Plan</span><span>Actual</span><span>Entered</span></div>${f.engineStart ? `<div style="padding:8px 12px 0">${zoneControl(f, true)}</div>` : ''}<div class="mut small" style="padding:6px 12px">Plan and actual are flight timer; entered is ${clockLabel()} clock.</div>
      ${evs.length ? evs.map((e) => { const ed = editable || e.type === 'note'; return `<div class="evrow ${ed ? 'tap' : ''}${e.type === 'note' ? ' note' : ''}" ${ed ? `role="button" tabindex="0" data-act="editEvent" data-fid="${f.id}" data-i="${e.i}" aria-label="Edit ${esc(evName(e))}"` : ''}><span>${esc(evName(e))}${(e.edited || e.added) && e.type !== 'note' ? ' <span class="badge" style="font-size:10px;padding:1px 5px">edited</span>' : ''}</span><span class="mut">${e.planned ? fmtTimer(timerAt(f, e.planned.at)) : '—'}</span><span style="color:${e.planned && Math.abs(e.at - e.planned.at) >= 2 * MIN ? 'var(--amber)' : ''}">${f.engineStart ? fmtTimer(timerAt(f, e.at)) : hm(e.at)}</span><span class="mut">${e.enteredAt ? hm(e.enteredAt) : '—'}</span></div>`; }).join('') : '<div class="empty">No events yet.</div>'}
    </div>
    ${f.autoEnded || (f.status === 'closed' && !f.events.some((e) => e.type === 'shutdown')) ? `<div class="issue warn">${ICON.warn}<div>${f.autoEnded ? `Ended automatically at the assumed landing time (${f.shutdown ? fmtTimer(timerAt(f, f.shutdown)) : '—'}).` : 'No shutdown was recorded, so fuel kept burning until the flight was auto-saved.'} Tap <b>Shutdown</b> below to set when you actually shut down.</div></div>` : ''}
    ${editable ? `<div class="stack" style="gap:8px"><div class="mut small">Tap an entry to correct it. Add anything you missed:</div>
      <div class="row wrap">${['note', 'switch', 'climb', 'level', 'descent', ...(P.landingAt(f) ? [] : ['landing']), 'burn', 'check', 'gauge', ...(f.status === 'closed' && !f.events.some((e) => e.type === 'shutdown') ? ['shutdown'] : [])].map((k) => `<button class="btn sm" data-act="addEvent" data-fid="${f.id}" data-kind="${k}">+ ${EV_LABEL[k]}</button>`).join('')}</div></div>` : `<div class="row"><button class="btn sm" data-act="addEvent" data-fid="${f.id}" data-kind="note">+ Note</button></div>`}
    ${f.engineStart ? replayCard(f) : ''}
    ${planVersionsCard(f)}
    ${setupCard(f)}
    <div class="row"><button class="btn grow" data-act="exportCsv" data-id="${f.id}">Export CSV</button><button class="btn grow" data-act="exportFlight" data-id="${f.id}">Export flight file</button></div>
    <div class="row">${f.id === state.activeFlightId ? '' : `<button class="btn danger grow" data-act="deleteFlight" data-id="${f.id}">Delete</button>`}</div>
    ${f.id !== state.activeFlightId && !f.engineStart ? `<button class="btn outline" data-act="reopen" data-id="${f.id}">Make this the current flight</button>` : ''}
    ${f.engineStart && f.status !== 'closed' ? `<button class="btn" data-act="resetStart" data-id="${f.id}">Undo start (back to planned)</button>` : ''}
    ${f.id !== state.activeFlightId && f.engineStart && f.status === 'closed' ? `<button class="btn outline" data-act="reactivate" data-id="${f.id}">Reactivate flight</button>
      <div class="mut small">Reactivating removes the shutdown and resumes the flight as if you never shut down: fuel burns on your recorded tanks right up to now. To only fix a time, tap the entry above instead.</div>` : ''}
  </div>`;
}

// Tank levels at any moment, recomputed from the recorded history.
function replayCard(f) {
  const end = f.shutdown || f.freezeAt || now();
  const T = ui.replayAt && ui.replayFid === f.id ? Math.min(ui.replayAt, end) : end;
  const est = P.estimate(f, f.cfg, T);
  return `<div class="card"><div class="row between"><h2>Tank levels at</h2><span class="mut small">recomputed from the entries above</span></div>
    <div class="row"><input id="replayAt" class="mono grow" data-fmt="hms" data-fid="${f.id}" value="${durS(timerAt(f, T))}" inputmode="numeric" aria-label="Flight timer to show levels for">
      <button class="btn sm" data-act="replayEnd" data-fid="${f.id}" style="height:44px">${f.shutdown ? 'Shutdown' : 'Now'}</button></div>
    <div class="grid4">${f.cfg.tanks.map((x) => `<div class="chip" style="padding:8px"><span class="k" style="color:${tankColor(f.cfg, x.id)}">${esc(x.id)}${x.id === est.active ? ' · on' : ''}</span><span class="v" style="font-size:16px">${f1(est.levels[x.id])}</span></div>`).join('')}</div>
    <div class="kv"><span class="mut">Total · used · burn</span><span class="v">${f1(est.total)} · ${f1(est.used)} · ${f1(est.rate)} gph (${est.phase?.phase || '—'})</span></div></div>`;
}

// Every plan the flight had, newest first, with why it changed.
function planVersionsCard(f) {
  const hist = f.planHistory || [];
  const versions = [...hist.map((h, i) => ({ legs: h.legs, startMin: h.startMin, at: h.createdAt ?? (i ? hist[i - 1].at : f.createdAt), why: h.created || (i ? `(${hist[i - 1].reason})` : 'Built from setup'), replaced: h.at })),
    { legs: f.plan.legs, startMin: f.plan.startMin, at: f.plan.at, why: f.plan.reason || (hist.length ? `(${hist[hist.length - 1].reason})` : 'Built from setup'), current: true }];
  const when = (ms) => (f.engineStart && ms >= f.engineStart ? `${fmtTimer(timerAt(f, ms))} · ${hm(ms)}` : ms ? `${fmtDate(ms, f.tz || phoneTZ())} ${hm(ms)} (before start)` : '—');
  const seq = (v) => { let t = v.startMin; return v.legs.map((l) => { const a = t; t += l.min; return `<span style="color:${tankColor(f.cfg, l.tank)}">${esc(l.tank)}</span> ${Math.round(l.min)}m${f.engineStart ? ` <span class="dim">@${fmtTimer(timerAt(f, MS(f, a)))}</span>` : ''}`; }).join(' → '); };
  return `<details class="card"${ui.openVersions ? ' open' : ''}><summary>Plan versions (${versions.length})</summary>
    <div class="mut small">Each change to the plan, newest first. Plan changes never count as actual events.</div>
    ${versions.reverse().map((v, i) => `<div class="pv ${v.current ? 'cur' : ''}"><div class="row between"><b>v${versions.length - i}${v.current ? ' · current' : ''}</b><span class="mono small mut">${when(v.at)}</span></div>
      <div class="small">${esc(v.why || '')}</div><div class="mono small seq">${seq(v)}</div></div>`).join('')}
  </details>`;
}

// What the flight was set up with.
function setupCard(f) {
  const kv = (k, v) => `<div class="kv"><span class="mut">${k}</span><span class="v">${v}</span></div>`;
  return `<details class="card"><summary>Flight setup</summary>
    ${kv('ForeFlight ETE · total fuel', `${dur(f.eteMin)} · ${f.totalFuel ? f1(f.totalFuel) : '—'}`)}
    ${kv('Taxi · climb', `${f.taxiMin} min · ${dur(f.climbMin ?? f.cfg.burn.climbMin)} @ ${f1(f.climbGph || f.cfg.burn.climbGph)} gph`)}
    ${f.descentMin != null ? kv('Descent · taxi-in', `${dur(f.descentMin)} @ ${f1(f.descentGph)} gph · ${f.taxiInMin ?? 0} min`) : ''}
    ${kv('Planned cruise', `${f1(f.cruiseGph)} gph${f.profileInput?.cruiseGph ? ' (entered)' : ' (from ForeFlight)'}`)}
    ${kv('Starting fuel', f.cfg.tanks.map((x) => `${esc(x.id)} ${f1(f.startLevels[x.id])}`).join(' · '))}
    ${kv('Reserve', `${dur(f.cfg.rules.reserve.min)} @ ${f1(P.reserveGph(f.cfg))} = ${f1(P.reserveGal(f.cfg))} gal`)}
    ${f.alt?.on || f.alt?.ident ? kv('Alternate', `${esc(f.alt.ident || '—')} · ${dur(f.alt.eteMin)} · ${f1(f.alt.fuel)} gal`) : ''}
    ${kv('Rules', `floor ${f.cfg.rules.floor.gal} · imbalance ${f.cfg.rules.imbalance.gal}`)}
    ${kv('Time zone', `${zoneAbbr(f.tz || phoneTZ(), takeoffOf(f) || f.createdAt)}`)}
  </details>`;
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
  const rows = [['kind', 'event', 'tank', 'planned_timer', 'actual_timer', 'actual_utc', 'entered_local', 'value', 'gph', 'detail']];
  for (const e of [...f.events].sort((a, b) => a.at - b.at)) {
    const detail = [e.readings ? 'indicated ' + Object.entries(e.readings).map(([k, v]) => `${k} ${v}`).join(' ') + ' | calculated ' + Object.entries(e.readings).map(([k]) => `${k} ${f1(calcLevels(f, e.at, e)[k])}`).join(' ') : '', e.note || '', e.scope === 'all' ? 'whole cruise' : '', e.until ? `until ${fmtTimer(timerAt(f, e.until))}` : '', e.catchup ? `catch-up ${e.catchup}` : '', e.fuelToDest ? `fuel to go ${f1(e.fuelToDest)}` : '', e.assumed ? 'assumed' : '', e.edited ? 'edited' : ''].filter(Boolean).join('; ');
    rows.push(['event', e.type, e.tank || e.divert || '', e.planned ? fmtTimer(timerAt(f, e.planned.at)) : '', fmtTimer(timerAt(f, e.at)), new Date(e.at).toISOString(), e.enteredAt ? hm(e.enteredAt) : '', e.used ?? e.eteMin ?? '', e.gph ?? '', detail]);
  }
  const versions = [...(f.planHistory || []).map((h) => ({ legs: h.legs, startMin: h.startMin, at: h.createdAt, why: h.created || '' })), { legs: f.plan.legs, startMin: f.plan.startMin, at: f.plan.at, why: f.plan.reason || 'current' }];
  versions.forEach((v, n) => {
    let t = v.startMin;
    for (const l of v.legs) { rows.push([`plan_v${n + 1}`, 'leg', l.tank, f.engineStart ? fmtTimer(timerAt(f, MS(f, t))) : fmtTimer(planTimer(f, t)), '', v.at ? new Date(v.at).toISOString() : '', '', Math.round(l.min), '', v.why]); t += l.min; }
  });
  const s = flightSummary(f);
  rows.push(['summary', 'time_zone', '', '', '', '', '', f.tz || phoneTZ()]);
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
    ['burn.ground', 'Ground gph (incl. run-up)'], ['burn.climbGph', 'Climb gph'], ['burn.climbMin', 'Initial climb minutes'], ['burn.stepClimbMin', 'Mid-flight climb minutes'],
    ['burn.cruise', 'Cruise gph (plan default & reserve)'], ['burn.descentGph', 'Descent gph'], ['burn.descentMin', 'Descent minutes'], ['burn.taxiInMin', 'Taxi-in minutes']]],
  ['Reserve', [
    ['rules.reserve.min', 'Reserve minutes'], ['rules.reserve.rate', 'Reserve rate', ['cruise', 'custom']],
    ['rules.reserve.customGph', 'Custom reserve gph'], ['rules.reserve.mode', 'Reserve rule', ['hard', 'warn', 'off']]]],
  ['Tank rules', [
    ['rules.floor.gal', 'Tank floor gal'], ['rules.floor.mode', 'Floor rule', ['hard', 'warn']],
    ['rules.imbalance.gal', 'Max imbalance gal'], ['rules.imbalance.mode', 'Imbalance rule', ['warn', 'hard', 'off']],
    ['rules.switchMargin', 'Switch margin gal'], ['rules.minLegMin', 'Shortest normal leg min'], ['rules.landBalanced', 'Land balanced', ['true', 'false']]]],
  ['Alerts & app', [
    ['alerts.preMin', 'Alert minutes before switch'], ['alerts.sound', 'Sound', ['true', 'false']], ['alerts.vibrate', 'Vibrate', ['true', 'false']], ['landing.graceMin', 'Assume landed after arrival + min'], ['idleHours', 'Auto-save after idle hours']]]
];
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);

// A new GitHub issue with a blank request form. Only the app version goes in; no user data.
function typeRequestUrl() {
  const body = [
    'Aircraft make and model (and years or variant):',
    '',
    'Tanks (name, usable gal each, which side):',
    '',
    'Fuel selector positions (e.g. L / R / BOTH / OFF):',
    '',
    'Tanks approved for takeoff and landing:',
    '',
    'POH fill order and tab levels, if any:',
    '',
    'Typical burns, gph (ground / climb / cruise / descent):',
    '',
    'POH limits (fuel imbalance, takeoff minimums, other):',
    '',
    'Source (POH section or page):',
    '',
    `Burnplan ${APP_VERSION}`
  ].join('\n');
  return `https://github.com/austinbeam/burnplan/issues/new?title=${encodeURIComponent('Aircraft type request: ')}&body=${encodeURIComponent(body)}`;
}

function viewAircraft() {
  if (ui.sub && ui.sub.startsWith('type-')) return viewTypeEditor(ui.sub.slice(5));
  if (ui.sub && state.tails[decodeURIComponent(ui.sub)]) return viewTail(state.tails[decodeURIComponent(ui.sub)]);
  const tails = Object.values(state.tails);
  return `<div class="top"><div><div class="kicker">Burnplan</div><h1>Settings</h1></div></div>
  <div class="stack">
    <div class="lbl" style="text-transform:uppercase;letter-spacing:.06em;font-size:11px;margin-bottom:-6px">Your aircraft</div>
    <div class="list">${tails.length ? tails.map((t) => `<a class="item" href="#aircraft/${encodeURIComponent(t.tail)}"><div><div class="t mono">${esc(t.tail)}</div><div class="s">${esc(typeById(t.typeId)?.name || 'missing type')}${Object.keys(t.overrides || {}).length ? ' · overrides' : ''}</div></div><span class="mut">›</span></a>`).join('') : '<div class="card empty">No aircraft yet.</div>'}</div>
    <div class="card"><h2>Add aircraft</h2>${tailForm()}</div>
    <div class="card"><h2>Aircraft types</h2>
      <div class="mut small">Built-in types ship with the app. Copy one to make your own (e.g. a different tank layout).</div>
      <div class="list">${allTypes().map((t) => `<a class="item" href="#aircraft/type-${esc(t.id)}"><div><div class="t">${esc(t.name)}</div><div class="s">${t.builtin ? 'Built-in' : 'Custom (this phone)'} · ${t.tanks.length} tanks · ${t.tanks.reduce((a, x) => a + x.capacity, 0)} gal</div></div><span class="mut">›</span></a>`).join('')}</div>
      <a class="btn" id="requestType" href="${typeRequestUrl()}" target="_blank" rel="noopener">Request an aircraft type</a>
      <div class="mut small">Opens a prefilled GitHub issue to fill in. Nothing from your flights or aircraft is included.</div>
      <label class="btn" for="importFile2">Import tail or type file</label><input type="file" id="importFile2" accept="application/json,.json" class="hidden">
    </div>
    <div class="card"><h2>App settings</h2>
      <div class="field"><span class="lbl">Clock times</span>
        <div class="seg" role="group" aria-label="Clock times"><button class="${clockMode() === 'local' ? 'on' : ''}" aria-pressed="${clockMode() === 'local'}" data-act="clockMode" data-v="local">Local (flight's zone)</button><button class="${clockMode() === 'zulu' ? 'on' : ''}" aria-pressed="${clockMode() === 'zulu'}" data-act="clockMode" data-v="zulu">Zulu</button></div></div>
      <div class="mut small">Local shows each flight in the zone it departed from, with Zulu alongside. Zulu shows and reads all clock times in UTC.</div>
    </div>
    <div class="card"><h2>Flight timer</h2>
      <div class="mut small">When does the timer you read in flight start? Burnplan shows times and takes timer readings on the same clock.</div>
      <div class="seg" style="grid-template-columns:repeat(2,minmax(0,1fr));margin-top:8px" role="group" aria-label="Flight timer starts">${[['takeoff', 'At takeoff', 'automatic, e.g. GTX 345'], ['engine', 'At engine start', 'started by hand before taxi']].map(([k, l, d]) => `<button class="${(state.settings.timerFrom || 'takeoff') === k ? 'on' : ''}" aria-pressed="${(state.settings.timerFrom || 'takeoff') === k}" data-act="setTimerFrom" data-v="${k}">${l}<br><span class="small mut">${d}</span></button>`).join('')}</div>
      <div class="mut small" style="margin-top:6px">${(state.settings.timerFrom || 'takeoff') === 'engine' ? 'Taxi counts on the timer: +0:00 is engine start and takeoff is at +taxi minutes.' : 'Taxi happens before +0:00 and is not on the timer.'} Applies to flights you start from now on; a flight already started keeps the setting it started with.</div></div>
    <div class="card"><h2>Backup</h2><div class="mut small">Everything is stored only on this phone. Export a backup to keep a copy or move to a new phone; import a backup, flight, tail or type file.</div>
      <div class="row"><button class="btn grow" data-act="exportAll">Export backup</button><label class="btn grow" for="importFile">Import</label><input type="file" id="importFile" accept="application/json,.json" class="hidden"></div></div>
    <div class="buildinfo mono">Burnplan ${APP_VERSION} · build ${APP_BUILD.startsWith('__') ? 'dev' : esc(APP_BUILD)}</div>
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
      ? `<select id="${id}" data-ovr="${path}"><option value="">Default: ${esc(String(def))}</option>${opts.map((o) => `<option ${String(own) === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`
      : `<input id="${id}" class="mono" data-ovr="${path}" value="${own ?? ''}" placeholder="${esc(String(def ?? ''))}" inputmode="decimal">`;
    return `<label for="${id}" class="${own != null ? '' : 'mut'}">${label}${own != null ? ' •' : ''}</label>${control}`;
  };
  return `<div class="top"><div><div class="kicker"><a href="#aircraft">Settings</a> · ${esc(type.name)}</div><h1 class="mono">${esc(tail.tail)}</h1></div></div>
  <div class="stack">
    <div class="mut small">Blank or "Default" = the aircraft type's setting (shown grey). Anything you set here applies to this tail only and is marked •. Changes apply to new plans; flights already planned keep their settings until rebuilt from Setup.</div>
    <div class="card"><h2>Tank capacities (usable gal)</h2><div class="ovr">${cfg.tanks.map((t) => `<label for="cap-${t.id}" class="${ov.capacities?.[t.id] ? '' : 'mut'}">${esc(t.name)} (${esc(t.id)})</label><input id="cap-${t.id}" class="mono" data-cap="${esc(t.id)}" value="${ov.capacities?.[t.id] ?? ''}" placeholder="${type.tanks.find((x) => x.id === t.id).capacity}" inputmode="decimal">`).join('')}</div></div>
    <div class="card"><h2>Fueling</h2><div class="ovr">${cfg.tanks.filter((t) => type.tanks.find((x) => x.id === t.id).tabGal > 0 || ov.tabs?.[t.id]).map((t) => `<label for="tab-${t.id}" class="${ov.tabs?.[t.id] ? '' : 'mut'}">${esc(t.name)} tabs (gal)${ov.tabs?.[t.id] ? ' •' : ''}</label><input id="tab-${t.id}" class="mono" data-tab="${esc(t.id)}" value="${ov.tabs?.[t.id] ?? ''}" placeholder="${type.tanks.find((x) => x.id === t.id).tabGal ?? ''}" inputmode="decimal">`).join('')}</div>
      <div class="mut small">Fill order: ${esc(cfg.fillOrder.join(' → '))} (from the aircraft type).</div></div>
    ${OVR_FIELDS.map(([title, fields]) => `<div class="card"><h2>${title}</h2><div class="ovr">${fields.map(fld).join('')}</div>${title === 'Reserve' ? `<div class="mut small">= ${f1(P.reserveGal(cfg))} gal (${dur(cfg.rules.reserve.min)} @ ${f1(P.reserveGph(cfg))} gph)</div>` : ''}</div>`).join('')}
    <div class="row"><button class="btn grow" data-act="exportTail" data-tail="${esc(tail.tail)}">Share tail setup</button><button class="btn danger grow" data-act="deleteTail" data-tail="${esc(tail.tail)}">Remove</button></div>
  </div>`;
}

function viewTypeEditor(id) {
  const t = typeById(id);
  if (!t) return '<div class="card empty">Type not found.</div>';
  const ro = t.builtin ? 'disabled' : '';
  return `<div class="top"><div><div class="kicker"><a href="#aircraft">Settings</a> · ${t.builtin ? 'Built-in type' : 'Custom type'}</div><h1>${esc(t.name)}</h1></div></div>
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
      <div class="field"><label for="ty-fill">Fill order (POH)</label><input id="ty-fill" class="mono" data-ty="fillOrder" value="${esc((t.fillOrder || t.tanks.map((k) => k.id)).join(', '))}" ${ro}></div>
      <div class="field"><label>Tab level per tank (gal, blank = no tabs)</label><div class="grid4">${t.tanks.map((k, i) => `<div class="field"><label for="tt-${i}">${esc(k.id)}</label><input id="tt-${i}" class="mono" data-tk="${i}.tabGal" value="${k.tabGal ?? ''}" ${ro} inputmode="decimal"></div>`).join('')}</div></div>
      <div class="field"><label for="ty-groups">Burn order: pairs left/right, first used first</label><input id="ty-groups" class="mono" data-ty="groups" value="${esc(t.groups.map((g) => `${g.left}/${g.right}`).join(', '))}" ${ro}></div>
      ${t.both ? `<div class="mut small">Selector has BOTH (${esc(t.both.join(' + '))}, burned equally). Plans run on Both; ${esc(t.both.join(' or '))} alone is for cruise, and a plan that takes off or lands on one tank is flagged.</div>` : ''}
      <div class="grid2">
        <div class="field"><label for="ty-start">Start on</label><select id="ty-start" data-ty="startTank" ${ro}>${P.selectable(t).map((k) => `<option ${t.startTank === k.id ? 'selected' : ''}>${esc(k.id)}</option>`).join('')}</select></div>
        <div class="field"><label for="ty-finish">Finish each group on</label><select id="ty-finish" data-ty="finishSide" ${ro}>${['R', 'L', ''].map((s) => `<option value="${s}" ${(t.finishSide || '') === s ? 'selected' : ''}>${s === 'R' ? 'Right' : s === 'L' ? 'Left' : 'Either'}</option>`).join('')}</select></div>
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

// A floor changed in the tail's settings applies to that tail's current flight (draft or active), which
// otherwise keeps the config it was built with. The plan isn't changed: it's flagged against the new floor
// until the pilot rebuilds it, and every rebuild from then on uses the new floor.
function applyFloorToFlight(tailId) {
  const f = activeFlight();
  if (!f || f.tail !== tailId || f.status === 'closed') return;
  const floor = cfgForTail(tailId)?.rules.floor;
  if (!floor || (floor.gal === f.cfg.rules.floor.gal && floor.mode === f.cfg.rules.floor.mode)) return;
  f.cfg.rules.floor = { ...floor };
  persist();
  toast(`Current flight now uses the ${floor.gal} gal floor. Rebuild the plan to apply it.`, 4000);
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
    const cruise = num($('#nt-cruise')?.value);
    if (!(cruise > 0)) return toast('Enter your cruise burn in gph');
    const typeCruise = typeById(typeId)?.burn.cruise;
    state.tails[tail] = { tail, typeId, overrides: cruise !== typeCruise ? { burn: { cruise } } : {} };
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
  setTimerFrom(el) { state.settings.timerFrom = el.dataset.v; persist(); render(); toast(el.dataset.v === 'engine' ? 'Timer starts at engine start' : 'Timer starts at takeoff'); },
  toggleDone(el) {
    const f = activeFlight();
    if (!f || f.status !== 'active') return toast('Start the flight first');
    const tank = el.dataset.tank;
    const done = P.parkedTanks(f).includes(tank);
    const est = P.estimate(f, f.cfg, now());
    if (!done && P.parkedTanks(f).length >= f.cfg.tanks.length - 1) return toast('Keep at least one tank in use');
    f.events.push({ type: done ? 'unpark' : 'park', tank, at: now(), enteredAt: now(), level: Math.round(est.levels[tank] * 10) / 10 });
    f.events.sort((a, b) => a.at - b.at);
    rebuildFrom(f, now(), done ? `${tank} back in use` : `${tank} done`);
    state.lastInputAt = now();
    closeSheet(); persist(); render();
    toast(done ? `${tank} back in the plan` : `${tank} left at ${f1(est.levels[tank])} · plan rebuilt without it${tank === est.active ? '. Switch off it now' : ''}`);
  },
  regen() {
    const f = activeFlight();
    if (f.status === 'active') rebuildFrom(f, now(), 'manual rebuild');
    else setPlan(f, { ...generateFor(f, { startMin: 0, endMin: f.blockMin, segs: f.segs, levels: f.startLevels }), source: 'generated' }, 'Regenerated');
    persist(); render();
  },
  keepLeg(el) {
    const f = activeFlight();
    const i = +el.dataset.i;
    const row = planCheck(f).rows[i];
    if (!row) return;
    const end = f.engineStart ? fmtTimer(timerAt(f, MS(f, row.startMin + row.min))) : fmtTimer(planTimer(f, row.startMin + row.min));
    ask(`Keep leg${i ? `s 1–${i + 1}` : ' 1'} as planned and rebuild the rest from ${end}?`, 'Rebuild after', () => { rebuildAfterLeg(f, i); persist(); render(); toast(`Kept through leg ${i + 1} · rest rebuilt`); }, 'primary');
  },
  addLeg() {
    const f = activeFlight();
    const last = f.plan.legs[f.plan.legs.length - 1];
    const leg = { tank: last ? last.tank : f.cfg.startTank, min: 20 };
    setPlan(f, { ...f.plan, legs: [...f.plan.legs.map((l) => ({ ...l })), leg], source: 'edited' }, `Edited: added leg ${legTxt(leg)}`);
    persist(); render();
  },
  delLeg(el) {
    const f = activeFlight();
    if (f.plan.legs.length <= 1) return;
    const i = +el.dataset.i;
    const legs = f.plan.legs.map((l) => ({ ...l }));
    const [gone] = legs.splice(i, 1);
    setPlan(f, { ...f.plan, legs, source: 'edited' }, `Edited: removed leg ${i + 1} (${legTxt(gone)})`);
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
  tapTank(el) {
    const f = activeFlight();
    if (!f || f.status !== 'active') return toast('Start the flight first');
    const est = P.estimate(f, f.cfg, now());
    if (el.dataset.tank === est.active) return toast(`Already on ${est.active}. To stop using it, switch first, or use the tank buttons on the Plan page.`);
    openSheet('switch', { tank: el.dataset.tank });
  },
  saveEdit,
  editEvent(el) { const f = state.flights[el.dataset.fid]; openEdit(f, +el.dataset.i); },
  addEvent(el) { const f = state.flights[el.dataset.fid]; openEdit(f, -1, el.dataset.kind); },
  deleteEvent() {
    const f = sheetFlight(), i = ui.sd.i;
    const e = f.events[i];
    ask(`Delete this ${EV_LABEL[e.type] || e.type} entry?`, 'Delete', () => { f.events.splice(i, 1); if (e.type === 'shutdown') { f.shutdown = null; f.finalUsed = null; } afterHistoryEdit(f, 'history edit'); toast('Deleted'); render(); });
  },
  planView(el) { state.settings.planView = el.dataset.v; persist(); render(); },
  exportFlight(el) {
    const f = state.flights[el.dataset.id];
    download(`${f.from || 'flight'}-${f.to || ''}-${new Date(f.engineStart || f.createdAt).toISOString().slice(0, 10)}.burnplan.json`, JSON.stringify({ kind: 'flight', app: APP_NAME, flight: f, tail: state.tails[f.tail] || null }, null, 1), 'application/json');
  },
  replayEnd(el) { ui.replayAt = null; ui.replayFid = el.dataset.fid; render(); },
  newFueling(el) { state.fuelDraft = newFuelDraft(el.dataset.tail); persist(); go('fuel', 'edit'); },
  fuReq(el) { state.fuelDraft.request = el.dataset.v; persist(); render(); },
  fuMode(el) { state.fuelDraft.mode = el.dataset.v; persist(); render(); },
  fuAddStep() {
    const d = state.fuelDraft, cfg = cfgForTail(d.tail);
    const used = new Set(d.steps.map((x) => x.tank));
    d.steps.push({ tank: cfg.fillOrder.find((id) => !used.has(id)) || cfg.fillOrder[0], reading: '' });
    persist(); render();
  },
  fuDelStep(el) { state.fuelDraft.steps.splice(+el.dataset.i, 1); persist(); render(); },
  fuDiscard() {
    const d = state.fuelDraft;
    ask(d.id ? 'Cancel your changes to this fueling?' : 'Discard this fueling?', d.id ? 'Cancel changes' : 'Discard', () => { const id = d.id; state.fuelDraft = null; persist(); go('fuel', id || null); });
  },
  fuSave() {
    const d = state.fuelDraft;
    const { res } = fuelingCalc(d);
    const total = d.mode === 'total';
    if (total && !(num(d.totalAdded) > 0)) return toast('Enter the total gallons added');
    if (!total && !d.steps.some((x) => x.reading !== '' && isFinite(num(x.reading)))) return toast('Enter the pump reading for at least one tank');
    const bad = res.stepGal.findIndex((g, i) => g != null && g < 0);
    if (bad >= 0) return toast(`Step ${bad + 1}: pump reading is lower than the one before`);
    const id = d.id || uid();
    const clean = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v !== '' && v != null));
    state.fuelings = state.fuelings || {};
    state.fuelings[id] = {
      id, tail: d.tail, at: d.at, tz: d.tz, airport: (d.airport || '').toUpperCase(), request: d.request,
      amounts: d.request === 'amounts' ? Object.fromEntries(Object.entries(clean(d.amounts)).map(([k, v]) => [k, num(v)])) : {},
      before: Object.fromEntries(Object.entries(d.before || {}).map(([k, v]) => [k, v === '' || v == null ? null : num(v)])),
      mode: total ? 'total' : 'tanks', totalAdded: total ? num(d.totalAdded) : null,
      startReading: total ? 0 : num(d.startReading) || 0,
      steps: total ? [] : d.steps.filter((x) => x.reading !== '' && isFinite(num(x.reading))).map((x) => ({ tank: x.tank, reading: num(x.reading) })),
      gaugeBefore: clean(d.gaugeBefore), gaugeAfter: clean(d.gaugeAfter), note: (d.note || '').trim() || null, savedAt: now()
    };
    state.fuelDraft = null;
    ui.draft = null; state.settings.draft = null; // next flight's starting fuel picks this up
    persist(); toast(`Fueling saved · ${f1(res.total)} gal`); go('fuel', id);
  },
  fuEdit(el) {
    const x = state.fuelings[el.dataset.id];
    const s = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, v == null ? '' : String(v)]));
    const cfg = cfgForTail(x.tail);
    const steps = x.mode === 'total' ? cfg.fillOrder.map((id) => ({ tank: id, reading: '' })) : x.steps;
    state.fuelDraft = { ...x, mode: x.mode || 'tanks', totalAdded: x.totalAdded == null ? '' : String(x.totalAdded), before: s(x.before), amounts: s(x.amounts), startReading: String(x.startReading), steps: steps.map((y) => ({ tank: y.tank, reading: String(y.reading) })), gaugeBefore: s(x.gaugeBefore), gaugeAfter: s(x.gaugeAfter), note: x.note || '', beforeLabel: null };
    persist(); go('fuel', 'edit');
  },
  fuDelete(el) { const id = el.dataset.id; ask('Delete this fueling?', 'Delete', () => { delete state.fuelings[id]; persist(); go('fuel'); }); },
  saveStart: () => saveSheet('start'),
  saveClimb: () => saveSheet('climb'),
  saveLevel: () => saveSheet('level'),
  saveDescent: () => saveSheet('descent'),
  saveLanded: () => saveSheet('landed'),
  saveBurn: () => saveSheet('burn'),
  saveGauge: () => saveSheet('gauge'),
  exportGauges() {
    const rows = [['flight', 'date_utc', 'tail', 'phase', 'flight_timer', 'tank', 'capacity', 'indicated', 'calculated', 'indicated_minus_calculated', 'note']];
    for (const p of gaugePoints()) rows.push([`${p.f.from || ''}-${p.f.to || ''}`, new Date(p.e.at).toISOString(), p.f.tail, p.e.phase || gaugePhase(p.f, p.e.at), p.f.engineStart && p.e.at >= p.f.engineStart ? fmtTimer(timerAt(p.f, p.e.at)) : '', p.tank, p.cap, f1(p.ind), f1(p.calc), f1(p.diff), p.e.note || '']);
    download(`gauge-calibration-${new Date().toISOString().slice(0, 10)}.csv`, rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n'), 'text/csv');
  },
  sdScope(el) { ui.sd.scope = el.dataset.v; renderSheet(); },
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
      if (isFinite(t)) ui.sd.rows = plannedSwitchesBefore(activeFlight(), t - activeFlight().taxiMin * MIN, ui.sd.tank, now()).map((x) => ({ tank: x.tank, at: durS((x.at - t) / MIN) }));
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
  alertSwitch() { const a = ui.alert; ui.alert = null; ui.viewTime = null; renderAlert(); go('fly'); openSheet('switch', { tank: a?.tank }); },
  alertDismiss() { ui.alert = null; renderAlert(); },
  alertLevel() { ui.alert = null; renderAlert(); go('fly'); openSheet('level'); },
  sdUseGuess(el) { ui.sd.at = el.dataset.v; ui.sd.atStamp = now(); const i = $('#sd-at'); if (i) i.value = ui.sd.at; renderSheetPreview(); },
  sdLongOk() { ui.sd.longOk = true; renderSheetPreview(); },
  resetStart(el) {
    const f = state.flights[el.dataset.id || state.activeFlightId];
    ask('Undo the start of this flight? Takeoff, switches, climbs, fuel checks and ETE updates are removed and it goes back to planned.', 'Undo start', () => {
      f.events = f.events.filter((e) => e.type === 'gauge'); // calibration readings are kept
      f.engineStart = null; f.takeoff = null; f.startTank = null; f.shutdown = null; f.finalUsed = null;
      f.freezeAt = null; f.snoozeUntil = null; f.divert = null; f.autoEnded = false; f.autoSaved = false;
      f.status = 'draft';
      if (f.alt && f.alt.onBeforeDivert !== undefined) { f.alt.on = f.alt.onBeforeDivert; delete f.alt.onBeforeDivert; }
      setPlan(f, { ...generateFor(f, { startMin: 0, endMin: f.blockMin, segs: f.segs, levels: f.startLevels, currentTank: null }), source: 'generated' }, 'Start undone');
      state.activeFlightId = f.id;
      ui.viewTime = null; ui.alert = null;
      persist(); go('fly');
      toast('Back to planned. Tap Start flight when you are ready.');
    });
  },
  clockMode(el) { state.settings.clockMode = el.dataset.v; persist(); render(); toast(el.dataset.v === 'zulu' ? 'Clock times now in Zulu' : 'Clock times now in each flight\'s local zone'); },
  sdAtMs(el) { ui.sd.at = sheetFieldValue(+el.dataset.ms); const i = $('#sd-at'); if (i) i.value = ui.sd.at; renderSheetPreview(); },
  alertShutdown() { ui.alert = null; renderAlert(); go('fly'); openSheet('shutdown'); },
  stillFlying() {
    const f = activeFlight();
    ui.alert = null; renderAlert();
    f.freezeAt = null;
    f.snoozeUntil = now() + 15 * MIN;
    persist(); go('fly');
    openSheet('ete');
    toast('Burn estimate resumed. Update the ETE so the landing check moves too.');
  },
  emptySwitch() {
    const f = activeFlight();
    const e = P.estimate(f, f.cfg, now()).empty;
    ui.alert = null; renderAlert(); go('fly');
    openSheet('switch', { atMs: e ? e.at : now(), tank: null });
  },
  exportAll() {
    const data = { kind: 'backup', app: APP_NAME, exportedAt: new Date().toISOString(), tails: state.tails, customTypes: state.customTypes, flights: state.flights, fuelings: state.fuelings };
    download(`${APP_NAME.toLowerCase()}-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 1), 'application/json');
  },
  exportCsv(el) { const f = state.flights[el.dataset.id]; download(`${f.from || 'flight'}-${f.to || ''}-${new Date(f.engineStart || f.createdAt).toISOString().slice(0, 10)}.csv`, flightCsv(f), 'text/csv'); },
  deleteFlight(el) { const id = el.dataset.id; ask('Delete this flight from the log?', 'Delete', () => { delete state.flights[id]; persist(); go('log'); }); },
  reactivate(el) {
    const cur = activeFlight();
    if (cur && cur.status === 'active') return toast('Another flight is in progress. End it on the Fly tab first.');
    const f = state.flights[el.dataset.id];
    ask(`Reactivate this flight? The shutdown is removed and it resumes as if you never shut down.`, 'Reactivate', () => {
      if (cur && cur.status === 'draft') cur.status = 'saved';
      f.events = f.events.filter((e) => e.type !== 'shutdown');
      f.shutdown = null; f.finalUsed = null; f.freezeAt = null; f.autoEnded = false; f.autoSaved = false;
      f.snoozeUntil = now() + 30 * MIN;          // don't immediately re-run the landing check
      f.status = 'active';
      f.events.push({ type: 'reactivate', at: now(), enteredAt: now() });
      state.activeFlightId = f.id;
      state.lastInputAt = now();
      ui.draft = null; ui.alert = null;
      rebuildFrom(f, now(), 'reactivated');
      persist();
      go('fly');
      openSheet('ete');
      toast('Flight reactivated. Enter the current ETE so the plan and landing check are right.');
    });
  },
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
      if (t.both) { t.both = t.both.filter((id) => id !== gone.id); if (t.both.length < 2) { delete t.both; if (t.startTank === P.BOTH) t.startTank = t.tanks[0]?.id; } }
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
export function autoColonHMS(v) {
  let d = String(v).replace(/\D/g, '').slice(0, 6).replace(/^0+(?=\d)/, '');
  if (!d) return '';
  d = d.padStart(5, '0');
  return `${+d.slice(0, -4)}:${d.slice(-4, -2)}:${d.slice(-2)}`;
}

export function autoColon(v) {
  let d = String(v).replace(/\D/g, '').slice(0, 4).replace(/^0+(?=\d)/, '');
  if (!d) return '';
  d = d.padStart(3, '0');
  return `${+d.slice(0, -2)}:${d.slice(-2)}`;
}

function onField(ev, committed) {
  const el = ev.target;
  if (el.dataset.ntType !== undefined) { const c = $('#nt-cruise'); if (c) c.value = typeById(el.value)?.burn.cruise ?? ''; return; }
  if ((el.dataset.fmt === 'hm' || el.dataset.fmt === 'hms') && !committed) {
    el.value = el.dataset.fmt === 'hms' ? autoColonHMS(el.value) : autoColon(el.value);
    try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) { /* ignore */ }
  }
  if (el.dataset.d !== undefined && ui.draft) {
    const v = el.type === 'checkbox' ? el.checked : el.value;
    setPath(ui.draft, el.dataset.d, v);
    if (el.dataset.d === 'tail') { const nt = el.value; ui.draft = { ...defaultDraft(), ...ui.draft, tail: nt, levels: startLevelsFor(nt, cfgForTail(nt)) }; render(); return; }
    if (el.dataset.d === 'alt.on') $('#altFields')?.classList.toggle('hidden', !el.checked);
    state.settings.draft = activeFlight() ? null : ui.draft;
    renderSetupCalc();
    if (committed) persist();
    return;
  }
  if (state.fuelDraft && ui.route === 'fuel' && (el.dataset.fu || el.dataset.fub || el.dataset.fua || el.dataset.fgb || el.dataset.fga || el.dataset.fstank || el.dataset.fsread)) {
    const d = state.fuelDraft;
    if (el.dataset.fu === 'atClock') { const t = parseClockZ(el.value, now()); if (committed && isFinite(t)) d.at = t; }
    else if (el.dataset.fu) d[el.dataset.fu] = el.value;
    else if (el.dataset.fub) d.before[el.dataset.fub] = el.value;
    else if (el.dataset.fua) (d.amounts = d.amounts || {})[el.dataset.fua] = el.value;
    else if (el.dataset.fgb) (d.gaugeBefore = d.gaugeBefore || {})[el.dataset.fgb] = el.value;
    else if (el.dataset.fga) (d.gaugeAfter = d.gaugeAfter || {})[el.dataset.fga] = el.value;
    else if (el.dataset.fstank) d.steps[+el.dataset.fstank].tank = el.value;
    else if (el.dataset.fsread) d.steps[+el.dataset.fsread].reading = el.value;
    // Re-render after a pause, keeping focus where the user is now, so moving to the next field never eats typing.
    clearTimeout(onField._fu);
    if (el.dataset.fstank) { persist(); render(); return; }
    onField._fu = setTimeout(() => { persist(); const y = window.scrollY, id = document.activeElement?.id; render(); window.scrollTo(0, y); const n = id && document.getElementById(id); if (n) { n.focus(); try { n.setSelectionRange(n.value.length, n.value.length); } catch (e) { /* select */ } } }, committed ? 50 : 600);
    return;
  }
  if (el.dataset.fueltail !== undefined) { state.settings.fuelTail = el.value; persist(); render(); return; }
  if (el.dataset.gauge !== undefined) {
    ui.sd.vals = ui.sd.vals || {};
    ui.sd.vals[el.dataset.gauge] = el.value;
    renderSheetPreview();
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
    if (el.dataset.sd === 'at') { ui.sd.atStamp = now(); ui.sd.longOk = false; }
    if (el.dataset.sd === 'divert') $('#divIdent')?.classList.toggle('hidden', !el.checked);
    renderSheetPreview();
    return;
  }
  if (!committed) return;
  if (el.id === 'replayAt') {
    const fl = state.flights[el.dataset.fid];
    const d = P.parseDur(el.value);
    if (!isFinite(d)) return toast('Enter the flight timer as h:mm:ss');
    ui.replayAt = fromTimer(fl, d); ui.replayFid = fl.id; ui.openVersions = !!$('details.card[open] .pv');
    render(); return;
  }
  if (el.dataset.ftz) { const fl = state.flights[el.dataset.ftz]; fl.tz = el.value; persist(); render(); toast(`Clock times for this flight now in ${zoneAbbr(el.value, takeoffOf(fl) || now())}`); return; }
  if (el.dataset.legTank !== undefined) return editLeg(+el.dataset.legTank, 'tank', el.value);
  if (el.dataset.legMin !== undefined) return editLeg(+el.dataset.legMin, 'min', el.value);
  if (el.dataset.legAfter !== undefined) return editLeg(+el.dataset.legAfter, 'after', el.value);
  if (el.id === 'flyTime') {
    const f = activeFlight();
    let t;
    if (flyMode(f) === 'timer') { const d = P.parseDur(el.value); t = isFinite(d) ? fromTimer(f, d) : NaN; }
    else t = parseClockZ(el.value, now());
    if (!isFinite(t)) { toast(flyMode(f) === 'timer' ? 'Enter the flight timer as h:mm' : 'Enter the time as HH:MM'); return; }
    ui.viewTime = Math.abs(t - now()) < MIN ? null : t;
    ui.viewSetAt = now();
    render();
    return;
  }
  if (el.dataset.ovr) { const tid = decodeURIComponent(ui.sub); setOverride(tid, el.dataset.ovr, el.value.trim()); if (committed && el.dataset.ovr.startsWith('rules.floor')) applyFloorToFlight(tid); render(); return; }
  if (el.dataset.tab) {
    const tail = state.tails[decodeURIComponent(ui.sub)];
    tail.overrides = tail.overrides || {};
    tail.overrides.tabs = tail.overrides.tabs || {};
    const v = num(el.value);
    if (isFinite(v) && v > 0) tail.overrides.tabs[el.dataset.tab] = v; else delete tail.overrides.tabs[el.dataset.tab];
    if (!Object.keys(tail.overrides.tabs).length) delete tail.overrides.tabs;
    persist(); render(); return;
  }
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
      if (k === 'tabGal') v = num(v) > 0 ? num(v) : undefined;
      if (k === 'id') { v = String(v).trim().toUpperCase() || old; t.groups.forEach((g) => { if (g.left === old) g.left = v; if (g.right === old) g.right = v; }); if (t.startTank === old) t.startTank = v; if (t.both) t.both = t.both.map((id) => (id === old ? v : id)); }
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
      } else if (el.dataset.ty === 'fillOrder') {
        const ids = new Set(t.tanks.map((k) => k.id));
        const order = el.value.split(/[,\s→>]+/).map((x) => x.trim().toUpperCase()).filter((x) => ids.has(x));
        if (order.length) t.fillOrder = [...new Set(order)]; else toast('List tank IDs in order, like LT, RT, LM, RM');
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
  if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches?.('[role=button][data-act]')) { ev.preventDefault(); ev.target.click(); }
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

// ---------- 1 s ticker: flight timer, countdowns ----------
setInterval(() => {
  if (ui.route !== 'fly') return;
  const f = activeFlight();
  if (!f || !f.engineStart) return;
  const el = $('#elapsed'); if (el) el.textContent = fmtTimerS(timerAt(f, now()));
  // live countdowns only; while viewing another moment the switch card counts from that moment instead
  document.querySelectorAll('[data-count]').forEach((n) => { n.textContent = countTxt(+n.dataset.count); });
  if (ui.viewTime) return;
  const ft = $('#flyTime'); if (ft && document.activeElement !== ft) ft.value = flyTimeValue(f);
}, 1000);

// ---------- tick ----------
setInterval(() => {
  if (checkIdle()) return;
  checkAlerts();
  if (ui.viewTime && now() - Math.max(ui.viewSetAt || 0, state.lastInputAt || 0) > 2 * MIN && document.activeElement?.id !== 'flyTime') {
    ui.viewTime = null;
    if (ui.route === 'fly') render();
  }
  if (ui.route === 'fly' && !ui.viewTime && document.activeElement?.id !== 'flyTime') {
    const ft = $('#flyTime'); if (ft) ft.value = flyTimeValue(activeFlight());
    renderFlyLive();
  } else if (ui.route === 'fly') renderFlyLive();
  // Plan tab: keep the now marker, timer readings and flown/remaining split current (once a minute,
  // and never while you're editing a leg or have a panel open).
  const fp = activeFlight();
  if (ui.route === 'plan' && fp && fp.status === 'active' && !ui.sheet) {
    const minute = Math.floor(now() / MIN);
    const editing = document.activeElement && $('#app').contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
    if (minute !== ui.planMinute && !editing) {
      ui.planMinute = minute;
      const y = window.scrollY;
      $('#app').innerHTML = viewPlan();
      window.scrollTo(0, y);
    }
  }
  if (ui.alert) renderAlert();
}, 5000);

// ---------- boot ----------
document.title = APP_NAME;
readHash();
if (!checkIdle()) { checkLanding(); render(); }
S.requestPersistence();
// Updates: check whenever the app comes to the front; when a new version takes over, reload into it
// (unless a panel is open, in which case say so and reload when it closes).
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
    setInterval(() => reg.update().catch(() => {}), 30 * MIN);
  }).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return; // first install, nothing to swap
    const go = () => { persist(); location.reload(); };
    if (!ui.sheet) go();
    else { toast('Update downloaded. It will load when you close this panel.', 6000); ui.reloadPending = go; }
  });
}

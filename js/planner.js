// Pure planning/estimation logic. No DOM, no storage — testable in Node.

export const EPS = 1e-6;
export const TOL = 0.05; // gal tolerance for rule checks
const MS_MIN = 60000;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function deepMerge(target, src) {
  if (!isObj(src)) return target;
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (v === undefined || v === null || v === '') continue;
    if (isObj(v) && isObj(target[k])) deepMerge(target[k], v);
    else target[k] = isObj(v) ? deepMerge({}, v) : v;
  }
  return target;
}

// type + tail overrides + per-flight overrides -> effective config
export function resolveConfig(type, tail, flightOverrides) {
  const cfg = JSON.parse(JSON.stringify(type));
  const ov = (tail && tail.overrides) || {};
  deepMerge(cfg, { burn: ov.burn, rules: ov.rules, alerts: ov.alerts, idleHours: ov.idleHours });
  if (ov.capacities) for (const t of cfg.tanks) if (ov.capacities[t.id] > 0) t.capacity = +ov.capacities[t.id];
  if (flightOverrides) deepMerge(cfg, flightOverrides);
  return cfg;
}

export function tankMap(cfg) { return Object.fromEntries(cfg.tanks.map((t) => [t.id, t])); }

export function reserveGal(cfg) {
  const r = cfg.rules.reserve;
  if (!r || r.mode === 'off') return 0;
  const gph = r.rate === 'base' ? cfg.burn.base : r.rate === 'cruise' ? cfg.burn.cruise : +r.customGph || 0;
  return (r.min / 60) * gph;
}

export function reserveGph(cfg) {
  const r = cfg.rules.reserve;
  return r.rate === 'base' ? cfg.burn.base : r.rate === 'cruise' ? cfg.burn.cruise : +r.customGph || cfg.burn.base;
}

// ---- burn timeline -------------------------------------------------------
// Segments are in minutes from engine start. ForeFlight total fuel includes taxi.
// climbMin / climbGph / cruiseGph override the aircraft profile for this flight.
// With no cruise override, cruise is derived so the total matches ForeFlight.
export function buildTimeline(cfg, { taxiMin = 0, eteMin = 0, totalFuel = 0, climbMin: cm, climbGph: cg, cruiseGph: cr }) {
  const b = cfg.burn;
  const climbGph = cg > 0 ? cg : b.climbGph;
  const taxiFuel = (taxiMin / 60) * b.ground;
  const climbMin = Math.min(cm >= 0 && cm !== null && cm !== undefined && cm !== '' ? +cm : b.climbMin || 0, eteMin);
  const climbFuel = (climbMin / 60) * climbGph;
  const cruiseMin = Math.max(0, eteMin - climbMin);
  let cruiseGph = b.cruise;
  let derived = false;
  let issue = null;
  if (cr > 0) cruiseGph = +cr;
  else if (totalFuel > 0 && cruiseMin > 0) {
    const f = totalFuel - taxiFuel - climbFuel;
    if (f > 0) { cruiseGph = f / (cruiseMin / 60); derived = true; }
    else issue = 'ForeFlight fuel is less than taxi + climb; using typical cruise.';
  }
  const segments = [
    { phase: 'taxi', start: 0, min: taxiMin, gph: b.ground },
    { phase: 'climb', start: taxiMin, min: climbMin, gph: climbGph },
    { phase: 'cruise', start: taxiMin + climbMin, min: cruiseMin, gph: cruiseGph }
  ].filter((s) => s.min > 0);
  const total = segments.reduce((a, s) => a + (s.min / 60) * s.gph, 0);
  return { segments, taxiFuel, climbMin, climbGph, climbFuel, cruiseMin, cruiseGph, derived, issue, blockMin: taxiMin + eteMin, totalFuel: total, ffTotal: totalFuel };
}

export function rateAt(segs, t) {
  if (!segs.length) return 0;
  for (const s of segs) if (t >= s.start - EPS && t < s.start + s.min - EPS) return s.gph;
  return t < segs[0].start ? segs[0].gph : segs[segs.length - 1].gph;
}

export function fuelBetween(segs, t0, t1) {
  if (t1 <= t0 || !segs.length) return 0;
  let total = 0;
  const last = segs[segs.length - 1];
  const end = last.start + last.min;
  for (const s of segs) {
    const a = Math.max(t0, s.start), b = Math.min(t1, s.start + s.min);
    if (b > a) total += ((b - a) / 60) * s.gph;
  }
  if (t1 > end) total += ((t1 - Math.max(t0, end)) / 60) * last.gph; // extrapolate past end
  return total;
}

// Which phases a stretch of the timeline covers, e.g. [{phase:'taxi',min:20},{phase:'climb',min:12}].
export function phasesBetween(segs, t0, t1) {
  const out = [];
  for (const sg of segs) {
    const a = Math.max(t0, sg.start), b = Math.min(t1, sg.start + sg.min);
    if (b - a > 0.05) {
      const last = out[out.length - 1];
      if (last && last.phase === sg.phase && Math.abs(last.gph - sg.gph) < 1e-6) last.min += b - a;
      else out.push({ phase: sg.phase, min: b - a, gph: sg.gph });
    }
  }
  const end = segs.length ? segs[segs.length - 1].start + segs[segs.length - 1].min : 0;
  if (t1 > end + 0.05 && segs.length) out.push({ phase: segs[segs.length - 1].phase, min: t1 - Math.max(t0, end), gph: segs[segs.length - 1].gph });
  return out;
}

export function timeForFuel(segs, t0, fuel) {
  let t = t0, left = fuel, guard = 0;
  while (left > EPS && guard++ < 1000) {
    const gph = rateAt(segs, t);
    if (gph <= 0) return Infinity;
    const seg = segs.find((s) => t >= s.start - EPS && t < s.start + s.min - EPS);
    const segEnd = seg ? seg.start + seg.min : Infinity;
    const can = ((segEnd - t) / 60) * gph;
    if (can >= left) return t + (left / gph) * 60 - t0;
    left -= can;
    t = segEnd;
  }
  return t - t0;
}

// ---- plan generation -----------------------------------------------------
// Greedy "longest legs": each leg burns until the next switch is needed to stay inside the
// imbalance band or the tank reaches its planned minimum (floor + any reserve hold).
export function generatePlan({ cfg, segs, startMin = 0, endMin, levels, currentTank = null, requiredLanding = 0 }) {
  const tm = tankMap(cfg);
  const ids = cfg.tanks.map((t) => t.id);
  const floor = cfg.rules.floor.gal;
  const extra = Math.max(0, requiredLanding - floor * ids.length);
  const minLvl = {};
  for (const id of ids) minLvl[id] = Math.min(levels[id], floor + extra / ids.length);
  const lv = { ...levels };
  const usable = (id) => Math.max(0, lv[id] - minLvl[id]);
  const side = (id) => tm[id].side;
  const sideTotal = (s) => ids.filter((i) => side(i) === s).reduce((a, i) => a + lv[i], 0);
  const flip = (s) => (s === 'L' ? 'R' : 'L');
  const band = Math.max(0.5, cfg.rules.imbalance.gal - (cfg.rules.switchMargin ?? 1));
  const groups = cfg.groups;

  const need = fuelBetween(segs, startMin, endMin);
  let rem = need;
  const fuelLegs = [];
  const push = (tank, fuel) => {
    const last = fuelLegs[fuelLegs.length - 1];
    if (last && last.tank === tank) last.fuel += fuel;
    else fuelLegs.push({ tank, fuel });
  };

  let gStart = 0;
  if (currentTank) { const i = groups.findIndex((g) => g.left === currentTank || g.right === currentTank); if (i >= 0) gStart = i; }
  let lastGroupUsed = -1;
  let lastGroupLegStart = 0;

  for (let gi = gStart; gi < groups.length && rem > EPS; gi++) {
    const g = groups[gi];
    const uL = usable(g.left), uR = usable(g.right);
    const b = Math.min(rem, uL + uR);
    if (b <= EPS) continue;
    const SL = sideTotal('L'), SR = sideTotal('R');
    let bL = clamp((b + SL - SR) / 2, 0, uL);
    const bR = clamp(b - bL, 0, uR);
    bL = clamp(b - bR, 0, uL);
    let rL = bL, rR = bR;
    let s;
    if (gi === gStart && currentTank && (currentTank === g.left || currentTank === g.right)) s = side(currentTank);
    else if (gi === 0 && cfg.startTank) s = side(cfg.startTank);
    else s = 'L';
    lastGroupUsed = gi;
    lastGroupLegStart = fuelLegs.length;
    let guard = 0;
    while ((rL > EPS || rR > EPS) && guard++ < 200) {
      const tank = s === 'L' ? g.left : g.right;
      const r = s === 'L' ? rL : rR;
      const other = s === 'L' ? rR : rL;
      if (r <= EPS) { s = flip(s); continue; }
      const can = sideTotal(s) - (sideTotal(flip(s)) - band);
      let burn = Math.min(r, Math.max(0, can));
      if (burn <= EPS) {
        if (other > EPS) { s = flip(s); continue; }
        burn = r; // forced; rule check will flag the imbalance
      }
      lv[tank] -= burn;
      if (s === 'L') rL -= burn; else rR -= burn;
      rem -= burn;
      push(tank, burn);
      s = flip(s);
    }
  }

  // Finish on the configured side of the last group used (e.g. right tip / right main).
  if (cfg.finishSide && lastGroupUsed >= 0 && fuelLegs.length > 1) {
    const g = groups[lastGroupUsed];
    const finishTank = cfg.finishSide === 'R' ? g.right : g.left;
    const last = fuelLegs[fuelLegs.length - 1];
    if (last.tank !== finishTank) {
      let j = -1;
      for (let i = fuelLegs.length - 2; i >= lastGroupLegStart; i--) if (fuelLegs[i].tank === finishTank) { j = i; break; }
      if (j >= 0) {
        const x = fuelLegs[j].fuel / 2;
        fuelLegs[j].fuel -= x;
        fuelLegs.push({ tank: finishTank, fuel: x });
      }
    }
  }

  // Convert fuel legs to whole-minute legs on the timeline.
  const legs = [];
  let t = startMin;
  const covered = need - Math.max(0, rem);
  for (let i = 0; i < fuelLegs.length; i++) {
    const fl = fuelLegs[i];
    const isLast = i === fuelLegs.length - 1;
    // Fractional minutes are kept internally (display rounds); avoids leaking fuel into "short".
    let end;
    if (isLast && rem <= EPS) end = endMin;
    else end = t + timeForFuel(segs, t, fl.fuel);
    if (end - t < 0.5 && !isLast) continue;
    if (end <= t) continue;
    legs.push({ tank: fl.tank, startMin: t, min: end - t });
    t = end;
  }
  // If a dropped tiny leg left a gap at the end with no shortfall, extend last leg.
  let short = null;
  if (rem > EPS) {
    const shortFuel = fuelBetween(segs, t, endMin);
    short = { startMin: t, min: endMin - t, fuel: shortFuel };
  } else if (legs.length && t < endMin) {
    legs[legs.length - 1].min += endMin - t;
  }
  for (const l of legs) l.fuel = fuelBetween(segs, l.startMin, l.startMin + l.min);
  return { legs, short, need, covered };
}

// ---- rule checks ----------------------------------------------------------
// Simulates a plan (generated or user-edited) and returns per-leg results + issues.
export function checkPlan({ cfg, segs, legs, levels, startMin = 0, endMin, requiredLanding = 0, fromEngineStart = true }) {
  const tm = tankMap(cfg);
  const ids = cfg.tanks.map((t) => t.id);
  const r = cfg.rules;
  const sev = (mode) => (mode === 'hard' ? 'error' : mode === 'off' ? null : 'warn');
  const lv = { ...levels };
  const sideTot = (s) => ids.filter((i) => tm[i].side === s).reduce((a, i) => a + lv[i], 0);
  const issues = [];
  const rows = [];
  const add = (rule, severity, legIndex, msg) => { if (severity) issues.push({ rule, severity, legIndex, msg }); };
  const groupOf = (id) => cfg.groups.findIndex((g) => g.left === id || g.right === id);

  let t = startMin;
  let maxImb = 0;
  let lastGroup = -1;
  legs.forEach((leg, i) => {
    const start = t;
    const fuel = fuelBetween(segs, start, start + leg.min);
    lv[leg.tank] -= fuel;
    t = start + leg.min;
    const L = sideTot('L'), R = sideTot('R');
    const imb = L - R;
    maxImb = Math.max(maxImb, Math.abs(imb));
    const flags = [];
    if (lv[leg.tank] < -TOL) { flags.push('empty'); add('empty', 'error', i, `${leg.tank} runs dry`); }
    else if (lv[leg.tank] < r.floor.gal - TOL) { flags.push('floor'); add('floor', sev(r.floor.mode), i, `${leg.tank} below ${r.floor.gal} gal floor`); }
    if (Math.abs(imb) > r.imbalance.gal + TOL) { flags.push('imbalance'); add('imbalance', sev(r.imbalance.mode), i, `Imbalance ${Math.abs(imb).toFixed(1)} gal > ${r.imbalance.gal}`); }
    const gi = groupOf(leg.tank);
    if (gi >= 0 && gi < lastGroup) { flags.push('sequence'); add('sequence', 'warn', i, `${leg.tank} after a later tank group`); }
    if (gi > lastGroup) lastGroup = gi;
    if (i > 0 && i < legs.length - 1 && leg.min < (r.minLegMin || 0)) { flags.push('short'); add('shortleg', 'info', i, `Leg ${i + 1} is ${leg.min} min`); }
    if (i > 0 && legs[i - 1].tank === leg.tank) { flags.push('dup'); add('dup', 'info', i, `Leg ${i + 1} repeats ${leg.tank}`); }
    rows.push({ ...leg, startMin: start, fuel, after: lv[leg.tank], levels: { ...lv }, L, R, imb, flags });
  });

  if (fromEngineStart && legs.length && cfg.startTank && legs[0].tank !== cfg.startTank) add('sequence', 'warn', 0, `Starts on ${legs[0].tank}, not ${cfg.startTank}`);
  if (fromEngineStart && legs.length && tm[legs[0].tank] && tm[legs[0].tank].takeoffLanding === false) add('takeoff', 'error', 0, `${legs[0].tank} not approved for takeoff`);
  if (legs.length) {
    const last = legs[legs.length - 1];
    if (tm[last.tank] && tm[last.tank].takeoffLanding === false) add('landing', 'error', legs.length - 1, `${last.tank} not approved for landing`);
    if (cfg.finishSide && tm[last.tank] && tm[last.tank].side !== cfg.finishSide) add('finish', 'info', legs.length - 1, `Finishes on ${last.tank}`);
  }
  if (Math.abs(t - endMin) > 0.5) {
    if (t < endMin) add('coverage', 'error', legs.length - 1, `Plan ends ${Math.round(endMin - t)} min before arrival`);
    else add('coverage', 'warn', legs.length - 1, `Plan runs ${Math.round(t - endMin)} min past arrival`);
  }
  // Landing fuel: extend to arrival if the plan stops short (on the last tank).
  let landLv = { ...lv };
  if (t < endMin && legs.length) landLv[legs[legs.length - 1].tank] -= fuelBetween(segs, t, endMin);
  const landing = ids.reduce((a, i) => a + landLv[i], 0);
  if (requiredLanding > 0 && landing < requiredLanding - TOL) add('reserve', sev(r.reserve.mode), legs.length - 1, `Lands with ${landing.toFixed(1)}; reserve needs ${requiredLanding.toFixed(1)}`);
  const landImb = ids.filter((i) => tm[i].side === 'L').reduce((a, i) => a + landLv[i], 0) - ids.filter((i) => tm[i].side === 'R').reduce((a, i) => a + landLv[i], 0);
  if (r.landBalanced && t >= endMin - 0.5 && Math.abs(landImb) > 3) add('landbalance', 'info', legs.length - 1, `Lands ${Math.abs(landImb).toFixed(1)} gal ${landImb > 0 ? 'left' : 'right'} heavy`);
  return { rows, issues, landing, landLevels: landLv, landImb, maxImb, planEnd: t };
}

// ---- in-flight estimation ------------------------------------------------
// flight: { engineStart, takeoff, startLevels, startTank, segs (min from engine start), cruiseGph, climbMin, events[] }
// events: {type:'switch', tank, at} | {type:'check', at, used} | {type:'ete', at, eteMin, fuelToDest, gph}
//         {type:'climb', at, gph, until?} (until = expected/actual level-off) | {type:'level', at}
const takeoffMs = (f) => f.takeoff ?? (f.engineStart + ((f.segs.find((s) => s.phase === 'taxi') || { min: 0 }).min) * MS_MIN);

// The climb in progress at ms, if any.
export function activeClimb(flight, ms) {
  const evs = (flight.events || []).filter((e) => e.at <= ms && (e.type === 'climb' || e.type === 'level')).sort((a, b) => a.at - b.at);
  const last = evs[evs.length - 1];
  if (!last || last.type !== 'climb') return null;
  if (last.until && ms >= last.until) return null;
  return last;
}

function lastEteRate(flight, ms) {
  const etes = (flight.events || []).filter((e) => e.type === 'ete' && e.at <= ms).sort((a, b) => a.at - b.at);
  const e = etes[etes.length - 1];
  if (!e) return null;
  if (e.fuelToDest > 0 && e.eteMin > 0) return { at: e.at, gph: e.fuelToDest / (e.eteMin / 60) };
  if (e.gph > 0) return { at: e.at, gph: e.gph };
  return null;
}

export function cruiseRateAt(flight, ms) {
  const e = lastEteRate(flight, ms);
  if (e) return e.gph;
  return flight.cruiseGph || rateAt(flight.segs, Infinity);
}

// Burn rate and phase at a moment.
export function phaseAt(flight, ms) {
  const to = takeoffMs(flight);
  if (ms < to) return { phase: 'taxi', gph: rateAt(flight.segs, (ms - flight.engineStart) / MS_MIN) };
  const c = activeClimb(flight, ms);
  if (c) return { phase: 'climb', gph: c.gph, since: c.at, until: c.until || null };
  const hasClimbEvents = (flight.events || []).some((e) => e.type === 'climb' && e.at <= ms);
  const e = lastEteRate(flight, ms);
  if (hasClimbEvents || e) return { phase: 'cruise', gph: cruiseRateAt(flight, ms) };
  const t = (ms - flight.engineStart) / MS_MIN;
  const seg = flight.segs.find((s) => t >= s.start - EPS && t < s.start + s.min - EPS) || flight.segs[flight.segs.length - 1];
  return { phase: seg ? seg.phase : 'cruise', gph: rateAt(flight.segs, t) };
}

export function rateAtMs(flight, ms) { return phaseAt(flight, ms).gph; }

export function estimate(flight, cfg, T) {
  const ids = cfg.tanks.map((x) => x.id);
  const lv = { ...flight.startLevels };
  let active = flight.startTank;
  let used = 0;
  let sinceCheck = Object.fromEntries(ids.map((i) => [i, 0]));
  const evs = (flight.events || []).filter((e) => e.at <= T && e.at >= flight.engineStart).sort((a, b) => a.at - b.at || (a.type === 'switch' ? -1 : 1));
  const segBreaks = flight.segs.map((s) => flight.engineStart + s.start * MS_MIN).concat(flight.segs.map((s) => flight.engineStart + (s.start + s.min) * MS_MIN));
  const untils = evs.filter((e) => e.until).map((e) => e.until);
  const points = [...new Set([flight.engineStart, T, takeoffMs(flight), ...evs.map((e) => e.at), ...untils, ...segBreaks])].filter((x) => x >= flight.engineStart && x <= T).sort((a, b) => a - b);
  let ei = 0;
  for (let p = 0; p < points.length; p++) {
    const a = points[p];
    while (ei < evs.length && evs[ei].at <= a) {
      const e = evs[ei++];
      if (e.type === 'switch') active = e.tank;
      else if (e.type === 'check' && e.used >= 0) {
        const delta = e.used - used;
        const tot = Object.values(sinceCheck).reduce((x, y) => x + y, 0);
        if (tot > EPS) for (const id of ids) lv[id] -= (delta * sinceCheck[id]) / tot;
        else lv[active] -= delta;
        used = e.used;
        sinceCheck = Object.fromEntries(ids.map((i) => [i, 0]));
      }
    }
    if (p === points.length - 1) break;
    const b = points[p + 1];
    const burn = (rateAtMs(flight, a) * (b - a)) / 3.6e6;
    lv[active] -= burn;
    sinceCheck[active] += burn;
    used += burn;
  }
  const total = ids.reduce((x, i) => x + lv[i], 0);
  return { levels: lv, active, used, total, rate: rateAtMs(flight, T), phase: phaseAt(flight, T) };
}

// Remaining-flight timeline from a point in time, honoring an ETE update and any climb in progress.
export function remainingSegs(flight, fromMs) {
  const etes = (flight.events || []).filter((e) => e.type === 'ete' && e.at <= fromMs).sort((a, b) => a.at - b.at);
  const last = etes[etes.length - 1];
  const nowMin = (fromMs - flight.engineStart) / MS_MIN;
  const planEnd = flight.segs.reduce((a, s) => Math.max(a, s.start + s.min), 0);
  const endMin = Math.max(nowMin, last ? (last.at - flight.engineStart) / MS_MIN + last.eteMin : planEnd);
  const climbing = activeClimb(flight, fromMs);
  const hasClimbEvents = (flight.events || []).some((e) => e.type === 'climb' && e.at <= fromMs);
  if (!last && !climbing && !hasClimbEvents) return { segs: flight.segs, startMin: nowMin, endMin };
  const cruise = cruiseRateAt(flight, fromMs);
  const segs = [];
  let t = nowMin;
  if (climbing) {
    const climbEnd = climbing.until || climbing.at + (flight.climbMin || 10) * MS_MIN;
    const cEnd = Math.min(endMin, Math.max(nowMin, (climbEnd - flight.engineStart) / MS_MIN));
    if (cEnd > t) { segs.push({ phase: 'climb', start: t, min: cEnd - t, gph: climbing.gph }); t = cEnd; }
  }
  segs.push({ phase: 'cruise', start: t, min: Math.max(0, endMin - t), gph: cruise });
  return { segs, startMin: nowMin, endMin };
}

// ---- time helpers --------------------------------------------------------
export function parseDur(str) {
  if (str === null || str === undefined) return NaN;
  const s = String(str).trim().toLowerCase();
  if (!s) return NaN;
  let m = s.match(/^(\d+)\s*[:h]\s*(\d{1,2})\s*m?$/);
  if (m) return +m[1] * 60 + +m[2];
  m = s.match(/^(\d+)\s*h$/);
  if (m) return +m[1] * 60;
  m = s.match(/^(\d+(?:\.\d+)?)\s*m?$/);
  if (m) return +m[1];
  return NaN;
}

export function fmtDur(min) {
  if (!isFinite(min)) return '—';
  const neg = min < 0;
  const m = Math.round(Math.abs(min));
  return `${neg ? '-' : ''}${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

// Parse "15:48" / "1548" as local time nearest to refMs (within ±12h).
export function parseClock(str, refMs) {
  const s = String(str || '').trim();
  const m = s.match(/^(\d{1,2}):?(\d{2})$/);
  if (!m) return NaN;
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return NaN;
  const d = new Date(refMs);
  d.setHours(h, mi, 0, 0);
  let t = d.getTime();
  const day = 864e5;
  while (t - refMs > day / 2) t -= day;
  while (refMs - t > day / 2) t += day;
  return t;
}

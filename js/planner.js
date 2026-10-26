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
  deepMerge(cfg, { burn: ov.burn, rules: ov.rules, alerts: ov.alerts, landing: ov.landing, idleHours: ov.idleHours });
  if (ov.capacities) for (const t of cfg.tanks) if (ov.capacities[t.id] > 0) t.capacity = +ov.capacities[t.id];
  if (ov.tabs) for (const t of cfg.tanks) if (ov.tabs[t.id] > 0) t.tabGal = +ov.tabs[t.id];
  if (!cfg.fillOrder) cfg.fillOrder = cfg.tanks.map((t) => t.id);
  if (flightOverrides) deepMerge(cfg, flightOverrides);
  return cfg;
}

export function tankMap(cfg) { return Object.fromEntries(cfg.tanks.map((t) => [t.id, t])); }

// Selector BOTH (types with cfg.both, e.g. Cessna high-wings): one selector position fed from
// several tanks at once. It is not a tank: levels never hold a BOTH key, and burn is split.
export const BOTH = 'BOTH';
export const tanksOf = (cfg, id) => (id === BOTH && cfg.both ? cfg.both : [id]);
// What the pilot can select: the tanks, plus Both (between the left and right tanks) when the type has it.
export function selectable(cfg) {
  if (!cfg.both) return cfg.tanks;
  const left = cfg.tanks.filter((t) => t.side === 'L');
  return [...left, { id: BOTH, name: 'Both', side: 'C', spot: 'center', capacity: cfg.both.reduce((a, id) => a + tankMap(cfg)[id].capacity, 0), takeoffLanding: true, both: true }, ...cfg.tanks.filter((t) => t.side !== 'L')];
}
export const feedLevel = (cfg, levels, id) => tanksOf(cfg, id).reduce((a, k) => a + (levels[k] ?? 0), 0);
// Split a burn over the tanks a selector position feeds from: equal shares, and with `cap` a tank
// that runs dry passes the rest of its share to the others. Returns { tankId: gal }.
export function splitBurn(cfg, lv, id, fuel, cap = false) {
  const ks = tanksOf(cfg, id);
  if (ks.length === 1) return { [id]: cap ? Math.min(fuel, Math.max(0, lv[id] ?? 0)) : fuel };
  const out = Object.fromEntries(ks.map((k) => [k, 0]));
  if (!cap) { for (const k of ks) out[k] = fuel / ks.length; return out; }
  let left = fuel, open = ks.filter((k) => lv[k] > EPS);
  while (left > EPS && open.length) {
    const share = left / open.length;
    for (const k of open) { const take = Math.min(share, lv[k] - out[k]); out[k] += take; left -= take; }
    open = open.filter((k) => lv[k] - out[k] > EPS);
  }
  return out;
}
const applyBurn = (lv, parts, sign = 1) => { for (const k in parts) lv[k] -= sign * parts[k]; };

export function reserveGal(cfg) {
  const r = cfg.rules.reserve;
  if (!r || r.mode === 'off') return 0;
  const gph = r.rate === 'custom' ? +r.customGph || 0 : cfg.burn.cruise; // 'cruise' (and older 'base') use the cruise burn
  return (r.min / 60) * gph;
}

export function reserveGph(cfg) {
  const r = cfg.rules.reserve;
  return r.rate === 'custom' ? +r.customGph || cfg.burn.cruise : cfg.burn.cruise;
}

// ---- burn timeline -------------------------------------------------------
// Segments are in minutes from engine start. ForeFlight total fuel includes taxi.
// climbMin / climbGph / cruiseGph override the aircraft profile for this flight.
// With no cruise override, cruise is derived so the total matches ForeFlight.
const given = (v) => v !== null && v !== undefined && v !== '' && isFinite(v) && +v >= 0;
export function buildTimeline(cfg, { taxiMin = 0, eteMin = 0, totalFuel = 0, climbMin: cm, climbGph: cg, cruiseGph: cr, descentMin: dm, descentGph: dg, taxiInMin: tim }) {
  const b = cfg.burn;
  const climbGph = cg > 0 ? cg : b.climbGph;
  const taxiFuel = (taxiMin / 60) * b.ground;
  const climbMin = Math.min(given(cm) ? +cm : b.climbMin || 0, eteMin);
  const climbFuel = (climbMin / 60) * climbGph;
  // Descent ends at landing (inside the ETE); taxi-in comes after landing, at the ground rate.
  const descentMin = Math.min(given(dm) ? +dm : b.descentMin || 0, Math.max(0, eteMin - climbMin));
  const descentGph = dg > 0 ? +dg : b.descentGph || b.cruise;
  const descentFuel = (descentMin / 60) * descentGph;
  const taxiInMin = given(tim) ? +tim : b.taxiInMin || 0;
  const taxiInFuel = (taxiInMin / 60) * b.ground;
  const cruiseMin = Math.max(0, eteMin - climbMin - descentMin);
  let cruiseGph = b.cruise;
  let derived = false;
  let issue = null;
  if (cr > 0) cruiseGph = +cr;
  else if (totalFuel > 0 && cruiseMin > 0) {
    const f = totalFuel - taxiFuel - climbFuel - descentFuel;
    if (f > 0) { cruiseGph = f / (cruiseMin / 60); derived = true; }
    else issue = 'ForeFlight fuel is less than taxi + climb + descent; using the aircraft cruise burn.';
  }
  const segments = [
    { phase: 'taxi', start: 0, min: taxiMin, gph: b.ground },
    { phase: 'climb', start: taxiMin, min: climbMin, gph: climbGph },
    { phase: 'cruise', start: taxiMin + climbMin, min: cruiseMin, gph: cruiseGph },
    { phase: 'descent', start: taxiMin + climbMin + cruiseMin, min: descentMin, gph: descentGph },
    { phase: 'taxi', start: taxiMin + eteMin, min: taxiInMin, gph: b.ground, taxiIn: true }
  ].filter((s) => s.min > 0);
  const total = segments.reduce((a, s) => a + (s.min / 60) * s.gph, 0);
  return { segments, taxiFuel, climbMin, climbGph, climbFuel, cruiseMin, cruiseGph, descentMin, descentGph, descentFuel, taxiInMin, taxiInFuel, derived, issue, blockMin: taxiMin + eteMin + taxiInMin, landMin: taxiMin + eteMin, totalFuel: total, ffTotal: totalFuel };
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
// switchFrom: the tank of a kept (locked) leg that ends at startMin; the new plan starts by switching
// off it (to the other side of its group) instead of continuing on it.
export function generatePlan({ cfg, segs, startMin = 0, endMin, levels, currentTank = null, requiredLanding = 0, parked = [], switchFrom = null }) {
  const tm = tankMap(cfg);
  const ids = cfg.tanks.map((t) => t.id);
  const floor = cfg.rules.floor.gal;
  const live = ids.filter((id) => !parked.includes(id));
  const parkedGal = ids.filter((id) => parked.includes(id)).reduce((a, id) => a + Math.max(0, levels[id]), 0);
  const extra = Math.max(0, requiredLanding - floor * live.length - parkedGal);
  const minLvl = {};
  for (const id of ids) minLvl[id] = parked.includes(id) ? levels[id] : Math.min(levels[id], floor + extra / Math.max(1, live.length));
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

  // Selector BOTH: the plan runs on Both. In flight on a single tank, stay on it only while it is the
  // heavier side (that is what the single tank is for), then go back to Both.
  const both = cfg.both && cfg.both.every((id) => !parked.includes(id)) ? cfg.both : null;
  if (both && rem > EPS) {
    if (currentTank && both.includes(currentTank)) {
      const s = side(currentTank);
      const imb = sideTotal(s) - sideTotal(flip(s));
      const heavy = imb > 1 ? Math.min(rem, usable(currentTank), imb) : 0;
      if (heavy > EPS) { lv[currentTank] -= heavy; rem -= heavy; push(currentTank, heavy); }
    }
    const b = Math.min(rem, Math.min(...both.map(usable)) * both.length);
    if (b > EPS) { for (const id of both) lv[id] -= b / both.length; rem -= b; push(BOTH, b); }
    currentTank = null;
  }

  if (switchFrom && !both) currentTank = switchFrom;
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
    // If one side of the group is used up (floor, or marked done), don't take the other side below
    // it when a later group can carry that fuel: the group ends even and the later group (tips) burns
    // evenly too, instead of absorbing the difference.
    const later = groups.slice(gi + 1).reduce((a, h) => a + usable(h.left) + usable(h.right), 0);
    const spare = later - Math.max(0, rem - bL - bR);
    if (spare > EPS) {
      const aL = lv[g.left] - bL, aR = lv[g.right] - bR;
      if (bR >= uR - EPS && aL < aR - EPS) bL -= Math.min(aR - aL, spare, bL);
      else if (bL >= uL - EPS && aR < aL - EPS) bR -= Math.min(aL - aR, spare, bR);
    }
    let rL = bL, rR = bR;
    let s;
    if (gi === gStart && currentTank && (currentTank === g.left || currentTank === g.right)) s = currentTank === switchFrom ? flip(side(currentTank)) : side(currentTank);
    else if (gi === 0 && tm[cfg.startTank]) s = side(cfg.startTank);
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
export function checkPlan({ cfg, segs, legs, levels, startMin = 0, endMin, requiredLanding = 0, fromEngineStart = true, parked = [] }) {
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
  const startImb = sideTot('L') - sideTot('R');
  let maxImb = Math.abs(startImb);
  if (legs.length && Math.abs(startImb) > r.imbalance.gal + TOL) add('imbalance', sev(r.imbalance.mode), 0, `Imbalance is ${Math.abs(startImb).toFixed(1)} gal now (limit ${r.imbalance.gal})`);
  let lastGroup = -1;
  legs.forEach((leg, i) => {
    const start = t;
    const fuel = fuelBetween(segs, start, start + leg.min);
    applyBurn(lv, splitBurn(cfg, lv, leg.tank, fuel));
    t = start + leg.min;
    const L = sideTot('L'), R = sideTot('R');
    const imb = L - R;
    maxImb = Math.max(maxImb, Math.abs(imb));
    const flags = [];
    const fed = tanksOf(cfg, leg.tank);
    const dry = fed.find((k) => lv[k] < -TOL), low = fed.find((k) => lv[k] < r.floor.gal - TOL);
    if (dry) { flags.push('empty'); add('empty', 'error', i, `${dry} runs dry`); }
    else if (low) { flags.push('floor'); add('floor', sev(r.floor.mode), i, `${low} below ${r.floor.gal} gal floor`); }
    if (Math.abs(imb) > r.imbalance.gal + TOL) { flags.push('imbalance'); add('imbalance', sev(r.imbalance.mode), i, `Imbalance ${Math.abs(imb).toFixed(1)} gal > ${r.imbalance.gal}`); }
    const gi = groupOf(leg.tank);
    if (gi >= 0 && gi < lastGroup) { flags.push('sequence'); add('sequence', 'warn', i, `${leg.tank} after a later tank group`); }
    if (gi > lastGroup) lastGroup = gi;
    if (i > 0 && i < legs.length - 1 && leg.min < (r.minLegMin || 0)) { flags.push('short'); add('shortleg', 'info', i, `Leg ${i + 1} is ${Math.round(leg.min)} min`); }
    if (fed.some((k) => parked.includes(k)) && leg.min > 0.5) { flags.push('parked'); add('parked', 'warn', i, `${leg.tank} is marked done for this flight`); }
    if (i > 0 && legs[i - 1].tank === leg.tank) { flags.push('dup'); add('dup', 'info', i, `Leg ${i + 1} repeats ${leg.tank}`); }
    rows.push({ ...leg, startMin: start, fuel, after: feedLevel(cfg, lv, leg.tank), levels: { ...lv }, L, R, imb, flags });
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
  if (t < endMin && legs.length) applyBurn(landLv, splitBurn(cfg, landLv, legs[legs.length - 1].tank, fuelBetween(segs, t, endMin)));
  const landing = ids.reduce((a, i) => a + landLv[i], 0);
  if (requiredLanding > 0 && landing < requiredLanding - TOL) add('reserve', sev(r.reserve.mode), legs.length - 1, `Lands with ${landing.toFixed(1)}; reserve needs ${requiredLanding.toFixed(1)}`);
  const landImb = ids.filter((i) => tm[i].side === 'L').reduce((a, i) => a + landLv[i], 0) - ids.filter((i) => tm[i].side === 'R').reduce((a, i) => a + landLv[i], 0);
  if (r.landBalanced && t >= endMin - 0.5 && Math.abs(landImb) > 3) add('landbalance', 'info', legs.length - 1, `Lands ${Math.abs(landImb).toFixed(1)} gal ${landImb > 0 ? 'left' : 'right'} heavy`);
  return { rows, issues, landing, landLevels: landLv, landImb, maxImb, startImb, planEnd: t };
}

// Tanks the pilot has marked done for the rest of the flight (left where they are), as of a time.
export function parkedTanks(flight, atMs = Infinity) {
  const set = new Set();
  for (const e of [...(flight.events || [])].sort((a, b) => a.at - b.at)) {
    if (e.at > atMs) break;
    if (e.type === 'park') set.add(e.tank);
    else if (e.type === 'unpark') set.delete(e.tank);
  }
  return [...set];
}

// ---- in-flight estimation ------------------------------------------------
// flight: { engineStart, takeoff, startLevels, startTank, segs (min from engine start), cruiseGph, climbMin, events[] }
// events: {type:'switch', tank, at} | {type:'check', at, used} | {type:'ete', at, eteMin, fuelToDest, gph}
//         {type:'climb', at, gph, until?} (until = expected/actual level-off) | {type:'level', at}
const takeoffMs = (f) => f.takeoff ?? (f.engineStart + ((f.segs.find((s) => s.phase === 'taxi') || { min: 0 }).min) * MS_MIN);

// Expected length of a climb with no length entered: the flight's initial climb time for the
// climb after takeoff, otherwise the aircraft's mid-flight climb default (5 min if not set).
export function climbLenMin(flight, ev) {
  if (ev && ev.initial) return flight.climbMin ?? flight.cfg?.burn?.climbMin ?? 14;
  return flight.cfg?.burn?.stepClimbMin ?? 5;
}

// Climb, descent, level off and landing entries: the latest one at ms says what the airplane is doing.
const VERT = ['climb', 'descent', 'level', 'landing'];
function lastVertical(flight, ms) {
  const evs = (flight.events || []).filter((e) => e.at <= ms && VERT.includes(e.type)).sort((a, b) => a.at - b.at);
  return evs[evs.length - 1] || null;
}
// The climb in progress at ms, if any.
export function activeClimb(flight, ms) {
  const last = lastVertical(flight, ms);
  if (!last || last.type !== 'climb') return null;
  if (last.until && ms >= last.until) return null;
  return last;
}
// The descent (or descent step) in progress at ms, if any. It lasts until level off, a climb or landing.
export function activeDescent(flight, ms) {
  const last = lastVertical(flight, ms);
  if (!last || last.type !== 'descent') return null;
  if (last.until && ms >= last.until) return null;
  return last;
}
// The recorded landing at or before ms, if any.
export function landingAt(flight, ms = Infinity) {
  const evs = (flight.events || []).filter((e) => e.type === 'landing' && e.at <= ms).sort((a, b) => a.at - b.at);
  return evs[evs.length - 1] || null;
}
export const groundGph = (flight) => flight.cfg?.burn?.ground ?? (flight.segs || []).find((s) => s.phase === 'taxi')?.gph ?? 0;
export const taxiInMinOf = (flight) => flight.taxiInMin ?? (flight.segs || []).filter((s) => s.taxiIn).reduce((a, s) => a + s.min, 0);
export const descentMinOf = (flight) => flight.descentMin ?? 0;
export const descentGphOf = (flight) => flight.descentGph || flight.cfg?.burn?.descentGph || cruiseRateAt(flight, Infinity);

// Latest cruise burn the pilot gave us: a "set cruise burn" entry, a check with a flow, or a gph typed into an ETE update.
// A burn entry with scope 'all' applies to the whole cruise, before and after it was entered; any later
// from-now-on change still takes over from its own time.
function lastEteRate(flight, ms) {
  const evs = (flight.events || []).filter((e) => (e.type === 'ete' || e.type === 'burn' || (e.type === 'check' && e.setsBurn)) && (e.at <= ms || (e.type === 'burn' && e.scope === 'all'))).sort((a, b) => a.at - b.at);
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if ((e.type === 'burn' || (e.type === 'check' && e.setsBurn)) && e.gph > 0) return { at: e.at, gph: e.gph };
    // An ETE update only changes cruise burn when the pilot typed a gph into it. ForeFlight's
    // fuel-to-destination is never turned into a burn rate (older entries that did are ignored).
    if (e.type === 'ete' && e.gph > 0 && (e.gphSet === true || (e.gphSet === undefined && !e.fuelToDest))) return { at: e.at, gph: e.gph };
  }
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
  const land = landingAt(flight, ms);
  if (land) return { phase: 'taxi', gph: groundGph(flight), since: land.at, taxiIn: true };
  const c = activeClimb(flight, ms);
  if (c) return { phase: 'climb', gph: c.gph, since: c.at, until: c.until || null };
  const d = activeDescent(flight, ms);
  if (d) return { phase: 'descent', gph: d.gph, since: d.at, until: d.until || null };
  const hasClimbEvents = (flight.events || []).some((e) => VERT.includes(e.type) && e.at <= ms);
  const e = lastEteRate(flight, ms);
  if (hasClimbEvents) return { phase: 'cruise', gph: cruiseRateAt(flight, ms) };
  const t = (ms - flight.engineStart) / MS_MIN;
  const seg = flight.segs.find((s) => t >= s.start - EPS && t < s.start + s.min - EPS) || flight.segs[flight.segs.length - 1];
  const phase = seg ? seg.phase : 'cruise';
  if (phase === 'cruise' || (e && e.at <= ms && t >= seg.start + seg.min - EPS)) return { phase: 'cruise', gph: e ? e.gph : rateAt(flight.segs, t) };
  return { phase, gph: rateAt(flight.segs, t) };
}

export function rateAtMs(flight, ms) { return phaseAt(flight, ms).gph; }

// Levels at time T0. Burning stops at shutdown or at an assumed landing (freezeAt), and a tank is
// never burned below empty: if the selected tank runs dry the estimate stops and reports \`empty\`.
export function estimate(flight, cfg, T0) {
  const T = Math.min(T0, flight.shutdown || Infinity, flight.freezeAt || Infinity);
  const ids = cfg.tanks.map((x) => x.id);
  let empty = null;
  const lv = { ...flight.startLevels };
  let active = flight.startTank;
  let used = 0;
  let sinceCheck = Object.fromEntries(ids.map((i) => [i, 0]));
  let climbSince = Object.fromEntries(ids.map((i) => [i, 0]));
  const evs = (flight.events || []).filter((e) => e.at <= T && e.at >= flight.engineStart).sort((a, b) => a.at - b.at || (a.type === 'switch' ? -1 : 1));
  const segBreaks = flight.segs.map((s) => flight.engineStart + s.start * MS_MIN).concat(flight.segs.map((s) => flight.engineStart + (s.start + s.min) * MS_MIN));
  const untils = evs.filter((e) => e.until).map((e) => e.until);
  const points = [...new Set([flight.engineStart, T, takeoffMs(flight), ...evs.map((e) => e.at), ...untils, ...segBreaks])].filter((x) => x >= flight.engineStart && x <= T).sort((a, b) => a - b);
  let ei = 0;
  for (let p = 0; p < points.length; p++) {
    const a = points[p];
    while (ei < evs.length && evs[ei].at <= a) {
      const e = evs[ei++];
      if (e.type === 'switch') { active = e.tank; empty = null; }
      else if (e.type === 'check' && e.used >= 0) {
        // The engine monitor is right. Climb is the least certain part of the estimate, so any
        // difference goes first to the tanks used during climb since the last check; only a
        // reduction bigger than that whole climb burn spills over to the rest of the burn.
        let delta = e.used - used;
        const sum = (o) => Object.values(o).reduce((x, y) => x + y, 0);
        const climbTot = sum(climbSince), tot = sum(sinceCheck);
        if (climbTot > EPS) {
          const toClimb = Math.max(delta, -climbTot);
          for (const id of ids) lv[id] -= (toClimb * climbSince[id]) / climbTot;
          delta -= toClimb;
        }
        if (Math.abs(delta) > EPS) {
          if (tot > EPS) for (const id of ids) lv[id] -= (delta * sinceCheck[id]) / tot;
          else applyBurn(lv, splitBurn(cfg, lv, active, delta));
        }
        used = e.used;
        sinceCheck = Object.fromEntries(ids.map((i) => [i, 0]));
        climbSince = Object.fromEntries(ids.map((i) => [i, 0]));
      }
    }
    if (p === points.length - 1) break;
    const b = points[p + 1];
    const rate = rateAtMs(flight, a);
    const want = (rate * (b - a)) / 3.6e6;
    const avail = tanksOf(cfg, active).reduce((x, k) => x + Math.max(0, lv[k]), 0);
    let burn = want;
    if (want > avail + EPS) {
      burn = avail;
      if (!empty) empty = { tank: active, at: rate > 0 ? a + (avail / rate) * 3.6e6 : a };
    }
    const parts = splitBurn(cfg, lv, active, burn, true);
    const climbing = phaseAt(flight, a).phase === 'climb';
    for (const k in parts) { lv[k] -= parts[k]; sinceCheck[k] += parts[k]; if (climbing) climbSince[k] += parts[k]; }
    used += burn;
  }
  const total = ids.reduce((x, i) => x + lv[i], 0);
  return { levels: lv, active, used, total, rate: empty ? 0 : rateAtMs(flight, T), phase: phaseAt(flight, T), empty, frozen: !!flight.freezeAt && T0 > flight.freezeAt && !flight.shutdown, stoppedAt: T < T0 ? T : null };
}

// Phases actually flown between two moments (taxi / climb / cruise), using takeoff, climb and level events.
export function actualPhases(flight, a, b) {
  if (b <= a) return [];
  const evs = flight.events || [];
  const segAbs = flight.segs.flatMap((sg) => [flight.engineStart + sg.start * MS_MIN, flight.engineStart + (sg.start + sg.min) * MS_MIN]);
  const cuts = [a, b, takeoffMs(flight), ...evs.map((e) => e.at), ...evs.filter((e) => e.until).map((e) => e.until), ...segAbs]
    .filter((x) => x >= a && x <= b);
  const pts = [...new Set(cuts)].sort((x, y) => x - y);
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const ph = phaseAt(flight, pts[i]);
    const min = (pts[i + 1] - pts[i]) / MS_MIN;
    const last = out[out.length - 1];
    if (last && last.phase === ph.phase && Math.abs(last.gph - ph.gph) < 1e-6) last.min += min;
    else out.push({ phase: ph.phase, min, gph: ph.gph });
  }
  return out.filter((x) => x.min > 0.05);
}

// Expected landing time from the latest ETE update, otherwise from the plan.
export function arrivalOf(flight) {
  const etes = (flight.events || []).filter((e) => e.type === 'ete').sort((a, b) => a.at - b.at);
  const last = etes[etes.length - 1];
  const land = landingAt(flight);
  if (land) return land.at;
  if (last) return last.at + last.eteMin * MS_MIN;
  const end = flight.segs.reduce((a, s) => Math.max(a, s.start + s.min), 0) - taxiInMinOf(flight);
  return flight.engineStart + end * MS_MIN;
}

// Remaining-flight timeline from a point in time, honoring an ETE update, a climb or descent in
// progress, a recorded landing (taxi-in), and the planned descent and taxi-in at the end.
// landMin is when the airplane lands (minutes from engine start); endMin adds taxi-in.
export function remainingSegs(flight, fromMs) {
  const es = flight.engineStart;
  const etes = (flight.events || []).filter((e) => e.type === 'ete' && e.at <= fromMs).sort((a, b) => a.at - b.at);
  const last = etes[etes.length - 1];
  const nowMin = (fromMs - es) / MS_MIN;
  const taxiIn = taxiInMinOf(flight);
  const planEnd = flight.segs.reduce((a, s) => Math.max(a, s.start + s.min), 0);
  const land = landingAt(flight, fromMs);
  if (land) {
    const landMin = (land.at - es) / MS_MIN;
    const endMin = Math.max(nowMin, landMin + taxiIn);
    return { segs: [{ phase: 'taxi', start: nowMin, min: endMin - nowMin, gph: groundGph(flight), taxiIn: true }], startMin: nowMin, endMin, landMin };
  }
  const planLand = last ? (last.at - es) / MS_MIN + last.eteMin : planEnd - taxiIn;
  const landMin = Math.max(nowMin, planLand);
  const endMin = landMin + taxiIn;
  const climbing = activeClimb(flight, fromMs);
  const descending = activeDescent(flight, fromMs);
  const hasVert = (flight.events || []).some((e) => VERT.includes(e.type) && e.at <= fromMs);
  const hasBurn = (flight.events || []).some((e) => e.type === 'burn' && (e.at <= fromMs || e.scope === 'all'));
  if (!last && !hasVert && !hasBurn) return { segs: flight.segs, startMin: nowMin, endMin: Math.max(nowMin, planEnd), landMin };
  const cruise = cruiseRateAt(flight, fromMs);
  const segs = [];
  let t = nowMin;
  const push = (phase, to, gph, extra = {}) => { if (to - t > EPS) { segs.push({ phase, start: t, min: to - t, gph, ...extra }); t = to; } };
  if (descending) push('descent', landMin, descending.gph);
  else {
    if (climbing) {
      const climbEnd = climbing.until || climbing.at + climbLenMin(flight, climbing) * MS_MIN;
      push('climb', Math.min(landMin, Math.max(nowMin, (climbEnd - es) / MS_MIN)), climbing.gph);
    }
    const tod = Math.max(t, landMin - descentMinOf(flight));
    push('cruise', tod, cruise);
    push('descent', landMin, descentGphOf(flight));
  }
  push('taxi', endMin, groundGph(flight), { taxiIn: true });
  if (!segs.length) segs.push({ phase: 'cruise', start: nowMin, min: 0, gph: cruise });
  return { segs, startMin: nowMin, endMin, landMin };
}

// ---- time helpers --------------------------------------------------------
export function parseDur(str) {
  if (str === null || str === undefined) return NaN;
  const s = String(str).trim().toLowerCase();
  if (!s) return NaN;
  let m = s.match(/^(\d+):(\d{1,2}):(\d{1,2})$/);   // h:mm:ss (flight timer)
  if (m) return +m[1] * 60 + +m[2] + +m[3] / 60;
  m = s.match(/^(\d+)\s*[:h]\s*(\d{1,2})\s*m?$/);
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

// ---- fueling -------------------------------------------------------------
// fueling: { request: 'full' | 'tabs' | 'amounts', amounts: {tank: gal}, startReading, steps: [{tank, reading}],
//            before: {tank: gal} (calculated levels before fueling),
//            mode: 'tanks' (default) | 'total', totalAdded (gal, total mode only),
//            known: {tank: gal} (total mode: the tanks whose own gallons are known, if any) }
// Pump readings are the running total shown on the pump after each tank is done.
// Total mode is for a fill the pilot didn't watch: only the total is known, so there are no
// per-tank pumped/diff figures. Each tank is assumed to have reached its target (or got what was asked).
export function fuelingResult(fueling, tanks) {
  const total = fueling.mode === 'total';
  const pumped = Object.fromEntries(tanks.map((t) => [t.id, 0]));
  let prev = +fueling.startReading || 0;
  const stepGal = [];
  for (const s of total ? [] : fueling.steps || []) {
    const r = +s.reading;
    if (!isFinite(r) || s.reading === '' || s.reading == null) { stepGal.push(null); continue; }
    const g = r - prev;
    stepGal.push(g);
    if (pumped[s.tank] !== undefined) pumped[s.tank] += g;
    prev = r;
  }
  const rows = tanks.map((t) => {
    const before = fueling.before?.[t.id];
    const isMain = t.tabGal > 0;
    let target = null, expected = null, after;
    if (fueling.request === 'full') target = t.capacity;
    else if (fueling.request === 'tabs') target = isMain ? Math.min(t.tabGal, t.capacity) : t.capacity;
    if (target != null) {
      expected = before != null ? Math.max(0, target - before) : null;
      after = target;
    } else {
      expected = +fueling.amounts?.[t.id] || 0;
      after = before != null ? Math.min(t.capacity, before + (total ? expected : pumped[t.id])) : null;
    }
    if (total) {
      const k = fueling.known?.[t.id];
      const kg = k != null && k !== '' && isFinite(+k) ? +k : null;
      if (kg != null) {
        // This tank's own gallons are known: it gets a per-tank diff like a pump-read tank.
        if (target == null && before != null) after = Math.min(t.capacity, before + kg);
        if (target != null && kg === 0) after = before;
        return { tank: t.id, before, target, expected, pumped: kg, after, filled: kg > 0, diff: expected != null ? kg - expected : null, known: target != null, given: true };
      }
      const filled = target != null ? before == null || before < target : expected > 0;
      if (target != null && !filled) after = before;
      return { tank: t.id, before, target, expected: filled ? expected : 0, pumped: null, after, filled, diff: null, known: target != null, given: false };
    }
    const filled = (fueling.steps || []).some((s) => s.tank === t.id);
    // A tank not filled at all under top-off/tabs keeps what it had (unless it was already at target).
    if (target != null && !filled) after = before != null ? before : null;
    return { tank: t.id, before, target, expected: filled || target == null ? expected : 0, pumped: pumped[t.id], after, filled, diff: filled && expected != null ? pumped[t.id] - expected : null, known: target != null && filled };
  });
  const added = total ? (isFinite(+fueling.totalAdded) ? +fueling.totalAdded : 0) : prev - (+fueling.startReading || 0);
  // Whole-airplane comparison: added minus what the calculated levels said was needed. On top-off/tabs
  // this measures the burn estimate; on specific amounts it only says whether the fueler matched the ask.
  const exp = rows.map((r) => r.expected);
  const expectedTotal = exp.some((x) => x == null) ? null : exp.reduce((a, b) => a + b, 0);
  // Total mode with some tanks known: the rest of the total goes to the other tanks as a group.
  let rest = null;
  if (total && rows.some((r) => r.given)) {
    const others = rows.filter((r) => !r.given);
    const knownGal = rows.filter((r) => r.given).reduce((a, r) => a + r.pumped, 0);
    const oe = others.map((r) => r.expected);
    const expectedRest = oe.some((x) => x == null) ? null : oe.reduce((a, b) => a + b, 0);
    rest = { tanks: others.map((r) => r.tank), knownGal, added: added - knownGal, expected: expectedRest, diff: expectedRest != null && others.length ? added - knownGal - expectedRest : null };
  }
  return { rows, stepGal, total: added, expectedTotal, totalDiff: expectedTotal != null ? added - expectedTotal : null, calibrates: fueling.request !== 'amounts', rest };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_TYPES } from '../js/types.js';
import * as P from '../js/planner.js';

const typeFull = BUILTIN_TYPES[0];
// Older tests pin numbers from the taxi/climb/cruise model: descent and taxi-in off reproduces it exactly.
const type = { ...typeFull, burn: { ...typeFull.burn, descentMin: 0, taxiInMin: 0 } };
const full = { LT: 17, LM: 25, RM: 25, RT: 17 };

function plan(cfg, { taxiMin, eteMin, totalFuel, levels = full }) {
  const tl = P.buildTimeline(cfg, { taxiMin, eteMin, totalFuel });
  const req = P.reserveGal(cfg);
  const g = P.generatePlan({ cfg, segs: tl.segments, startMin: 0, endMin: tl.blockMin, levels, requiredLanding: req });
  const c = P.checkPlan({ cfg, segs: tl.segments, legs: g.legs, levels, startMin: 0, endMin: tl.blockMin, requiredLanding: req });
  return { tl, g, c, req };
}

const show = (r) => r.c.rows.map((x) => `${x.tank} ${P.fmtDur(x.startMin)} ${x.min}m ${x.fuel.toFixed(1)} -> ${x.after.toFixed(1)} imb ${x.imb.toFixed(1)}`).join('\n');

test('timeline derives cruise from ForeFlight total (taxi included)', () => {
  const cfg = P.resolveConfig(type);
  const tl = P.buildTimeline(cfg, { taxiMin: 20, eteMin: 273, totalFuel: 70.9 });
  assert.equal(tl.blockMin, 293);
  assert.ok(Math.abs(tl.cruiseGph - 15.0) < 0.05, tl.cruiseGph);
  assert.ok(Math.abs(tl.totalFuel - 70.9) < 1e-6);
});

test('KVBT-KLUK: longest legs, floors held, shortfall reported', () => {
  const cfg = P.resolveConfig(type);
  const r = plan(cfg, { taxiMin: 20, eteMin: 273, totalFuel: 70.9 });
  console.log(show(r), '\nshort', r.g.short, '\nissues', r.c.issues);
  assert.deepEqual(r.g.legs.map((l) => l.tank), ['LM', 'RM', 'LM', 'LT', 'RT']);
  assert.ok(r.g.short && Math.abs(r.g.short.fuel - 2.9) < 0.35, JSON.stringify(r.g.short));
  for (const row of r.c.rows) assert.ok(row.after >= 4 - P.TOL, `${row.tank} ${row.after}`);
  assert.ok(r.c.maxImb <= 15);
  assert.ok(r.c.issues.some((i) => i.rule === 'reserve' && i.severity === 'error'));
  assert.ok(r.c.issues.some((i) => i.rule === 'coverage'));
});

test('KMDD-KVBT: mains only, finishes on right, balanced', () => {
  const cfg = P.resolveConfig(type);
  const r = plan(cfg, { taxiMin: 20, eteMin: 146, totalFuel: 39 });
  console.log(show(r), '\nissues', r.c.issues);
  assert.ok(r.g.legs.every((l) => l.tank === 'LM' || l.tank === 'RM'));
  assert.equal(r.g.legs[0].tank, 'LM');
  assert.equal(r.g.legs[r.g.legs.length - 1].tank, 'RM');
  assert.equal(r.g.short, null);
  assert.ok(Math.abs(r.c.landImb) < 1, r.c.landImb);
  assert.ok(!r.c.issues.some((i) => i.severity === 'error'), JSON.stringify(r.c.issues));
});

test('bigger reserve than floors is held evenly', () => {
  const cfg = P.resolveConfig(type, { overrides: { rules: { reserve: { min: 90 } } } });
  assert.equal(P.reserveGal(cfg), 22.5); // 90 min at the 15 gph cruise burn
  const r = plan(cfg, { taxiMin: 15, eteMin: 200, totalFuel: 55 });
  console.log(show(r), '\nissues', r.c.issues);
  assert.ok(r.c.landing >= 22.5 - 0.3, r.c.landing);
});

test('user edit that breaks rules is flagged', () => {
  const cfg = P.resolveConfig(type);
  const tl = P.buildTimeline(cfg, { taxiMin: 20, eteMin: 146, totalFuel: 39 });
  const legs = [{ tank: 'LM', min: 140 }, { tank: 'RM', min: 26 }];
  const c = P.checkPlan({ cfg, segs: tl.segments, legs, levels: full, endMin: tl.blockMin, requiredLanding: 16 });
  assert.ok(c.issues.some((i) => i.rule === 'empty' || i.rule === 'floor'));
  assert.ok(c.issues.some((i) => i.rule === 'imbalance'));
});

test('estimate: switches, check correction, ETE update rate', () => {
  const cfg = P.resolveConfig(type);
  const tl = P.buildTimeline(cfg, { taxiMin: 20, eteMin: 146, totalFuel: 39 });
  const t0 = Date.UTC(2026, 9, 23, 18, 40);
  const m = 60000;
  const flight = { engineStart: t0, startLevels: { ...full }, startTank: 'LM', segs: tl.segments, events: [{ type: 'switch', tank: 'RM', at: t0 + 67 * m }] };
  const e = P.estimate(flight, cfg, t0 + 92 * m);
  const lmUsed = P.fuelBetween(tl.segments, 0, 67), rmUsed = P.fuelBetween(tl.segments, 67, 92);
  assert.ok(Math.abs(e.levels.LM - (25 - lmUsed)) < 1e-6, e.levels.LM);
  assert.ok(Math.abs(e.levels.RM - (25 - rmUsed)) < 1e-6, e.levels.RM);
  assert.equal(e.active, 'RM');
  flight.events.push({ type: 'check', at: t0 + 92 * m, used: 21 });
  const e2 = P.estimate(flight, cfg, t0 + 92 * m);
  assert.ok(Math.abs(e2.used - 21) < 1e-6);
  assert.ok(Math.abs(e2.total - 63) < 1e-6, e2.total);
  flight.events.push({ type: 'ete', at: t0 + 92 * m, eteMin: 60, gph: 18, gphSet: true, fuelToDest: 25 });
  const e3 = P.estimate(flight, cfg, t0 + 122 * m);
  assert.ok(Math.abs(e3.total - (63 - 9)) < 1e-6, e3.total);
});

test('rebuild mid-flight from current tank', () => {
  const cfg = P.resolveConfig(type);
  const levels = { LT: 17, LM: 11.3, RM: 8.5, RT: 17 };
  const segs = [{ phase: 'cruise', start: 130, min: 178, gph: 45.1 / (178 / 60) }];
  const g = P.generatePlan({ cfg, segs, startMin: 130, endMin: 308, levels, currentTank: 'RM', requiredLanding: 16 });
  console.log(g.legs, g.short);
  assert.equal(g.legs[0].tank, 'RM');
  assert.ok(g.short && Math.abs(g.short.fuel - 7.3) < 0.05, JSON.stringify(g.short));
});

test('time parsing', () => {
  assert.equal(P.parseDur('4:33'), 273);
  assert.equal(P.parseDur('273'), 273);
  assert.equal(P.parseDur('2h'), 120);
  const ref = new Date(2026, 9, 23, 23, 50).getTime();
  const t = P.parseClock('00:10', ref);
  assert.equal(t - ref, 20 * 60000);
});

test('per-flight climb and cruise overrides', () => {
  const cfg = P.resolveConfig(type);
  const tl = P.buildTimeline(cfg, { taxiMin: 20, eteMin: 146, totalFuel: 39, climbMin: 12, climbGph: 22 });
  assert.equal(tl.climbMin, 12);
  assert.ok(Math.abs(tl.climbFuel - 4.4) < 1e-6);
  assert.ok(Math.abs(tl.totalFuel - 39) < 1e-6, 'cruise derived so total matches ForeFlight');
  const tl2 = P.buildTimeline(cfg, { taxiMin: 20, eteMin: 146, totalFuel: 39, climbMin: 12, cruiseGph: 14 });
  assert.equal(tl2.cruiseGph, 14);
  assert.ok(Math.abs(tl2.totalFuel - (1.5 + 4 + (134 / 60) * 14)) < 1e-6);
  // phases of the first leg: LM taxi 20 + climb 12 + cruise to +0:48 (68 min from engine start)
  const ph = P.phasesBetween(tl.segments, 0, 68);
  assert.deepEqual(ph.map((x) => [x.phase, Math.round(x.min)]), [['taxi', 20], ['climb', 12], ['cruise', 36]]);
});

test('actual climbs drive the burn rate, including a mid-flight climb', () => {
  const cfg = P.resolveConfig(type);
  const tl = P.buildTimeline(cfg, { taxiMin: 20, eteMin: 146, totalFuel: 39 });
  const m = 60000, t0 = Date.UTC(2026, 9, 23, 20, 0), to = t0 + 20 * m;
  const f = { engineStart: t0, takeoff: to, startLevels: { ...full, LM: 100 }, startTank: 'LM', segs: tl.segments, cruiseGph: tl.cruiseGph, climbMin: 14,
    events: [{ type: 'climb', at: to, gph: 20, until: to + 12 * m }] };
  assert.equal(P.phaseAt(f, to + 5 * m).phase, 'climb');
  assert.equal(P.phaseAt(f, to + 13 * m).phase, 'cruise');
  const e1 = P.estimate(f, cfg, to + 48 * m);
  const expect = 1.5 + (12 / 60) * 20 + (36 / 60) * tl.cruiseGph;
  assert.ok(Math.abs(e1.used - expect) < 1e-6, `${e1.used} vs ${expect}`);
  // mid-flight climb, still climbing
  f.events.push({ type: 'climb', at: to + 90 * m, gph: 20 });
  assert.equal(P.phaseAt(f, to + 95 * m).phase, 'climb');
  const rs = P.remainingSegs(f, to + 92 * m);
  assert.equal(rs.segs[0].phase, 'climb');
  assert.equal(Math.round(rs.segs[0].min), 3); // mid-flight climb assumed 5 minutes
  f.events.push({ type: 'level', at: to + 100 * m });
  assert.equal(P.phaseAt(f, to + 101 * m).phase, 'cruise');
  const used = P.estimate(f, cfg, to + 101 * m).used - P.estimate(f, cfg, to + 90 * m).used;
  assert.ok(Math.abs(used - ((10 / 60) * 20 + (1 / 60) * tl.cruiseGph)) < 1e-6, used);
});

test('actual phases split the first LM period into taxi, climb and cruise', () => {
  const cfg = P.resolveConfig(type);
  const tl = P.buildTimeline(cfg, { taxiMin: 20, eteMin: 146, totalFuel: 39, climbMin: 12 });
  const m = 60000, t0 = Date.UTC(2026, 9, 23, 20, 0), to = t0 + 20 * m;
  const f = { engineStart: t0, takeoff: to, startLevels: { ...full }, startTank: 'LM', segs: tl.segments, cruiseGph: tl.cruiseGph, climbMin: 12,
    events: [{ type: 'climb', at: to, gph: 20, until: to + 12 * m }, { type: 'switch', tank: 'RM', at: to + 48 * m }] };
  const ph = P.actualPhases(f, t0, to + 48 * m);
  assert.deepEqual(ph.map((x) => [x.phase, Math.round(x.min), x.gph]), [['taxi', 20, 4.5], ['climb', 12, 20], ['cruise', 36, tl.cruiseGph]]);
  const fuel = ph.reduce((a, x) => a + (x.min / 60) * x.gph, 0);
  assert.ok(Math.abs(fuel - (25 - P.estimate(f, cfg, to + 48 * m).levels.LM)) < 1e-6);
});

test('estimate never burns a tank below empty, and stops at landing/shutdown', () => {
  const cfg = P.resolveConfig(type);
  const tl = P.buildTimeline(cfg, { taxiMin: 20, eteMin: 146, totalFuel: 39 });
  const m = 60000, t0 = Date.UTC(2026, 9, 23, 20, 0);
  const f = { engineStart: t0, takeoff: t0 + 20 * m, startLevels: { LT: 3, LM: 25, RM: 25, RT: 17 }, startTank: 'LT', segs: tl.segments, cruiseGph: tl.cruiseGph, events: [] };
  const e = P.estimate(f, cfg, t0 + 120 * m);
  assert.equal(e.levels.LT, 0);
  assert.ok(e.empty && e.empty.tank === 'LT');
  assert.ok(Math.abs(e.used - 3) < 1e-6, 'only what was in the tank');
  // recording the missed switch resumes burning on the new tank
  f.events.push({ type: 'switch', tank: 'LM', at: e.empty.at });
  const e2 = P.estimate(f, cfg, t0 + 120 * m);
  assert.equal(e2.empty, null);
  assert.ok(e2.levels.LM < 25);
  // freeze at assumed landing
  f.freezeAt = t0 + 90 * m;
  const e3 = P.estimate(f, cfg, t0 + 300 * m), e4 = P.estimate(f, cfg, t0 + 90 * m);
  assert.ok(Math.abs(e3.total - e4.total) < 1e-9);
  assert.ok(e3.frozen);
  delete f.freezeAt; f.shutdown = t0 + 100 * m;
  assert.ok(Math.abs(P.estimate(f, cfg, t0 + 500 * m).total - P.estimate(f, cfg, t0 + 100 * m).total) < 1e-9);
  assert.equal(P.arrivalOf(f), t0 + 166 * m);
});

test('set cruise burn mid-flight changes the cruise rate from then on', () => {
  const cfg = P.resolveConfig(type);
  const tl = P.buildTimeline(cfg, { taxiMin: 20, eteMin: 146, totalFuel: 39 });
  const m = 60000, t0 = Date.UTC(2026, 9, 23, 20, 0), to = t0 + 20 * m;
  const f = { engineStart: t0, takeoff: to, startLevels: { ...full, LM: 100 }, startTank: 'LM', segs: tl.segments, cruiseGph: tl.cruiseGph,
    events: [{ type: 'climb', at: to, gph: 20, until: to + 12 * m }] };
  const before = P.estimate(f, cfg, to + 60 * m).used;
  f.events.push({ type: 'burn', at: to + 60 * m, gph: 13.2 });
  assert.equal(P.phaseAt(f, to + 70 * m).gph, 13.2);
  assert.ok(Math.abs(P.estimate(f, cfg, to + 90 * m).used - before - (30 / 60) * 13.2) < 1e-6);
  assert.equal(P.remainingSegs(f, to + 90 * m).segs.at(-1).gph, 13.2);
  // a later ETE update with fuel overrides it, and a later burn overrides that
  f.events.push({ type: 'ete', at: to + 100 * m, eteMin: 60, gph: 15, gphSet: true });
  assert.equal(P.phaseAt(f, to + 101 * m).gph, 15);
  f.events.push({ type: 'burn', at: to + 110 * m, gph: 14 });
  assert.equal(P.phaseAt(f, to + 111 * m).gph, 14);
  // climbing still uses climb burn
  f.events.push({ type: 'climb', at: to + 120 * m, gph: 21 });
  assert.equal(P.phaseAt(f, to + 121 * m).gph, 21);
});

test('cruise burn for the whole cruise applies retroactively; later point changes still win', () => {
  const cfg = P.resolveConfig(type);
  const tl = P.buildTimeline(cfg, { taxiMin: 20, eteMin: 146, totalFuel: 39 });
  const m = 60000, t0 = Date.UTC(2026, 9, 23, 20, 0), to = t0 + 20 * m;
  const f = { engineStart: t0, takeoff: to, startLevels: { ...full, LM: 100 }, startTank: 'LM', segs: tl.segments, cruiseGph: tl.cruiseGph,
    events: [{ type: 'climb', at: to, gph: 20, until: to + 12 * m }] };
  f.events.push({ type: 'burn', at: to + 60 * m, gph: 13, scope: 'all' });
  assert.equal(P.phaseAt(f, to + 30 * m).gph, 13, 'applies before it was entered');
  assert.equal(P.phaseAt(f, to + 5 * m).gph, 20, 'climb untouched');
  assert.equal(P.phaseAt(f, t0 + 5 * m).gph, 4.5, 'taxi untouched');
  const used = P.estimate(f, cfg, to + 60 * m).used;
  assert.ok(Math.abs(used - (1.5 + 4 + (48 / 60) * 13)) < 1e-6, used);
  f.events.push({ type: 'burn', at: to + 70 * m, gph: 15 });
  assert.equal(P.phaseAt(f, to + 65 * m).gph, 13);
  assert.equal(P.phaseAt(f, to + 75 * m).gph, 15);
  // without climb events, planned climb segment still burns at climb rate
  const g = { ...f, events: [{ type: 'burn', at: to + 60 * m, gph: 13, scope: 'all' }] };
  assert.equal(P.phaseAt(g, to + 5 * m).phase, 'climb');
  assert.equal(P.phaseAt(g, to + 30 * m).gph, 13);
});

test('a GI 275 check puts the difference on the climb first and never changes cruise burn', () => {
  const cfg = P.resolveConfig(type);
  const tl = P.buildTimeline(cfg, { taxiMin: 15, eteMin: 200, totalFuel: 55 });
  const m = 60000, t0 = Date.UTC(2026, 9, 25, 12, 0), to = t0 + 15 * m;
  const base = { engineStart: t0, takeoff: to, startLevels: { ...full }, startTank: 'LM', segs: tl.segments, cruiseGph: tl.cruiseGph };
  // climb on LM (18 min @ 25), switch to RM at +0:40, check at +1:00 says 2 gal less than estimated
  const evs = [{ type: 'climb', at: to, gph: 25, until: to + 18 * m }, { type: 'switch', tank: 'RM', at: to + 40 * m }];
  const f0 = { ...base, events: evs };
  const est = P.estimate(f0, cfg, to + 60 * m);
  const f1 = { ...base, events: [...evs, { type: 'check', at: to + 60 * m, used: est.used - 2, gph: 13 }] };
  const e1 = P.estimate(f1, cfg, to + 60 * m);
  assert.ok(Math.abs(e1.levels.LM - (est.levels.LM + 2)) < 1e-6, 'all 2 gal back on LM (the climb tank)');
  assert.ok(Math.abs(e1.levels.RM - est.levels.RM) < 1e-6, 'RM untouched');
  // the check's fuel flow does not change the cruise rate
  assert.equal(P.phaseAt(f1, to + 70 * m).gph, tl.cruiseGph);
  // a reduction bigger than the whole climb burn spills to the rest
  const climbBurn = 25 * 18 / 60;
  const f2 = { ...base, events: [...evs, { type: 'check', at: to + 60 * m, used: est.used - climbBurn - 3 }] };
  const e2 = P.estimate(f2, cfg, to + 60 * m);
  assert.ok(Math.abs(e2.total - (est.total + climbBurn + 3)) < 1e-6);
  assert.ok(e2.levels.RM > est.levels.RM, 'spill-over reaches RM');
  // a later check with no climb since then splits by burn as before
  const f3 = { ...f1, events: [...f1.events, { type: 'check', at: to + 90 * m, used: P.estimate(f1, cfg, to + 90 * m).used + 1 }] };
  const a = P.estimate(f1, cfg, to + 90 * m), b = P.estimate(f3, cfg, to + 90 * m);
  assert.ok(Math.abs(b.levels.RM - (a.levels.RM - 1)) < 1e-6, 'only RM burned since the last check');
});

test('mid-flight climbs default to the aircraft step-climb length; the initial climb uses the flight climb time', () => {
  const cfg = P.resolveConfig(type);
  assert.equal(cfg.burn.stepClimbMin, 5);
  const tl = P.buildTimeline(cfg, { taxiMin: 15, eteMin: 200, totalFuel: 55, climbMin: 18 });
  const m = 60000, t0 = Date.UTC(2026, 9, 25, 12, 0), to = t0 + 15 * m;
  const f = { engineStart: t0, takeoff: to, startLevels: { ...full }, startTank: 'LM', segs: tl.segments, cruiseGph: tl.cruiseGph, climbMin: 18, cfg,
    events: [{ type: 'climb', at: to, gph: 20, initial: true }] };
  assert.equal(P.climbLenMin(f, f.events[0]), 18);
  assert.equal(Math.round(P.remainingSegs(f, to + 2 * m).segs[0].min), 16);
  f.events.push({ type: 'level', at: to + 18 * m }, { type: 'climb', at: to + 90 * m, gph: 20 });
  assert.equal(P.climbLenMin(f, f.events[2]), 5);
  const rs = P.remainingSegs(f, to + 91 * m);
  assert.equal(rs.segs[0].phase, 'climb');
  assert.equal(Math.round(rs.segs[0].min), 4);
  const g = { ...f, cfg: P.resolveConfig(type, { overrides: { burn: { stepClimbMin: 8 } } }) };
  assert.equal(P.climbLenMin(g, f.events[2]), 8);
});

test('reserve uses the aircraft cruise burn (older base setting maps to it)', () => {
  assert.equal(P.reserveGal(P.resolveConfig(type)), 15);
  assert.equal(P.reserveGal(P.resolveConfig(type, { overrides: { burn: { cruise: 16 } } })), 16);
  assert.equal(P.reserveGal(P.resolveConfig(type, { overrides: { rules: { reserve: { rate: 'base' } } } })), 15);
  assert.equal(P.reserveGal(P.resolveConfig(type, { overrides: { rules: { reserve: { rate: 'custom', customGph: 17 } } } })), 17);
});

test('fueling: per-tank gallons from running pump totals, compared with the calculated leftovers', () => {
  const tanks = [
    { id: 'LT', capacity: 17 }, { id: 'LM', capacity: 25, tabGal: 18 }, { id: 'RM', capacity: 25, tabGal: 18 }, { id: 'RT', capacity: 17 }
  ];
  const before = { LT: 4, LM: 6, RM: 5, RT: 4.5 };
  const steps = [{ tank: 'LT', reading: 13.4 }, { tank: 'RT', reading: 26.0 }, { tank: 'LM', reading: 38.4 }, { tank: 'RM', reading: 51.6 }];
  const r = P.fuelingResult({ request: 'tabs', before, startReading: 0, steps }, tanks);
  const by = Object.fromEntries(r.rows.map((x) => [x.tank, x]));
  assert.ok(Math.abs(by.LT.pumped - 13.4) < 1e-9 && Math.abs(by.RT.pumped - 12.6) < 1e-9);
  assert.ok(Math.abs(by.LM.pumped - 12.4) < 1e-9 && Math.abs(by.RM.pumped - 13.2) < 1e-9);
  assert.equal(by.LM.after, 18); assert.equal(by.LT.after, 17);
  assert.ok(Math.abs(by.LT.diff - 0.4) < 1e-9, 'LT took 0.4 more than calculated');
  assert.ok(Math.abs(by.LM.diff - 0.4) < 1e-9);
  assert.ok(Math.abs(by.RM.diff - 0.2) < 1e-9);
  assert.ok(Math.abs(r.total - 51.6) < 1e-9);
  // specific amounts: after = before + pumped
  const a = P.fuelingResult({ request: 'amounts', amounts: { LM: 10 }, before, startReading: 100, steps: [{ tank: 'LM', reading: 110.3 }] }, tanks);
  const lm = a.rows.find((x) => x.tank === 'LM');
  assert.ok(Math.abs(lm.after - 16.3) < 1e-9); assert.ok(Math.abs(lm.diff - 0.3) < 1e-9);
  assert.equal(a.rows.find((x) => x.tank === 'LT').after, 4);
});

test('a tank marked done is left where it is (screenshot scenario)', () => {
  const cfg = P.resolveConfig(type);
  // ~70 min left at 14.8 gph, on LM, RM pulled at 5.5 calc
  const segs = [{ phase: 'cruise', start: 0, min: 70, gph: 14.8 }];
  const levels = { LT: 17, LM: 8.6, RM: 5.5, RT: 17 };
  const g = P.generatePlan({ cfg, segs, startMin: 0, endMin: 70, levels, currentTank: 'LM', requiredLanding: 15, parked: ['RM'] });
  assert.ok(!g.legs.some((l) => l.tank === 'RM'), JSON.stringify(g.legs));
  const c = P.checkPlan({ cfg, segs, legs: g.legs, levels, startMin: 0, endMin: 70, requiredLanding: 15, fromEngineStart: false, parked: ['RM'] });
  assert.ok(Math.abs(c.landLevels.RM - 5.5) < 1e-6);
  assert.ok(!c.issues.some((i) => i.severity === 'error'), JSON.stringify(c.issues));
  console.log(g.legs.map((l) => `${l.tank} ${l.min.toFixed(0)}m`).join(', '), c.landLevels);
  // user re-adds RM by hand: flagged
  const c2 = P.checkPlan({ cfg, segs, legs: [{ tank: 'RM', min: 10 }, ...g.legs], levels, startMin: 0, endMin: 80, parked: ['RM'] });
  assert.ok(c2.issues.some((i) => i.rule === 'parked'));
  // parkedTanks follows park/unpark events
  const f = { events: [{ type: 'park', tank: 'RM', at: 10 }, { type: 'unpark', tank: 'RM', at: 20 }] };
  assert.deepEqual(P.parkedTanks(f, 15), ['RM']);
  assert.deepEqual(P.parkedTanks(f, 25), []);
});

test('ForeFlight fuel-to-destination on an ETE update never changes cruise burn', () => {
  const cfg = P.resolveConfig(type);
  const tl = P.buildTimeline(cfg, { taxiMin: 15, eteMin: 200, totalFuel: 55 });
  const m = 60000, es = 1e12, to = es + 15 * m;
  const f = { cfg, engineStart: es, takeoff: to, segs: tl.segments, cruiseGph: tl.cruiseGph, climbMin: 14, startLevels: full, startTank: 'LM',
    events: [{ type: 'takeoff', at: to }, { type: 'burn', at: to + 47 * m, gph: 13.7 }, { type: 'ete', at: to + 120 * m, eteMin: 61, fuelToDest: 15.1, gphSet: false }] };
  assert.equal(P.cruiseRateAt(f, to + 130 * m), 13.7);
  // legacy entry saved before the fix (no gphSet) with ForeFlight fuel: ignored too
  f.events[2] = { type: 'ete', at: to + 120 * m, eteMin: 61, fuelToDest: 15.1 };
  assert.equal(P.cruiseRateAt(f, to + 130 * m), 13.7);
});

test('timeline: descent before landing and taxi-in after it', () => {
  const cfg = P.resolveConfig(typeFull);
  const tl = P.buildTimeline(cfg, { taxiMin: 15, eteMin: 180, totalFuel: 50, descentMin: 20, descentGph: 10, taxiInMin: 6 });
  assert.deepEqual(tl.segments.map((x) => x.phase), ['taxi', 'climb', 'cruise', 'descent', 'taxi']);
  assert.equal(tl.blockMin, 15 + 180 + 6);
  assert.equal(tl.landMin, 195);
  const d = tl.segments[3];
  assert.equal(d.start + d.min, 195);
  // cruise is derived after taking out taxi, climb and descent; taxi-in is extra on top of ForeFlight
  const expCruise = (50 - (15 / 60) * 4.5 - (14 / 60) * 20 - (20 / 60) * 10) / ((180 - 14 - 20) / 60);
  assert.ok(Math.abs(tl.cruiseGph - expCruise) < 1e-9);
  assert.ok(Math.abs(tl.totalFuel - (50 + (6 / 60) * 4.5)) < 1e-9);
});

test('stepped descent, level between steps, landing then taxi-in', () => {
  const cfg = P.resolveConfig(typeFull);
  const tl = P.buildTimeline(cfg, { taxiMin: 15, eteMin: 120, totalFuel: 0, cruiseGph: 14, descentMin: 15, descentGph: 11, taxiInMin: 5 });
  const m = 60000, es = Date.UTC(2026, 9, 25, 13, 0), to = es + 15 * m;
  const f = { cfg, engineStart: es, takeoff: to, startLevels: { ...full, LM: 100 }, startTank: 'LM', segs: tl.segments, cruiseGph: 14,
    descentMin: 15, descentGph: 11, taxiInMin: 5, climbMin: 14,
    events: [{ type: 'climb', at: to, gph: 20, until: to + 14 * m, initial: true }] };
  assert.equal(P.arrivalOf(f), to + 120 * m);
  // cruising: remaining is cruise, then the planned descent, then taxi-in
  let rs = P.remainingSegs(f, to + 60 * m);
  assert.deepEqual(rs.segs.map((x) => x.phase), ['cruise', 'descent', 'taxi']);
  assert.equal(rs.landMin, 15 + 120);
  assert.equal(rs.endMin, 15 + 120 + 5);
  assert.ok(Math.abs(rs.segs[1].min - 15) < 1e-9);
  // first step down at 9 gph, level off, second step at 8 gph
  f.events.push({ type: 'descent', at: to + 90 * m, gph: 9 });
  f.events.push({ type: 'level', at: to + 95 * m });
  f.events.push({ type: 'descent', at: to + 105 * m, gph: 8 });
  assert.equal(P.phaseAt(f, to + 92 * m).phase, 'descent');
  assert.equal(P.phaseAt(f, to + 92 * m).gph, 9);
  assert.equal(P.phaseAt(f, to + 100 * m).gph, 14);
  assert.equal(P.phaseAt(f, to + 110 * m).gph, 8);
  rs = P.remainingSegs(f, to + 110 * m);
  assert.deepEqual(rs.segs.map((x) => x.phase), ['descent', 'taxi']);
  assert.equal(rs.segs[0].gph, 8);
  const u0 = P.estimate(f, cfg, to + 90 * m).used;
  const u1 = P.estimate(f, cfg, to + 115 * m).used;
  assert.ok(Math.abs(u1 - u0 - ((5 / 60) * 9 + (10 / 60) * 14 + (10 / 60) * 8)) < 1e-9);
  // landed early: taxi-in at the ground rate, arrival is the landing, plan ends 5 min after it
  f.events.push({ type: 'landing', at: to + 115 * m });
  assert.equal(P.arrivalOf(f), to + 115 * m);
  assert.equal(P.phaseAt(f, to + 117 * m).phase, 'taxi');
  assert.equal(P.phaseAt(f, to + 117 * m).gph, 4.5);
  rs = P.remainingSegs(f, to + 117 * m);
  assert.deepEqual(rs.segs.map((x) => x.phase), ['taxi']);
  assert.equal(rs.endMin, 15 + 115 + 5);
});

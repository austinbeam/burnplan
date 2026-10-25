import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_TYPES } from '../js/types.js';
import * as P from '../js/planner.js';

const type = BUILTIN_TYPES[0];
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
  assert.equal(P.reserveGal(cfg), 24);
  const r = plan(cfg, { taxiMin: 15, eteMin: 200, totalFuel: 55 });
  console.log(show(r), '\nissues', r.c.issues);
  assert.ok(r.c.landing >= 24 - 0.3, r.c.landing);
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
  flight.events.push({ type: 'ete', at: t0 + 92 * m, eteMin: 60, fuelToDest: 18 });
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
  const rs = P.remainingSegs(f, to + 95 * m);
  assert.equal(rs.segs[0].phase, 'climb');
  assert.equal(Math.round(rs.segs[0].min), 9); // assumed 14-minute climb
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
  f.events.push({ type: 'ete', at: to + 100 * m, eteMin: 60, fuelToDest: 15 });
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

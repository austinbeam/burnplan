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

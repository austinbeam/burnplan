// Built-in aircraft types. These ship with the app and are the same for every user.
// Tail numbers (and any per-tail overrides) live only on the user's device.

export const BUILTIN_TYPES = [
  {
    id: 'pa32',
    name: 'Piper PA-32 (mains + tips)',
    builtin: true,
    // Tank order here is left-to-right as drawn on the overhead view.
    tanks: [
      { id: 'LT', name: 'Left tip', side: 'L', spot: 'tip', capacity: 17, takeoffLanding: true },
      { id: 'LM', name: 'Left main', side: 'L', spot: 'inboard', capacity: 25, tabGal: 18, takeoffLanding: true },
      { id: 'RM', name: 'Right main', side: 'R', spot: 'inboard', capacity: 25, tabGal: 18, takeoffLanding: true },
      { id: 'RT', name: 'Right tip', side: 'R', spot: 'tip', capacity: 17, takeoffLanding: true }
    ],
    // Burn order: groups are used in this order; within a group the planner toggles left/right.
    groups: [
      { left: 'LM', right: 'RM' },
      { left: 'LT', right: 'RT' }
    ],
    // Fueling: POH order (tips first). tabGal = level when filled to the tabs.
    fillOrder: ['LT', 'RT', 'LM', 'RM'],
    startTank: 'LM',
    finishSide: 'R',
    burn: {
      ground: 4.5,     // gph, taxi incl. run-up
      climbGph: 20,
      climbMin: 14,       // initial climb, per-flight override in Setup
      stepClimbMin: 5,    // expected length of a mid-flight climb when none is entered
      descentMin: 15,     // planned descent before landing, per-flight override in Setup
      descentGph: 11,     // planned descent burn; each recorded descent step can set its own
      taxiInMin: 5,       // taxi after landing, at the ground rate
      cruise: 15       // cruise burn: planning default when ForeFlight fuel is blank, and the reserve rate
    },
    rules: {
      floor: { gal: 4, mode: 'hard' },
      reserve: { min: 60, rate: 'cruise', customGph: 15, mode: 'hard' },
      imbalance: { gal: 15, mode: 'warn' },
      switchMargin: 1,
      minLegMin: 20,
      landBalanced: true
    },
    alerts: { preMin: 2, sound: true, vibrate: true },
    landing: { graceMin: 15 },   // after expected arrival + this, assume landed and stop the burn estimate
    idleHours: 3
  },
  // Common two-tank singles. Values are typical POH figures (see CLAUDE.md, "Built-in types"); each tail can override them.
  twoTank({ id: 'c172s', name: 'Cessna 172S/R', gal: 26.5, both: true, ground: 2.5, climbGph: 11, climbMin: 12, cruise: 8.5, descentGph: 6, imbalance: 10 }),
  twoTank({ id: 'c172n', name: 'Cessna 172M/N/P (standard tanks)', gal: 20, both: true, ground: 2, climbGph: 9, climbMin: 12, cruise: 7.5, descentGph: 5, imbalance: 8 }),
  twoTank({ id: 'c182t', name: 'Cessna 182S/T', gal: 43.5, both: true, ground: 3.5, climbGph: 16, climbMin: 12, cruise: 13, descentGph: 9, imbalance: 10 }),
  twoTank({ id: 'c206h', name: 'Cessna 206H / T206H', gal: 43.5, both: true, ground: 4.5, climbGph: 24, climbMin: 15, cruise: 16, descentGph: 11, imbalance: 10 }),
  twoTank({ id: 'c210', name: 'Cessna 210 / T210', gal: 44.5, ground: 4.5, climbGph: 24, climbMin: 15, cruise: 15.5, descentGph: 11, imbalance: 10 }),
  twoTank({ id: 'pa28-161', name: 'Piper PA-28-161 Warrior II/III', gal: 24, tabs: 17, ground: 2, climbGph: 9.5, climbMin: 12, cruise: 8.5, descentGph: 6, imbalance: 8 }),
  twoTank({ id: 'pa28-181', name: 'Piper PA-28-181 Archer II/III', gal: 24, tabs: 17, ground: 2.5, climbGph: 11, climbMin: 12, cruise: 9.5, descentGph: 6.5, imbalance: 8 }),
  twoTank({ id: 'pa28r-201', name: 'Piper PA-28R-201 Arrow III/IV', gal: 36, tabs: 25, ground: 3, climbGph: 14, climbMin: 12, cruise: 10.5, descentGph: 7, imbalance: 10 }),
  twoTank({ id: 'pa32-301', name: 'Piper PA-32-301 / PA-32R-301 Saratoga', gal: 51, tabs: 35, ground: 4.5, climbGph: 20, climbMin: 14, cruise: 15, descentGph: 11, imbalance: 10 }),
  twoTank({ id: 'be36', name: 'Beech A36 Bonanza (74 gal)', gal: 37, tabs: 27, ground: 4.5, climbGph: 23, climbMin: 14, cruise: 15, descentGph: 11, imbalance: 10 }),
  twoTank({ id: 'sr22', name: 'Cirrus SR22 (G3 and later)', gal: 46, ground: 4.5, climbGph: 26, climbMin: 12, cruise: 16.5, descentGph: 11, imbalance: 10 }),
  twoTank({ id: 'm20j', name: 'Mooney M20J 201', gal: 32, ground: 2.5, climbGph: 13, climbMin: 12, cruise: 10, descentGph: 7, imbalance: 8 })
];

// A left/right two-tank single. With `both`, the selector has a BOTH position: the POH wants it for
// takeoff and landing, so plans run on Both (tank id 'BOTH', fed from L and R equally) and L or R
// alone is only for cruise.
function twoTank({ id, name, gal, tabs, both = false, ground, climbGph, climbMin, cruise, descentGph, imbalance }) {
  const tank = (side) => ({ id: side, name: side === 'L' ? 'Left' : 'Right', side, spot: 'inboard', capacity: gal, ...(tabs ? { tabGal: tabs } : {}), takeoffLanding: !both });
  return {
    id,
    name,
    builtin: true,
    tanks: [tank('L'), tank('R')],
    groups: [{ left: 'L', right: 'R' }],
    ...(both ? { both: ['L', 'R'] } : {}),
    fillOrder: ['L', 'R'],
    startTank: both ? 'BOTH' : 'L',
    finishSide: null,
    burn: { ground, climbGph, climbMin, stepClimbMin: 5, descentMin: 15, descentGph, taxiInMin: 5, cruise },
    rules: {
      floor: { gal: 4, mode: 'hard' },
      reserve: { min: 60, rate: 'cruise', customGph: cruise, mode: 'hard' },
      imbalance: { gal: imbalance, mode: 'warn' },
      switchMargin: 1,
      minLegMin: 30,
      landBalanced: true
    },
    alerts: { preMin: 2, sound: true, vibrate: true },
    landing: { graceMin: 15 },
    idleHours: 3
  };
}

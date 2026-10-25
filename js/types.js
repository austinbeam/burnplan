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
  }
];

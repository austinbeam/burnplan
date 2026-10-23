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
      { id: 'LM', name: 'Left main', side: 'L', spot: 'inboard', capacity: 25, takeoffLanding: true },
      { id: 'RM', name: 'Right main', side: 'R', spot: 'inboard', capacity: 25, takeoffLanding: true },
      { id: 'RT', name: 'Right tip', side: 'R', spot: 'tip', capacity: 17, takeoffLanding: true }
    ],
    // Burn order: groups are used in this order; within a group the planner toggles left/right.
    groups: [
      { left: 'LM', right: 'RM' },
      { left: 'LT', right: 'RT' }
    ],
    startTank: 'LM',
    finishSide: 'R',
    burn: {
      ground: 4.5,     // gph, taxi incl. run-up
      climbGph: 20,
      climbMin: 14,
      cruise: 15,      // typical cruise, used when ForeFlight fuel is blank
      base: 16         // conservative base cruise, used for reserves
    },
    rules: {
      floor: { gal: 4, mode: 'hard' },
      reserve: { min: 60, rate: 'base', customGph: 16, mode: 'hard' },
      imbalance: { gal: 15, mode: 'warn' },
      switchMargin: 1,
      minLegMin: 20,
      landBalanced: true
    },
    alerts: { preMin: 2, sound: true, vibrate: true },
    idleHours: 3
  }
];

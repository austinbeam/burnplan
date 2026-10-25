# Burnplan

Fuel tank switching planner and in-flight tracker. Built for Austin's Piper PA-32 (4 tanks: LT 17, LM 25, RM 25, RT 17 usable gal), and usable by anyone. The app is live at https://austinbeam.github.io/burnplan/. Austin mostly uses it on Android, in flight, often one-handed. Keep it fast to tap and readable at a glance.

## Stack and layout

- Vanilla JS ES modules with no build step and no dependencies. It is an offline-first PWA.
- `index.html`, `app.css`, `manifest.webmanifest`, `sw.js`, `icons/`
- `js/types.js`: the built-in aircraft types (`BUILTIN_TYPES`), shared by every user. See "Built-in types" below.
- `js/planner.js`: pure logic, no DOM. Covers timeline, plan generation, rule checks, in-flight estimation, phases and fueling math. Unit tested.
- `js/store.js`: localStorage under the key `burnplan.v1`. Also handles backup import and merge.
- `js/app.js`: all UI (views, sheets, actions, field handlers, alerts, ticker). It is large; grep for `function viewX` / `function sheetX` / action names.
- `test/planner.test.mjs` (node --test) and `test/ui/*.py` (Playwright click-throughs).
- `README.md` is also the in-app **Guide** (`#guide`, linked from the Plan/setup header). `js/guide.js` renders a small Markdown subset (headings, lists, tables, code, bold/italic, links, images) and stops at `## For developers`. The README, `js/guide.js` and `docs/img/*.png` are in the service worker's `FILES` and the Pages staging step, so the guide works offline. Keep README Markdown inside that subset, and keep user-facing sections above `## For developers`.
- `docs/shots.py` regenerates the README screenshots from sample data (tail `N12345`, KAAA → KBBB). Rerun it when a pictured screen changes.

**User data never leaves the device.** No server, no analytics. Export and import of JSON files is the only way data moves.

**This repo is public: no real tail numbers or personal identifiers anywhere.** That covers code, tests, fixtures, comments, docs, screenshots and commit messages. Use the sample tail `N12345` in tests and docs. Never write Austin's actual registration. If one slips in, scrub it from history too (`git filter-repo --replace-text` plus a force-push), not just from the tip.

## Deploying

Push to `main`. The GitHub Actions workflow (`.github/workflows/pages.yml`) runs the planner tests, stamps `__BUILD__` in app.js with the sha and time, appends the sha to the service worker cache name, and deploys to Pages.

On every user-visible change, bump **both** `APP_VERSION` in `js/app.js` and `VERSION` in `sw.js` (for example v31 → v32). Commit, push, then confirm the run with `gh run list -L1`. Austin expects changes to be deployed when they're done. Don't push with failing tests.

## Testing

- Run `test/ui/run.sh` before every deploy. It runs the planner unit tests and every UI script except the slow `landtest`.
- Run `test/ui/run.sh --all` to include `landtest`.
- Run `test/ui/run.sh fueltest donetest` to run just those scripts.
- The UI scripts serve the repo with `python -m http.server` (each on its own port) and drive Chromium with Playwright. Playwright is preinstalled in Claude sessions; don't reinstall it.
- Many scripts print what they observed rather than asserting. A script fails on a Python exception or Playwright timeout, or on a non-empty `ERRORS [...]` line (uncaught page errors).
- When you change behavior on purpose, read the printed output and update the script.
- Screenshots go to `test/ui/shots/` (gitignored); look at them for layout work.
- Add a planner test for any planning or estimation change, and a UI script for new flows.
- Gotcha: the alert bar can cover elements, so use `locator.dispatch_event('click')` instead of `page.click` when that happens.
- Gotcha: some tests use `page.clock.install` / `run_for` to move time.

## Domain rules Austin has set (don't regress these)

### Logged events are never dropped or moved by app logic (hard rule)

- A logged entry (switch, check, climb, anything in `f.events`) disappears only when the pilot deletes it, or by Undo start / Reactivate, which say so and ask first. Its time changes only by a manual edit. Rebuilds, plan versions, settings changes, migrations, updates and merges may never remove an entry or change its `at`. A rebuild can change the fuel burned over that time, never the logged time.
- Why: on 2026-10-25 a logged switch vanished from an active flight. A second open copy of the app (installed app plus a browser tab, or two tabs) still held the log from before the switch and overwrote it when it saved; a new version loading makes every open copy save.
- How it's enforced (`js/store.js`): every entry gets a stable `id` (`ensureIds`). `S.save` checks `rev`; if another copy saved meanwhile it merges (`reconcile`): entries, flights and fuelings that copy added are kept, and only tombstoned removals stay removed. Every deliberate removal must tombstone: `removedEvent(f, e)` for entries (`f.removedEvents`), `state.deletedFlights` / `state.deletedFuelings` for those. Copies also reload on the `storage` event and when brought to the front (`syncFromStorage`).
- Edit and delete find the entry by id (`ui.sd.eid`), never by a stored array index, and confirm callbacks look the flight up again, since `state` can be replaced while a sheet is open.
- Importing a flight file or backup that has a flight already on the phone adds its missing entries (a recovery path) and never removes any.
- `test/ui/staletest.py` and the store tests in `test/planner.test.mjs` cover this. Any new code path that removes entries needs a tombstone and a test.

### Planning

- Don't plan any tank below the floor (4 gal by default, a hard rule). "Ever is a strong word": this applies to planning, and the plan is still allowed to be overridden.
- Burn the sides evenly and keep the imbalance under the limit (15 gal, a warning). Sequence: LM → RM (toggling as needed), then LT/RT. Finish on the right side and land balanced. Make legs as long as possible.
- A flight snapshots its config (`f.cfg`) when built. The one exception: changing a tail's floor (gal or mode) in Settings updates that tail's current draft or active flight's `f.cfg` floor (`applyFloorToFlight`). Austin's rule: this must **not** create a plan version by itself. The current plan is just checked (flagged) against the new floor, and the next rebuild (manual or automatic) uses it. Closed flights keep their floor.
- Within a tank group, if one side is used up (floor, or marked done), the other side stops at that level when a later group can carry the fuel, so the tips end even instead of absorbing the difference. Only when the later groups can't cover it does it go down to the floor.
- The user can edit the plan freely, and broken rules are flagged rather than blocked. A leg can be edited by tank, minutes, or target level after it (**After**; minutes are calculated with `timeForFuel`). Tapping a leg's number keeps legs 1..N and regenerates the rest (`rebuildAfterLeg`, `generatePlan({ switchFrom })`, which starts on the other side of the kept tank's group). Planning changes and actual events are kept separate. Every plan change is versioned (`setPlan(f, plan, reason)` archives the old one).
- All four tanks are approved for takeoff and landing on this airplane; this is configurable per type.
- Rules and tanks are configurable per type and per tail (tail overrides). Custom types are possible.

### Built-in types

- `pa32` is Austin's airplane. Don't change its id or values when touching other types.
- The other built-ins (Cessna 172/182/206H/210, PA-28 Warrior/Archer/Arrow, Saratoga, A36, SR22, M20J) are made by `twoTank()` from typical POH values Austin approved on 2026-10-25. They are typical numbers, not checked against each POH: imbalance limits are conventions (except the SR22's 10 gal), and the Saratoga and A36 tab levels were not verified. Floor is 4 gal hard and reserve 60 min on all of them. Finish side is unset (`finishSide: null`), and the minimum leg is 30 min.
- Adding a tail asks for the cruise gph, prefilled with the type's number. If it differs, it's saved as the tail override `burn.cruise`. This number sets the reserve and is the planning fallback when ForeFlight fuel is blank. It is never applied in flight.
- Settings → Aircraft types has **Request an aircraft type**, which opens a prefilled GitHub issue form. It carries only the app version, never any flight or tail data.

### Selector BOTH

- A type with `both: ['L', 'R']` has a BOTH selector position (the 172, 182 and 206H). The id `P.BOTH` ('BOTH') can be a leg tank, a switch tank or `startTank`. It is never a key in `levels`.
- Burn on Both splits equally (`splitBurn`). In the estimate, if one tank runs dry the other keeps feeding. GI 275 corrections spread over whichever tanks actually burned.
- Plans run on Both. During a rebuild while on a single tank, the plan stays on that tank only while it's the heavier side, then goes back to Both. On these types L and R are `takeoffLanding: false`, so a plan that takes off or lands on a single tank is flagged.
- The UI shows Both only for these types: a BOTH button between the gauges, and BOTH in the tank pickers (`P.selectable(cfg)`). Every other type looks exactly as it did before.

### Logged events are fixed in time

Hard rule: nothing in planning (generate, rebuild, keep-and-rebuild, leg edits, marking a tank done) ever changes the time of a logged event. A rebuild may re-estimate the fuel burned between events, never when they happened. Only a manual history edit in the log moves an event (editing takeoff can also shift the other entries, with its checkbox). `test/ui/keeptest.py` checks this.

### Timeline

The timeline is taxi → climb → cruise → descent → taxi-in.

- ForeFlight ETE is takeoff to landing.
- ForeFlight total fuel includes taxi. Cruise is derived from it (total − taxi − climb − descent) unless the user enters a cruise gph. Taxi-in comes on top.
- Reserve is configurable (default 60 min at the cruise burn). The alternate is optional and off by default.

### In-flight cruise burn

**Never infer cruise burn.** Cruise burn changes only from:

- **Set burn** (from now on, or with a button to cover the whole cruise),
- a **GI 275 check** with a flow typed in, or
- a gph typed into **Update ETE**.

A check's fuel used, and ForeFlight's fuel-to-destination on an ETE update, must never be turned into a burn rate. ForeFlight fuel is shown for comparison only.

**Update ETE sheet:** the ETE and ForeFlight-fuel boxes show, as placeholders, the current ETE left (last ETE update or the plan, minus elapsed) and Burnplan's calculated fuel to landing. A blank ETE saves the current one. A blank fuel box stays blank: Burnplan's own number is never stored as `fuelToDest`. The sheet's "Needs / lands with" uses `remainingSegs` with the new ETE (rest of climb, cruise, descent, taxi-in), the same as the Fly page's destination card.

### GI 275 fuel checks

The engine monitor's "used" figure is treated as correct. The difference goes **to climb first** (the tanks burned during climb since the last check), because climb is the least certain part of the estimate. Only what's left over spreads across the rest of the burn.

### Climb and descent

- The initial climb length comes from setup. A mid-flight climb with no length assumes `burn.stepClimbMin` (5 min).
- Climbs are almost always on a single tank.
- Descent can be stepped. Each **Descend** entry has its own gph, with **Level off** between steps (burn goes back to cruise). **Landed** starts taxi-in at the ground rate.
- Austin often taps Landed after taxi-in. The Landed sheet is prefilled with the expected landing (`P.arrivalOf`: last ETE update or the plan), never earlier than the latest climb/descent/level entry and never later than now, with an **Expected** button to put it back. He corrects it to the timer at touchdown. A backdated landing burns at the ground rate from that time.

### Tanks marked done

A tank marked "done for this flight" (a `park` event) is left where it is. Rebuilds never use it, but it still counts toward balance and landing fuel.

### Flight timer

- Timer entries and displays are **h:mm:ss**, matching the panel timer. Colons are inserted automatically as the user types.
- Settings → Flight timer chooses where the timer reads 0: **At takeoff** (default; Austin's GTX 345 starts at takeoff, and taxi is before +0:00) or **At engine start** (a timer started by hand). A flight keeps the mode it started with.
- An implausible start entry (for example 20:00 typed for 20 minutes) is blocked with a suggested fix.

### Times, alerts and screens

- Times show local time with Zulu in smaller gray text. Each flight has its own time zone.
- Alerts always run on real time, even when the Fly page is showing another moment. The header timer is always live.
- While the Fly page shows another moment, the switch card is written from that moment ("At +0:20: next planned switch", "0:26:07 after +0:20"), never as a real-time "late" countdown. Live countdowns tick only in live view. It uses the plan version that was in force at that moment (`planAt(f, T)`, from `planHistory`), not the current rebuilt plan, and adds the actual recorded switch after that moment ("Actually switched to RM at +0:50:00").
- Landing: an alert at the expected arrival. After a grace period with no input, levels freeze at the assumed landing (or after taxi-in, if a landing was recorded).
- The flight can be ended at a past time, and a closed flight can be reactivated.
- The Fly page plan and the timeline update live every minute. The Plan page has a Whole flight / Remaining toggle with a now-marker based on actual history.

### Fuel tab

- Ground fills: top off (the default), specific amounts, or tips full with mains to tabs (18 gal).
- Record the fill order and the **cumulative** pump reading after each tank; per-tank gallons are calculated from those. The POH fill order is part of the type config (`fillOrder`).
- **Total only** (`mode: 'total'`, `totalAdded`, no `steps`): for a fill Austin didn't watch. Each tank is assumed to reach its target (top-off/tabs) or get what was asked (amounts); there are no per-tank pumped/diff numbers. `fuelingResult` returns `expectedTotal` / `totalDiff` for every fueling (per-tank ones too). On top-off/tabs that diff is shown with its % of the calculated burn of closed flights since the previous fueling, as calibration info only. **It must never change cruise gph, a tail override or any flight, and is never shown as a gph.** Specific-amounts fills don't calibrate (`calibrates: false`).
- A fueling prefills the next flight's starting fuel.
- Gauge readings (in flight and at fueling) are for calibration only and never change any calculation.

## Data model, briefly

A flight (`state.flights[id]`) stores:

- Setup inputs: `eteMin`, `totalFuel`, `taxiMin`, climb, descent and taxi-in values, `startLevels`, and `profileInput` (what the user typed).
- `segs`: the minutes-from-engine-start timeline.
- `cfg`: a snapshot of the resolved config at creation.
- `plan` and `planHistory`.
- `engineStart` and `takeoff` timestamps, `timerFrom`, `tz`, `status` (draft/active/closed), `shutdown`, `freezeAt`.
- `events[]`.

A fueling (`state.fuelings[id]`) stores `tail`, `at`, `tz`, `airport`, `request` (full/tabs/amounts), `amounts`, `before`, `mode` ('tanks' default, or 'total'), `startReading` + `steps` (per tank) or `totalAdded` (total only), gauges and a note. Fuelings are not flight events.

Leg and switch tanks are tank ids, or `BOTH` on types with a BOTH selector (use `P.tanksOf` / `P.feedLevel`, not `levels[tank]`). Event types: `engine`, `takeoff`, `climb` {gph, until, initial}, `level`, `descent` {gph, until?}, `landing`, `switch` {tank, catchup, planned}, `check` {used, gph, setsBurn}, `burn` {gph, scope 'all'?}, `ete` {eteMin, fuelToDest, gph, gphSet, divert, altFuel}, `shutdown`, `reactivate`, `gauge` {readings, note, phase}, `note`, `park` / `unpark` {tank}.

`estimate(flight, cfg, T)` replays the events to get the levels at time T. It never burns a tank below empty, and it stops at shutdown or `freezeAt`. `remainingSegs(flight, T)` builds the rest of the timeline (and returns `landMin`) for rebuilds.

## Working with Austin

- He's a pilot and the primary user, and often reports issues from the cockpit with a screenshot. Fix what he reports, deploy, and reply briefly with what changed.
- He prefers direct answers.
- Ask before big redesigns (offer a mock-up), not before small fixes.
- Commit and push only as part of finishing work he asked for.

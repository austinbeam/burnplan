# Burnplan

Fuel tank switching planner and in-flight tracker for piston aircraft with multiple tanks.

- **Plan**: enter ForeFlight's ETE and total fuel; Burnplan builds a tank-switching plan with the longest legs that keep every tank above its floor, sides within the imbalance limit, and the landing reserve intact.
- **Fly**: record actual switches (with a separate "entered at" time), fuel checks from your engine monitor, and updated ETEs. Tank levels are estimated live and the plan can be rebuilt at any point, including for a fuel stop.
- **Log**: every flight keeps the ForeFlight plan next to what actually happened, so you can see how your planning compares over time.

Works offline once loaded. All flights, tails and settings stay on your device; only aircraft *types* ship with the app (`js/types.js`).

## Install on a phone

Open the site in Chrome, then **⋮ → Add to Home screen / Install app**. Open it once with a connection; after that it runs with no signal.

## Develop

No build step. Serve the folder (`python3 -m http.server`) and open `http://localhost:8000`.

```
node --test test/planner.test.mjs   # planner tests
```

When you change app files, bump `VERSION` in `sw.js` so installed copies pick up the update.

Not an approved fuel management system. Always verify with the aircraft's gauges, engine monitor and POH.

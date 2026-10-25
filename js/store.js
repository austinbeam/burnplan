// Device-local storage. Nothing here ever leaves the phone unless the user exports it.
const KEY = 'burnplan.v1';

export function emptyState() {
  return {
    version: 1,
    tails: {},          // { N12345: { tail, typeId, overrides: {...} } }
    customTypes: {},    // user-made aircraft types
    flights: {},        // { id: flight }
    fuelings: {},       // { id: fueling } ground fill records
    fuelDraft: null,    // fueling in progress
    activeFlightId: null,
    lastInputAt: Date.now(),
    settings: { lastTail: null, lastTaxi: {} },
    rev: 0,             // bumped on every save; tells a copy of the app that another copy wrote since
    deletedFlights: [], // ids deleted on purpose, so a merge never brings them back
    deletedFuelings: []
  };
}

// Every logged entry gets a stable id the first time it's saved. The id comes from the entry itself
// (type, time, entry time, tank), so two copies of the app give an old entry the same id.
export function ensureIds(state) {
  for (const f of Object.values(state.flights || {})) {
    if (!Array.isArray(f.events)) continue;
    const seen = new Set(f.events.map((e) => e.id).filter(Boolean));
    for (const e of f.events) {
      if (e.id) continue;
      const base = `${e.type}-${e.at}-${e.enteredAt ?? ''}-${e.tank ?? ''}`;
      let id = base, n = 1;
      while (seen.has(id)) id = `${base}-${++n}`;
      e.id = id; seen.add(id);
    }
  }
  return state;
}

// Logged events are never dropped by app logic. If another copy of the app (a second tab, or the
// installed app and a browser tab) saved since this copy last loaded or saved, fold its changes in
// instead of overwriting them: entries, flights and fuelings that copy added are kept, and only what
// either copy deleted on purpose (tombstoned) stays deleted. Fields of a flight both copies have
// keep this copy's values; entries are only ever added by the merge.
export function reconcile(mine, theirs) {
  if (!theirs || typeof theirs !== 'object') return mine;
  ensureIds(mine); ensureIds(theirs);
  const union = (a, b) => [...new Set([...(a || []), ...(b || [])])];
  mine.deletedFlights = union(mine.deletedFlights, theirs.deletedFlights);
  mine.deletedFuelings = union(mine.deletedFuelings, theirs.deletedFuelings);
  for (const id of mine.deletedFlights) delete mine.flights[id];
  for (const id of mine.deletedFuelings) if (mine.fuelings) delete mine.fuelings[id];
  for (const [id, tf] of Object.entries(theirs.flights || {})) {
    if (mine.deletedFlights.includes(id)) continue;
    const mf = mine.flights[id];
    if (!mf) { mine.flights[id] = tf; continue; }
    if (!Array.isArray(tf.events)) continue;
    mf.events = mf.events || [];
    mf.removedEvents = union(mf.removedEvents, tf.removedEvents);
    const removed = new Set(mf.removedEvents);
    const have = new Set(mf.events.map((e) => e.id));
    for (const e of tf.events) if (!have.has(e.id) && !removed.has(e.id)) mf.events.push(e);
    mf.events = mf.events.filter((e) => !removed.has(e.id));
    mf.events.sort((a, b) => a.at - b.at);
  }
  for (const [id, x] of Object.entries(theirs.fuelings || {})) {
    if (!mine.fuelings) mine.fuelings = {};
    if (!mine.fuelings[id] && !mine.deletedFuelings.includes(id)) mine.fuelings[id] = x;
  }
  for (const [k, v] of Object.entries(theirs.tails || {})) if (!mine.tails[k]) mine.tails[k] = v;
  for (const [k, v] of Object.entries(theirs.customTypes || {})) if (!mine.customTypes[k]) mine.customTypes[k] = v;
  return mine;
}

export function storedRev() {
  try { const raw = localStorage.getItem(KEY); return raw ? (JSON.parse(raw).rev || 0) : 0; } catch (e) { return 0; }
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyState();
    const s = JSON.parse(raw);
    return ensureIds({ ...emptyState(), ...s, settings: { ...emptyState().settings, ...(s.settings || {}) } });
  } catch (e) {
    return emptyState();
  }
}

// Saves the whole state, first merging in anything another copy of the app saved meanwhile (see reconcile).
// `state` is updated in place, so the caller's copy shows the merged log too.
export function save(state) {
  try {
    ensureIds(state);
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const theirs = JSON.parse(raw);
      if ((theirs.rev || 0) !== (state.rev || 0)) reconcile(state, theirs);
      state.rev = Math.max(theirs.rev || 0, state.rev || 0) + 1;
    } else state.rev = (state.rev || 0) + 1;
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch (e) {
    return false;
  }
}

export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch (e) { /* ignore */ }
  return false;
}

// Merge an imported backup into the current state (never deletes local data).
export function mergeImport(state, data) {
  const out = { ...state };
  if (!data || typeof data !== 'object') throw new Error('Not a Burnplan backup');
  if (data.kind === 'tail' && data.tail) {
    out.tails = { ...out.tails, [data.tail.tail]: data.tail };
    if (data.type && !data.type.builtin) out.customTypes = { ...out.customTypes, [data.type.id]: data.type };
    return { state: out, summary: `Tail ${data.tail.tail}` };
  }
  if (data.kind === 'flight' && data.flight && data.flight.id) {
    const cur = out.flights[data.flight.id];
    if (cur) {
      // Same flight already here: add any entries the file has that this copy is missing; never remove any.
      const merged = reconcile({ flights: { [cur.id]: JSON.parse(JSON.stringify(cur)) }, tails: {}, customTypes: {} }, { flights: { [cur.id]: data.flight } });
      const added = merged.flights[cur.id].events.length - (cur.events || []).length;
      out.flights = { ...out.flights, [cur.id]: merged.flights[cur.id] };
      return { state: out, summary: `${added} missing entr${added === 1 ? 'y' : 'ies'} into ${cur.from || ''} → ${cur.to || ''}` };
    }
    out.flights = { ...out.flights, [data.flight.id]: data.flight };
    out.deletedFlights = (out.deletedFlights || []).filter((id) => id !== data.flight.id);
    if (data.tail && !out.tails[data.tail.tail]) out.tails = { ...out.tails, [data.tail.tail]: data.tail };
    return { state: out, summary: `Flight ${data.flight.from || ''} → ${data.flight.to || ''}` };
  }
  if (data.kind === 'type' && data.type) {
    out.customTypes = { ...out.customTypes, [data.type.id]: { ...data.type, builtin: false } };
    return { state: out, summary: `Type ${data.type.name}` };
  }
  if (data.kind !== 'backup') throw new Error('Not a Burnplan backup');
  const n = { tails: 0, types: 0, flights: 0 };
  for (const [k, v] of Object.entries(data.tails || {})) { out.tails = { ...out.tails, [k]: v }; n.tails++; }
  for (const [k, v] of Object.entries(data.customTypes || {})) { out.customTypes = { ...out.customTypes, [k]: v }; n.types++; }
  for (const [k, v] of Object.entries(data.fuelings || {})) if (!out.fuelings?.[k]) out.fuelings = { ...(out.fuelings || {}), [k]: v };
  let restored = 0;
  for (const [k, v] of Object.entries(data.flights || {})) {
    if (!out.flights[k]) { out.flights = { ...out.flights, [k]: v }; n.flights++; continue; }
    // A flight that's already here gets back any entries it's missing (for example a switch lost to a
    // stale copy of the app). Nothing is removed.
    const cur = out.flights[k];
    const merged = reconcile({ flights: { [k]: JSON.parse(JSON.stringify(cur)) }, tails: {}, customTypes: {} }, { flights: { [k]: v } }).flights[k];
    const added = merged.events.length - (cur.events || []).length;
    if (added > 0) { out.flights = { ...out.flights, [k]: merged }; restored += added; }
  }
  out.deletedFlights = (out.deletedFlights || []).filter((id) => !(data.flights || {})[id]);
  return { state: out, summary: `${n.tails} tails, ${n.types} types, ${n.flights} flights${restored ? `, ${restored} missing entr${restored === 1 ? 'y' : 'ies'} restored` : ''}` };
}

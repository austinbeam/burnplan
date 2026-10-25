// Device-local storage. Nothing here ever leaves the phone unless the user exports it.
const KEY = 'burnplan.v1';

export function emptyState() {
  return {
    version: 1,
    tails: {},          // { N12345: { tail, typeId, overrides: {...} } }
    customTypes: {},    // user-made aircraft types
    flights: {},        // { id: flight }
    activeFlightId: null,
    lastInputAt: Date.now(),
    settings: { lastTail: null, lastTaxi: {} }
  };
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyState();
    const s = JSON.parse(raw);
    return { ...emptyState(), ...s, settings: { ...emptyState().settings, ...(s.settings || {}) } };
  } catch (e) {
    return emptyState();
  }
}

export function save(state) {
  try {
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
    out.flights = { ...out.flights, [data.flight.id]: data.flight };
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
  for (const [k, v] of Object.entries(data.flights || {})) {
    if (!out.flights[k]) { out.flights = { ...out.flights, [k]: v }; n.flights++; }
  }
  return { state: out, summary: `${n.tails} tails, ${n.types} types, ${n.flights} flights` };
}

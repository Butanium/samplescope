// User preferences persisted on the backend so they survive across browsers /
// profiles, with localStorage as a same-browser fast cache so the first paint
// doesn't flicker.
//
// Lifecycle:
//   1. Hook reads localStorage synchronously — no flash of default values.
//   2. `hydrateFromServer()` runs once at app startup: pulls the full prefs
//      map from `/api/prefs`. Server values override localStorage; absent
//      keys leave localStorage untouched so a brand-new browser inherits
//      whatever was on this profile already.
//   3. Setters write localStorage immediately + fire a debounced PUT to the
//      backend, so other browsers pick up the change on their next load.

import { useSyncExternalStore } from "react";

const PREFIX = "viewer.pref.";
const listeners = new Set<() => void>();

// Debounce per-key network writes so a rapid stream of toggles (e.g. many
// folders open/close in one breath) coalesces into a single PUT per key.
const WRITE_DEBOUNCE_MS = 200;
const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();

function notify() {
  listeners.forEach((l) => l());
}

// useSyncExternalStore requires getSnapshot to return a REFERENTIALLY STABLE
// value while the underlying source is unchanged — returning a fresh
// JSON.parse result (or a fresh `fallback`) every call sends React into an
// infinite render loop. Cache by raw string + key so identical reads return
// the same object.
const snapshotCache = new Map<string, { raw: string | null; value: unknown }>();

function readLocal<T>(key: string, fallback: T): T {
  const raw = localStorage.getItem(PREFIX + key);
  const entry = snapshotCache.get(key);
  if (entry && entry.raw === raw) return entry.value as T;
  let value: unknown;
  if (raw == null) {
    value = fallback;
  } else {
    try {
      value = JSON.parse(raw);
    } catch {
      value = fallback;
    }
  }
  snapshotCache.set(key, { raw, value });
  return value as T;
}

function writeLocal<T>(key: string, value: T) {
  localStorage.setItem(PREFIX + key, JSON.stringify(value));
}

function scheduleServerWrite(key: string, value: unknown) {
  const existing = pendingWrites.get(key);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    pendingWrites.delete(key);
    fetch(`/api/prefs/${encodeURIComponent(key)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: JSON.stringify(value) }),
    }).catch(() => {
      // localStorage already holds the value; backend will catch up next attempt.
    });
  }, WRITE_DEBOUNCE_MS);
  pendingWrites.set(key, t);
}

function write<T>(key: string, value: T) {
  writeLocal(key, value);
  scheduleServerWrite(key, value);
  notify();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key && e.key.startsWith(PREFIX)) cb();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

/** A controlled localStorage-backed setting, mirrored to the backend. */
export function usePref<T>(key: string, fallback: T): [T, (next: T) => void] {
  // Same memoized read for client + server snapshots — both must be stable
  // across calls or useSyncExternalStore loops forever.
  const value = useSyncExternalStore(
    subscribe,
    () => readLocal(key, fallback),
    () => readLocal(key, fallback),
  );
  return [value, (next: T) => write(key, next)];
}

/**
 * Pull every persisted pref from the backend and write it into localStorage.
 * Called once at app boot. Server is authoritative on conflict so switching
 * to a different browser picks up the latest tree state.
 */
let hydrated = false;
export async function hydrateFromServer(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const r = await fetch("/api/prefs");
    if (!r.ok) return;
    const map = (await r.json()) as Record<string, string>;
    let changed = false;
    for (const [key, encoded] of Object.entries(map)) {
      const prior = localStorage.getItem(PREFIX + key);
      if (prior !== encoded) {
        localStorage.setItem(PREFIX + key, encoded);
        changed = true;
      }
    }
    if (changed) notify();
  } catch {
    // Offline / backend down — keep using local values.
  }
}

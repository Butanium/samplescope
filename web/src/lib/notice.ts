import { useSyncExternalStore } from "react";

// One transient, app-wide notice ("couldn't open X: …"). Rendered by Layout;
// anything can raise it without threading callbacks through the tree.

let current: { id: number; text: string } | null = null;
let seq = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function showNotice(text: string, ms = 8000): void {
  current = { id: ++seq, text };
  clearTimeout(timer);
  timer = setTimeout(dismissNotice, ms);
  emit();
}

export function dismissNotice(): void {
  current = null;
  clearTimeout(timer);
  emit();
}

export function useNotice() {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => current,
  );
}

/** Report a failed `api.openDataset(path)`. `j` puts the server's `detail` in
 *  the message, which usually names the path already. */
export function noticeOpenFailed(path: string, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  showNotice(msg.includes(path) ? `couldn't open: ${msg}` : `couldn't open ${path}: ${msg}`);
}

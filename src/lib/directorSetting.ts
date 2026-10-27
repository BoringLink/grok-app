/**
 * App-wide Director mode. Off until Settings turns it on.
 * The composer reads this on each send. Session spawn reads the same flag
 * from app settings and attaches it as ACP `_meta.rules`.
 */
import { useSyncExternalStore } from "react";

type Listener = () => void;

let enabled = false;
const listeners = new Set<Listener>();

export function directorSettingEnabled(): boolean {
  return enabled;
}

export function setDirectorSettingEnabled(on: boolean): void {
  if (enabled === on) return;
  enabled = on;
  for (const listener of listeners) listener();
}

/**
 * Optimistic checkbox, then persist. A failed save puts the previous value back.
 */
export async function commitDirectorSetting(
  next: boolean,
  save: (next: boolean) => Promise<void>,
): Promise<void> {
  const prev = enabled;
  setDirectorSettingEnabled(next);
  try {
    await save(next);
  } catch {
    if (enabled === next) setDirectorSettingEnabled(prev);
  }
}

export function subscribeDirectorSetting(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useDirectorSettingEnabled(): boolean {
  return useSyncExternalStore(
    subscribeDirectorSetting,
    directorSettingEnabled,
    directorSettingEnabled,
  );
}

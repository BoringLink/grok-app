import { getCurrentWebview } from "@tauri-apps/api/webview";
import { isMainWindowLabel, isSessionWindowLabel } from "./multiWindow";

export type ZoomHotkeyAction = "in" | "out" | "reset";

/** UI zoom, same localStorage shelf as other window chrome prefs. */
export const UI_ZOOM_STORAGE_KEY = "grok.uiZoom";

export interface UiZoomStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const DEFAULT_ZOOM_LEVEL = 1;
export const ZOOM_STEP = 0.2;
export const MIN_ZOOM_LEVEL = 0.2;
export const MAX_ZOOM_LEVEL = 10;

type ZoomHotkeyEvent = Pick<
  KeyboardEvent,
  "altKey" | "code" | "ctrlKey" | "key" | "metaKey"
>;

export type ZoomHotkeyTarget = Pick<
  Window,
  "addEventListener" | "removeEventListener"
>;

export function zoomHotkeyAction(
  event: ZoomHotkeyEvent,
): ZoomHotkeyAction | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return null;

  if (
    event.key === "-" ||
    event.key === "Subtract" ||
    event.code === "Minus" ||
    event.code === "NumpadSubtract"
  ) {
    return "out";
  }

  if (
    event.key === "=" ||
    event.key === "+" ||
    event.key === "Add" ||
    event.code === "Equal" ||
    event.code === "NumpadAdd"
  ) {
    return "in";
  }

  if (
    event.key === "0" ||
    event.code === "Digit0" ||
    event.code === "Numpad0"
  ) {
    return "reset";
  }

  return null;
}

export function nextZoomLevel(
  current: number,
  action: ZoomHotkeyAction,
): number {
  const next =
    action === "reset"
      ? DEFAULT_ZOOM_LEVEL
      : current + (action === "in" ? ZOOM_STEP : -ZOOM_STEP);
  const clamped = Math.min(Math.max(next, MIN_ZOOM_LEVEL), MAX_ZOOM_LEVEL);
  return Math.round(clamped * 10) / 10;
}

/**
 * Persisted zoom. In-range values snap to the hotkey tenth-grid.
 * NaN, non-numeric, and out-of-range values fall back to 1 (not clamped).
 */
export function parseStoredZoomLevel(raw: unknown): number {
  let n = Number.NaN;
  if (typeof raw === "number") n = raw;
  else if (typeof raw === "string") n = Number(raw.trim());
  if (!Number.isFinite(n)) return DEFAULT_ZOOM_LEVEL;
  if (n < MIN_ZOOM_LEVEL || n > MAX_ZOOM_LEVEL) return DEFAULT_ZOOM_LEVEL;
  const rounded = Math.round(n * 10) / 10;
  if (rounded < MIN_ZOOM_LEVEL || rounded > MAX_ZOOM_LEVEL) {
    return DEFAULT_ZOOM_LEVEL;
  }
  return rounded;
}

function zoomStorage(storage?: UiZoomStorage | null): UiZoomStorage | null {
  if (storage) return storage;
  if (storage === null) return null;
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function loadUiZoomLevel(storage?: UiZoomStorage | null): number {
  try {
    const store = zoomStorage(storage);
    if (!store) return DEFAULT_ZOOM_LEVEL;
    return parseStoredZoomLevel(store.getItem(UI_ZOOM_STORAGE_KEY));
  } catch {
    return DEFAULT_ZOOM_LEVEL;
  }
}

export function saveUiZoomLevel(
  level: number,
  storage?: UiZoomStorage | null,
): void {
  try {
    const store = zoomStorage(storage);
    if (!store) return;
    store.setItem(UI_ZOOM_STORAGE_KEY, String(parseStoredZoomLevel(level)));
  } catch {
    /* private mode / quota */
  }
}

/** Main workbench and `session-*` windows only. Pet / theme editor stay at 1. */
export function shouldRestoreUiZoom(label: string | null | undefined): boolean {
  return isMainWindowLabel(label) || isSessionWindowLabel(label);
}

export function readCurrentWebviewLabel(): string | null {
  try {
    const label = getCurrentWebview().label;
    return typeof label === "string" && label.trim() ? label : null;
  } catch {
    return null;
  }
}

export type InstallZoomHotkeysOptions = {
  storage?: UiZoomStorage | null;
  /**
   * Apply and keep the persisted level. Callers pass this only for the main
   * window and session windows.
   */
  restore?: boolean;
};

export function installZoomHotkeys(
  target: ZoomHotkeyTarget,
  setZoom: (level: number) => Promise<void> | void = (level) =>
    getCurrentWebview().setZoom(level),
  options?: InstallZoomHotkeysOptions,
): () => void {
  const restore = options?.restore === true;
  const storage = options?.storage;
  let zoomLevel = restore ? loadUiZoomLevel(storage) : DEFAULT_ZOOM_LEVEL;

  const applyZoom = (level: number) => {
    try {
      void Promise.resolve(setZoom(level)).catch(() => undefined);
    } catch {
      // Browser previews and older hosts may not expose the Tauri command.
    }
  };

  if (restore && zoomLevel !== DEFAULT_ZOOM_LEVEL) {
    applyZoom(zoomLevel);
  }

  const onKeyDown = (event: KeyboardEvent) => {
    const action = zoomHotkeyAction(event);
    if (!action) return;

    // Run before the app's document-level shortcut handlers and before the
    // Tauri initialization script's bubble listener.
    event.preventDefault();
    event.stopImmediatePropagation();
    zoomLevel = nextZoomLevel(zoomLevel, action);
    if (restore) saveUiZoomLevel(zoomLevel, storage);
    applyZoom(zoomLevel);
  };

  target.addEventListener("keydown", onKeyDown, true);
  return () => target.removeEventListener("keydown", onKeyDown, true);
}

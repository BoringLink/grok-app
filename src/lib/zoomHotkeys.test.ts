import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ZOOM_LEVEL,
  installZoomHotkeys,
  loadUiZoomLevel,
  MAX_ZOOM_LEVEL,
  MIN_ZOOM_LEVEL,
  nextZoomLevel,
  parseStoredZoomLevel,
  saveUiZoomLevel,
  shouldRestoreUiZoom,
  UI_ZOOM_STORAGE_KEY,
  type UiZoomStorage,
  zoomHotkeyAction,
} from "./zoomHotkeys";

function memoryStorage(initial?: Record<string, string>): UiZoomStorage & {
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    setItem(key, value) {
      data[key] = value;
    },
  };
}

function key(
  values: Partial<KeyboardEvent> = {},
): Pick<KeyboardEvent, "altKey" | "code" | "ctrlKey" | "key" | "metaKey"> {
  return {
    altKey: false,
    code: "",
    ctrlKey: false,
    key: "",
    metaKey: false,
    ...values,
  };
}

describe("zoomHotkeys", () => {
  it("recognizes command and control zoom keys including physical key codes", () => {
    expect(zoomHotkeyAction(key({ metaKey: true, code: "Minus", key: "ß" }))).toBe(
      "out",
    );
    expect(zoomHotkeyAction(key({ metaKey: true, code: "Equal", key: "+" }))).toBe(
      "in",
    );
    expect(zoomHotkeyAction(key({ ctrlKey: true, key: "0" }))).toBe("reset");
    expect(zoomHotkeyAction(key({ metaKey: true, altKey: true, key: "=" }))).toBe(
      null,
    );
  });

  it("clamps zoom levels and resets to the default", () => {
    expect(nextZoomLevel(DEFAULT_ZOOM_LEVEL, "in")).toBe(1.2);
    expect(nextZoomLevel(DEFAULT_ZOOM_LEVEL, "out")).toBe(0.8);
    expect(nextZoomLevel(MAX_ZOOM_LEVEL, "in")).toBe(MAX_ZOOM_LEVEL);
    expect(nextZoomLevel(MIN_ZOOM_LEVEL, "out")).toBe(MIN_ZOOM_LEVEL);
    expect(nextZoomLevel(3.4, "reset")).toBe(DEFAULT_ZOOM_LEVEL);
  });

  it("handles the shortcut in capture phase and removes the listener", async () => {
    const listeners = new Map<string, (event: KeyboardEvent) => void>();
    const target = {
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        listeners.set(type, listener as (event: KeyboardEvent) => void);
      }),
      removeEventListener: vi.fn((type: string) => {
        listeners.delete(type);
      }),
    };
    const setZoom = vi.fn().mockResolvedValue(undefined);
    const dispose = installZoomHotkeys(target, setZoom);
    const event = {
      ...key({ metaKey: true, code: "Minus", key: "ß" }),
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    } as unknown as KeyboardEvent;

    listeners.get("keydown")?.(event);
    await Promise.resolve();

    expect(target.addEventListener).toHaveBeenCalledWith(
      "keydown",
      expect.any(Function),
      true,
    );
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(setZoom).toHaveBeenCalledWith(0.8);

    dispose();
    expect(target.removeEventListener).toHaveBeenCalledWith(
      "keydown",
      expect.any(Function),
      true,
    );
  });

  it("round-trips a stored zoom and snaps in-range values to the tenth grid", () => {
    const storage = memoryStorage();
    expect(loadUiZoomLevel(storage)).toBe(DEFAULT_ZOOM_LEVEL);
    saveUiZoomLevel(1.26, storage);
    expect(storage.data[UI_ZOOM_STORAGE_KEY]).toBe("1.3");
    expect(loadUiZoomLevel(storage)).toBe(1.3);
    saveUiZoomLevel(MIN_ZOOM_LEVEL, storage);
    expect(loadUiZoomLevel(storage)).toBe(MIN_ZOOM_LEVEL);
    saveUiZoomLevel(MAX_ZOOM_LEVEL, storage);
    expect(loadUiZoomLevel(storage)).toBe(MAX_ZOOM_LEVEL);
  });

  it("falls back to 1 for NaN and out-of-range stored values", () => {
    expect(parseStoredZoomLevel(Number.NaN)).toBe(1);
    expect(parseStoredZoomLevel(Number.POSITIVE_INFINITY)).toBe(1);
    expect(parseStoredZoomLevel("nope")).toBe(1);
    expect(parseStoredZoomLevel("")).toBe(1);
    expect(parseStoredZoomLevel(null)).toBe(1);
    expect(parseStoredZoomLevel(0)).toBe(1);
    expect(parseStoredZoomLevel(-1)).toBe(1);
    expect(parseStoredZoomLevel(10.4)).toBe(1);
    expect(parseStoredZoomLevel("99")).toBe(1);
    const storage = memoryStorage({ [UI_ZOOM_STORAGE_KEY]: "NaN" });
    expect(loadUiZoomLevel(storage)).toBe(1);
    saveUiZoomLevel(Number.NaN, storage);
    expect(storage.data[UI_ZOOM_STORAGE_KEY]).toBe("1");
  });

  it("restores zoom only for the main window and session windows", () => {
    expect(shouldRestoreUiZoom("main")).toBe(true);
    expect(shouldRestoreUiZoom("session-abc")).toBe(true);
    expect(shouldRestoreUiZoom("pet")).toBe(false);
    expect(shouldRestoreUiZoom("pet-quick")).toBe(false);
    expect(shouldRestoreUiZoom("theme-editor")).toBe(false);
    expect(shouldRestoreUiZoom(null)).toBe(false);
    expect(shouldRestoreUiZoom("")).toBe(false);
  });

  it("applies a stored zoom on install and persists the next step and reset", async () => {
    const listeners = new Map<string, (event: KeyboardEvent) => void>();
    const target = {
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        listeners.set(type, listener as (event: KeyboardEvent) => void);
      }),
      removeEventListener: vi.fn(),
    };
    const storage = memoryStorage({ [UI_ZOOM_STORAGE_KEY]: "1.4" });
    const setZoom = vi.fn().mockResolvedValue(undefined);
    installZoomHotkeys(target, setZoom, { storage, restore: true });
    expect(setZoom).toHaveBeenCalledWith(1.4);

    const zoomIn = {
      ...key({ metaKey: true, code: "Equal", key: "+" }),
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    } as unknown as KeyboardEvent;
    listeners.get("keydown")?.(zoomIn);
    await Promise.resolve();
    expect(setZoom).toHaveBeenLastCalledWith(1.6);
    expect(storage.data[UI_ZOOM_STORAGE_KEY]).toBe("1.6");

    const reset = {
      ...key({ ctrlKey: true, key: "0" }),
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    } as unknown as KeyboardEvent;
    listeners.get("keydown")?.(reset);
    await Promise.resolve();
    expect(setZoom).toHaveBeenLastCalledWith(1);
    expect(storage.data[UI_ZOOM_STORAGE_KEY]).toBe("1");
  });

  it("does not read or write storage when restore is off", async () => {
    const listeners = new Map<string, (event: KeyboardEvent) => void>();
    const target = {
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        listeners.set(type, listener as (event: KeyboardEvent) => void);
      }),
      removeEventListener: vi.fn(),
    };
    const storage = memoryStorage({ [UI_ZOOM_STORAGE_KEY]: "1.8" });
    const setZoom = vi.fn().mockResolvedValue(undefined);
    installZoomHotkeys(target, setZoom, { storage, restore: false });
    expect(setZoom).not.toHaveBeenCalled();

    const zoomOut = {
      ...key({ metaKey: true, code: "Minus", key: "-" }),
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    } as unknown as KeyboardEvent;
    listeners.get("keydown")?.(zoomOut);
    await Promise.resolve();
    expect(setZoom).toHaveBeenCalledWith(0.8);
    expect(storage.data[UI_ZOOM_STORAGE_KEY]).toBe("1.8");
  });

  it("clamps a restored level at the hotkey ceiling", async () => {
    const listeners = new Map<string, (event: KeyboardEvent) => void>();
    const target = {
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        listeners.set(type, listener as (event: KeyboardEvent) => void);
      }),
      removeEventListener: vi.fn(),
    };
    const storage = memoryStorage({ [UI_ZOOM_STORAGE_KEY]: "9.96" });
    const setZoom = vi.fn().mockResolvedValue(undefined);
    installZoomHotkeys(target, setZoom, { storage, restore: true });
    expect(setZoom).toHaveBeenCalledWith(MAX_ZOOM_LEVEL);

    const zoomIn = {
      ...key({ metaKey: true, key: "+" }),
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    } as unknown as KeyboardEvent;
    listeners.get("keydown")?.(zoomIn);
    await Promise.resolve();
    expect(setZoom).toHaveBeenLastCalledWith(MAX_ZOOM_LEVEL);
    expect(storage.data[UI_ZOOM_STORAGE_KEY]).toBe(String(MAX_ZOOM_LEVEL));
  });
});

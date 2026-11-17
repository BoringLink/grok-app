/**
 * After a provider switch the old process is gone, but the UI can still say
 * `ready` until the host event arrives. A send in that gap reuses the dead
 * process. Drop that ready bit so the next send reconnects.
 */
export function liveHostAfterProviderSwitch<
  T extends { sessionId?: string | null; state: string },
>(live: T, sessionId: string | null | undefined, providerChanged: boolean): T | null {
  if (!providerChanged || !sessionId) return null;
  if (live.sessionId !== sessionId || live.state !== "ready") return null;
  return { ...live, state: "disconnected" };
}

/** 仅当写入屏障和当前会话上下文仍匹配时，才应用已解析的偏好快照。 */
export async function resolveComposerPrefsAfterBarrier<T>(opts: {
  barrier: Promise<void>;
  currentBarrier: () => Promise<void>;
  isActive: () => boolean;
  resolve: () => Promise<T>;
  apply: (value: T) => void;
  onError: (error: unknown) => void;
}): Promise<boolean> {
  const isCurrent = () =>
    opts.isActive() && opts.currentBarrier() === opts.barrier;
  try {
    await opts.barrier;
    if (!isCurrent()) return false;
    const value = await opts.resolve();
    if (!isCurrent()) return false;
    opts.apply(value);
    return true;
  } catch (error) {
    if (isCurrent()) {
      opts.onError(error);
    } else {
      console.warn("stale composer prefs resolution failed", error);
    }
    return false;
  }
}

/** Serialize a composer preference write so the next send can await it. */
export function queueComposerPreferenceApply(
  previous: Promise<void>,
  apply: () => Promise<unknown>,
  onError: (error: unknown) => void,
): Promise<void> {
  return previous
    .then(apply, apply)
    .then(() => undefined)
    .catch(onError);
}

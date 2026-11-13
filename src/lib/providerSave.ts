/**
 * Pure helpers for Settings → Account → Custom providers save / live-apply.
 *
 * Host writes agent-home `config.toml` and invalidates only chats that use the
 * edited provider, so their next send reloads base_url / api_key / auth.json.
 */

/**
 * Race a promise against a wall-clock timeout so UI never sticks on “Saving…”.
 * On timeout the underlying work may still complete (host already wrote disk).
 */
export function withProviderSaveTimeout<T>(
  promise: Promise<T>,
  ms: number,
  timeoutMessage = "Provider save timed out",
): Promise<T> {
  const timeoutMs = Number.isFinite(ms) && ms > 0 ? ms : 25_000;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(timeoutMessage));
    }, timeoutMs);
    promise.then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Default wall-clock budget for `providers_upsert` IPC (ms). */
export const PROVIDER_SAVE_TIMEOUT_MS = 25_000;

/** Slug for new provider ids (mirrors host sanitize rules loosely). */
export function slugifyProviderId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

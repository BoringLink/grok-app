/**
 * Model / effort mid-session apply error classification.
 *
 * Product truth (Grok Build / Host):
 * - Model: spawn `--model`; after connect Host best-effort `session/set_model`.
 * - Effort: spawn `--reasoning-effort`; on a live idle agent the Host
 *   hot-applies via standard ACP `session/set_config_option`
 *   (`configId: reasoning_effort`, plain-string value).
 *
 * Both switches are silent async applies — the composer shows no
 * success/footnote banners, only error toasts classified here.
 *
 * Pure helpers — no I/O. UI translates returned message keys via `t()`.
 */

import type { MessageKey } from "@/i18n";

/** Soft-fail kinds for model/effort apply host errors. */
export type ModelEffortErrorKind =
  | "set_model_failed"
  | "invalid_model"
  | "invalid_effort"
  | "other";

/** Message key for a classified model/effort apply error. */
export function modelEffortErrorMessageKey(
  kind: ModelEffortErrorKind,
): MessageKey {
  switch (kind) {
    case "set_model_failed":
      return "composer.apply.error.setModelFailed";
    case "invalid_model":
      return "composer.apply.error.invalidModel";
    case "invalid_effort":
      return "composer.apply.error.invalidEffort";
    case "other":
      return "composer.apply.error.other";
  }
}

/**
 * Classify free-form host / IPC errors from model or effort apply paths.
 * Soft kinds only — never invents success.
 */
export function classifyModelEffortError(err: unknown): ModelEffortErrorKind {
  const s = errText(err).toLowerCase();
  if (!s) return "other";

  if (
    /invalid\s*effort|invalid.*reasoning\s*effort|unknown\s*effort|effort.*invalid|effort.*not advertised/i.test(s)
  ) {
    return "invalid_effort";
  }
  if (
    /model id empty|invalid\s*model|unknown\s*model|model.*not\s*found|not a valid model/i.test(
      s,
    )
  ) {
    return "invalid_model";
  }
  if (
    /session\/set_model|set_model\b|failed to set model|set model failed/i.test(
      s,
    )
  ) {
    return "set_model_failed";
  }
  return "other";
}

function errText(err: unknown): string {
  if (err == null) return "";
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message || String(err);
  if (typeof err === "object" && err !== null && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  try {
    return String(err);
  } catch {
    return "";
  }
}

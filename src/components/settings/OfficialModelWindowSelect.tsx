/**
 * One official model's context-window picker inside Settings → General.
 *
 * The App stores a per-model override; `Default` clears it so the CLI catalog
 * value applies again. Only sizes the catalog advertises are offered.
 */

import { useMemo, useState } from "react";

import { Select } from "@/components/Select";
import { formatTokenCount } from "@/lib/contextUsage";
import type { ModelOption } from "@/lib/grokCatalog";
import type { Locale, MessageKey } from "@/i18n";
import type { AvailableModelsResult } from "@/lib/api";
import * as api from "@/lib/api";
import { positiveContextWindows } from "@/lib/modelWindows";

const DEFAULT_VALUE = "default";

export function OfficialModelWindowSelect({
  model,
  locale,
  t,
  onChanged,
}: {
  model: ModelOption;
  locale: Locale;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  onChanged: (next: AvailableModelsResult) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = useMemo(() => {
    const declared = positiveContextWindows(model.contextWindows) ?? [];
    const current = model.contextWindow;
    const all =
      declared.length > 0
        ? declared
        : current != null && Number.isFinite(current) && current > 0
          ? [Math.floor(current)]
          : [];
    return [
      { value: DEFAULT_VALUE, label: t("settings.availableModelsWindowDefault") },
      ...all.map((window) => ({
        value: String(window),
        label: formatTokenCount(window, locale),
      })),
    ];
  }, [locale, model.contextWindow, model.contextWindows, t]);

  const value =
    model.contextWindowSource === "user" &&
    model.contextWindow != null &&
    options.some((option) => option.value === String(model.contextWindow))
      ? String(model.contextWindow)
      : DEFAULT_VALUE;

  const change = async (next: string) => {
    if (busy || !api.isTauri()) return;
    const tokens =
      next === DEFAULT_VALUE ? null : Number.parseInt(next, 10);
    if (tokens != null && (!Number.isSafeInteger(tokens) || tokens <= 0)) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.modelsSetOfficialContextWindow(model.id, tokens);
      onChanged(result);
    } catch (caught) {
      setError(String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-models-list__window">
      <span className="settings-models-list__badge">
        {model.contextWindowSource === "user"
          ? t("settings.availableModelsWindowUser")
          : t("settings.availableModelsWindowCatalog")}
      </span>
      <div className="settings-models-list__window-control">
        <Select
          value={value}
          options={options}
          disabled={busy}
          aria-label={`${model.label} ${t("settings.availableModelsWindow")}`}
          onChange={(next) => {
            void change(next);
          }}
        />
        {error ? (
          <span className="settings-models-list__error" role="alert">
            {t("settings.availableModelsWindowFailed")}
          </span>
        ) : null}
      </div>
    </div>
  );
}

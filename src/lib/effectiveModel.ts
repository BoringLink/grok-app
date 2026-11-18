/**
 * Effective inference model shown in composer model chips.
 *
 * Shows the model this chat picked when that id is in the provider catalog.
 * An explicitly cleared catalog (`[]`) offers no row, so only the id the chat
 * already stored can be shown; the cleared channel `model` is not selectable
 * and resolves to nothing (BOR-152). A corrupt catalog exposes only its
 * recovered rows, so a saved id those rows omit is shown and requested as-is,
 * because the host keeps that session's child section. A leftover official
 * catalog id such as Grok 4.5, which is not in the catalog, falls back to the
 * channel `model` (#1337, #1394).
 */

export function resolveCustomRouteDisplay(
  provider:
    | {
        name?: string | null;
        model?: string | null;
        providerMode?: string | null;
        models?: ReadonlyArray<{ id: string; name?: string | null }> | null;
        modelCatalogCorrupt?: boolean | null;
      }
    | null
    | undefined,
  sessionModelId: string,
): {
  chip: { name: string; model: string };
  requestModel: string | null;
} | null {
  if (!provider) return null;
  const sessionId = sessionModelId.trim();
  if (provider.models != null && provider.models.length === 0) {
    if (!sessionId) return null;
    return {
      chip: { name: sessionId, model: sessionId },
      requestModel: sessionId,
    };
  }
  const models = provider.models ?? [];
  const configured = provider.model?.trim() ?? "";
  const sessionEntry = sessionId
    ? models.find((m) => m.id === sessionId)
    : undefined;
  if (provider.modelCatalogCorrupt === true && sessionId && !sessionEntry) {
    return {
      chip: { name: sessionId, model: sessionId },
      requestModel: sessionId,
    };
  }
  const configuredEntry = configured
    ? models.find((m) => m.id === configured)
    : undefined;
  const entry =
    sessionEntry ??
    configuredEntry ??
    (configured ? { id: configured, name: configured } : undefined);
  const model = (entry?.id || configured).trim();
  const name =
    (entry?.name || "").trim() || model || (provider.name || "").trim();
  if (!name && !model) return null;
  return {
    chip: { name: name || model, model: model || name },
    requestModel: sessionEntry ? sessionEntry.id : configured || null,
  };
}

/**
 * Label for the composer model chip.
 *
 * Official route: catalog label (or model id).
 * Custom route: provider display `name`, falling back to request `model`.
 */
export function composerModelChipLabel(opts: {
  modelId: string;
  officialLabel: string;
  activeCustom: { name: string; model: string } | null | undefined;
}): string {
  const custom = opts.activeCustom;
  if (custom) {
    const name = custom.name?.trim();
    if (name) return name;
    const model = custom.model?.trim();
    if (model) return model;
  }
  return opts.officialLabel || opts.modelId;
}

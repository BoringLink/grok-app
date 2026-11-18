/**
 * Route the composer chip paints for one chat.
 *
 * A stored custom provider stays on screen until the provider list arrives, so
 * the chip does not flash official. Once the list is known, a provider that was
 * deleted falls back to official — the same route the host connects with.
 */

export type SessionProviderRoute = {
  source: "official" | "custom";
  providerId: string | null;
};

/**
 * 单值路由：`providerId` 为 `null` 即官方路由，非空即自定义 provider id。
 * 调用方须先按 provider 目录归一化（已被删除的 provider 归一化为 `null`），
 * 因此消费方不必再同时接收 `source`。
 */
export type ProviderRouteId = Pick<SessionProviderRoute, "providerId">;

/** Resolves a saved provider identity against the latest provider catalog. */
export function resolveSessionProviderRoute(input: {
  providerId?: string | null;
  providers: ReadonlyArray<{ id: string }>;
  providersLoaded: boolean;
}): SessionProviderRoute {
  const id = input.providerId?.trim() ?? "";
  if (!id || id.toLowerCase() === "official") {
    return { source: "official", providerId: null };
  }
  if (!input.providersLoaded) {
    return { source: "custom", providerId: id };
  }
  return input.providers.some((p) => p.id === id)
    ? { source: "custom", providerId: id }
    : { source: "official", providerId: null };
}

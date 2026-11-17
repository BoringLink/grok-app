/** 草稿阶段选择、创建会话后待写入的 provider/model/effort 路由。 */
export type DraftComposerRoute = {
  providerId: string;
  modelId: string;
  effort: string | null;
};

/** 会话创建后保存草稿路由的结果。 */
export type DraftComposerRouteSaveResult =
  | { ok: true }
  | { ok: false; error: unknown };

/** 当前草稿路由保存结果；失败时标明失败路由是否仍为当前选择。 */
export type CurrentDraftComposerRouteSaveResult =
  | { status: "stale"; routeIsCurrent: false }
  | { status: "saved"; routeIsCurrent: boolean }
  | { status: "failed"; routeIsCurrent: boolean; error: unknown };

/** 会话创建后持久化草稿路由，并保留失败值供调用方展示或记录。 */
export async function saveDraftComposerRoute(
  route: DraftComposerRoute,
  save: (route: DraftComposerRoute) => Promise<unknown>,
): Promise<DraftComposerRouteSaveResult> {
  try {
    await save(route);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

/** 按字段判断草稿路由是否仍是同一选择，避免依赖对象引用稳定性。 */
function sameDraftComposerRoute(
  left: DraftComposerRoute | null,
  right: DraftComposerRoute | null,
): boolean {
  return (
    left === right ||
    (left != null &&
      right != null &&
      left.providerId === right.providerId &&
      left.modelId === right.modelId &&
      left.effort === right.effort)
  );
}

/** 保存草稿路由；路由仍在写入时被替换，则按顺序保存最新选择。 */
export async function saveCurrentDraftComposerRoute(opts: {
  currentRoute: () => DraftComposerRoute | null;
  save: (route: DraftComposerRoute) => Promise<unknown>;
}): Promise<CurrentDraftComposerRouteSaveResult> {
  let route = opts.currentRoute();
  while (route) {
    if (!sameDraftComposerRoute(opts.currentRoute(), route)) {
      route = opts.currentRoute();
      continue;
    }
    const result = await saveDraftComposerRoute(route, opts.save);
    const currentRoute = opts.currentRoute();
    if (!result.ok) {
      if (currentRoute && !sameDraftComposerRoute(currentRoute, route)) {
        route = currentRoute;
        continue;
      }
      return {
        status: "failed",
        error: result.error,
        routeIsCurrent: sameDraftComposerRoute(currentRoute, route),
      };
    }
    if (sameDraftComposerRoute(currentRoute, route)) {
      return { status: "saved", routeIsCurrent: true };
    }
    route = currentRoute;
  }
  return { status: "stale", routeIsCurrent: false };
}

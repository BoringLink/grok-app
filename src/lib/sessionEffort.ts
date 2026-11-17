/**
 * Composer 当前会话实际路由到的模型 / provider 推理档位。
 * 保留目录中的原始 id 与顺序；配置档位意味着支持扩展推理。
 * Off 由模型目录中的 `none` 或显式的 supportsReasoningOff 设置控制。
 */

import type { CustomProvider } from "@/lib/api";
import {
  effortOptionsFromProvider,
  effortsForModel,
  findModel,
  isValidModelId,
  pickDefaultEffort,
  type EffortOption,
  type ModelOption,
} from "@/lib/grokCatalog";
import {
  effectiveModelSupportsReasoningEffort,
  resolveProviderEfforts,
} from "@/lib/providerModelConfig";

/** 当前 provider/model 对应的可选档位及加载、支持状态。 */
export type SessionEffortResolution = {
  /** Raw catalog ids in advertised order. Empty when unsupported or loading. */
  options: EffortOption[];
  /** False only when the selected model explicitly rejects reasoning effort. */
  supported: boolean;
  /** True while the custom provider catalog has not loaded yet. */
  pending: boolean;
  /** True when the custom provider catalog failed to load (not still loading). */
  failed: boolean;
};

/** 解析推理档位所需的 provider 模型配置视图。 */
export type SessionEffortProvider = Pick<
  CustomProvider,
  "id" | "model" | "models" | "efforts"
>;

/** 当前会话的 provider/model 路由及官方目录。 */
export type SessionEffortRoute = {
  source: "official" | "custom";
  provider?: SessionEffortProvider | null;
  modelId: string;
  officialModels?: ModelOption[];
  /** 自定义 provider 目录加载失败（区别于仍在加载）。 */
  catalogFailed?: boolean;
};

/** Composer 模型菜单中的官方或自定义模型选择。 */
export type SessionEffortPick =
  | { kind: "official"; modelId: string }
  | { kind: "custom"; providerId: string; modelId: string };

/** 根据 Composer 模型选择解析当前支持的档位，未知选择返回 null。 */
export function resolvePickedModelEfforts(input: {
  pick: SessionEffortPick;
  providers: ReadonlyArray<SessionEffortProvider>;
  officialModels: ModelOption[];
  /** 自定义 provider 目录加载失败（区别于仍在加载）。 */
  catalogFailed?: boolean;
}): SessionEffortResolution | null {
  const pick = input.pick;
  if (pick.kind === "official") {
    if (!isValidModelId(pick.modelId, input.officialModels)) return null;
    return resolveSessionEffortOptions({
      source: "official",
      modelId: pick.modelId,
      officialModels: input.officialModels,
    });
  }
  const provider = input.providers.find(
    (candidate) => candidate.id === pick.providerId,
  );
  if (!provider) return null;
  return resolveSessionEffortOptions({
    source: "custom",
    provider,
    modelId: pick.modelId,
    catalogFailed: input.catalogFailed,
  });
}

/** 返回当前会话所选路由对应的档位选项。 */
export function resolveSessionEffortOptions(
  input: SessionEffortRoute,
): SessionEffortResolution {
  if (input.source === "official") {
    const model = findModel(input.modelId, input.officialModels);
    return {
      options: effortsForModel(
        model ?? { id: input.modelId, label: input.modelId },
      ),
      supported: true,
      pending: false,
      failed: false,
    };
  }
  const provider = input.provider;
  if (!provider) {
    // 目录加载失败与仍在加载区分开：失败态不显示中性 pending，而是错误反馈。
    return input.catalogFailed
      ? { options: [], supported: true, pending: false, failed: true }
      : { options: [], supported: true, pending: true, failed: false };
  }
  const id = input.modelId.trim();
  const model = id
    ? provider.models?.find((entry) => entry.id.trim() === id) ?? null
    : null;
  const supported =
    model == null || effectiveModelSupportsReasoningEffort(model).value;
  const options = effortOptionsFromProvider(
    resolveProviderEfforts(provider, input.modelId),
  ) ?? [];
  return {
    options,
    supported,
    pending: false,
    failed: false,
  };
}

/**
 * 保留仍被当前模型广告的原始 id；否则选显式默认值或首档。
 * 没有选项时保留存储值，等待目录恢复或上层处理失败状态。
 */
export function pickSessionEffort(
  options: EffortOption[],
  requested?: string | null,
): string {
  const id = requested?.trim() ?? "";
  if (id && options.some((option) => option.id === id)) return id;
  // No advertised options means no effective effort; an empty ladder must
  // never fabricate the static fallback as if it were selectable.
  if (options.length === 0) return id;
  return pickDefaultEffort(null, options);
}

/** 保存推理档位后的成功值，或未能保存时的原始错误。 */
export type SessionEffortSaveResult =
  | { ok: true; effort: string }
  | { ok: false; error: unknown };

/**
 * 先持久化再更新 Composer；保存拒绝时保留原选中态并返回错误。
 * `skip` 返回 true 时跳过持久化（用于废弃被后续选择取代的排队写入）。
 */
export async function saveSessionEffort(opts: {
  effort: string;
  save: (effort: string) => Promise<unknown>;
  apply: (effort: string) => void;
  skip?: () => boolean;
}): Promise<SessionEffortSaveResult> {
  if (opts.skip?.()) return { ok: true, effort: opts.effort };
  try {
    await opts.save(opts.effort);
    opts.apply(opts.effort);
    return { ok: true, effort: opts.effort };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * 上下文连续性横幅：说明模型上下文是否已核验、是否从历史恢复、以及预算省略范围。
 * 复用 context compact banner 的视觉语言，不引入新的提示样式。
 */
import type { MessageKey } from "@/i18n";
import { createT } from "@/i18n";
import { IconAlertTriangle, IconHistory, IconShieldCheck } from "@/components/icons";
import type { ContinuityBannerView } from "@/lib/sessionContinuity";

type TFn = ReturnType<typeof createT>;

export function ContinuityBanner({
  view,
  tr,
}: {
  view: ContinuityBannerView;
  tr: TFn;
}) {
  const Icon =
    view.kind === "restored"
      ? IconShieldCheck
      : view.kind === "unverified"
        ? IconAlertTriangle
        : IconHistory;
  return (
    <div
      className="lobe-chat-compact lobe-chat-continuity"
      role="status"
      data-continuity={view.kind}
    >
      <span className="lobe-chat-compact__icon" aria-hidden>
        <Icon size={15} />
      </span>
      <div className="lobe-chat-compact__body">
        <div className="lobe-chat-compact__title">
          {tr(view.titleKey as MessageKey)}
        </div>
        <div className="lobe-chat-compact__detail">
          {tr(view.detailKey as MessageKey, view.detailParams)}
        </div>
      </div>
    </div>
  );
}

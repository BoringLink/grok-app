import type { Attachment } from "@/lib/attachments";
import type { ComposerQuote } from "@/lib/composerQuotes";
import { localPathIdentity } from "@/lib/pathNormalize";

type AttachmentPath = Pick<Attachment, "path">;
type QuoteSnapshot = Pick<ComposerQuote, "id" | "text" | "comment">;

function attachmentsMatchForSubmit(
  sent: AttachmentPath[],
  current: AttachmentPath[],
): boolean {
  if (sent.length !== current.length) return false;
  return sent.every((item, i) => item.path === current[i]?.path);
}

function quoteIdentity(q: QuoteSnapshot): string {
  return `${q.id}\n${q.text}\n${q.comment}`;
}

function quotesMatchForSubmit(
  sent: readonly QuoteSnapshot[] | undefined,
  current: readonly QuoteSnapshot[] | undefined,
): boolean {
  const a = sent ?? [];
  const b = current ?? [];
  if (a.length !== b.length) return false;
  return a.every((item, i) => {
    const other = b[i];
    return !!other && quoteIdentity(item) === quoteIdentity(other);
  });
}

export type ComposerSubmitPayload = {
  sentText: string;
  sentAttachments: AttachmentPath[];
  sentQuotes?: readonly QuoteSnapshot[];
  currentText: string;
  currentAttachments: AttachmentPath[];
  currentQuotes?: readonly QuoteSnapshot[];
};

export type ComposerSubmitSettlement = "persist-clear" | "restore" | "leave";

function isComposerEmptyAfterOptimisticClear(
  text: string,
  attachments: AttachmentPath[],
  quotes?: readonly QuoteSnapshot[],
): boolean {
  return text === "" && attachments.length === 0 && (quotes?.length ?? 0) === 0;
}

function composerMatchesSentPayload(opts: ComposerSubmitPayload): boolean {
  return (
    opts.currentText === opts.sentText &&
    attachmentsMatchForSubmit(opts.sentAttachments, opts.currentAttachments) &&
    quotesMatchForSubmit(opts.sentQuotes, opts.currentQuotes)
  );
}

/**
 * True when the visible composer is still the submitted payload. Used by the
 * enqueue path (clear immediately) and as the "unchanged" half of settlement.
 */
export function shouldClearComposerAfterSubmit(
  opts: ComposerSubmitPayload,
): boolean {
  return composerMatchesSentPayload(opts);
}

/**
 * After the optimistic UI clear (user bubble already painted), decide how
 * `executeSend` should settle the composer:
 *
 * - empty or still the sent payload + success → wipe persisted draft
 * - empty or still the sent payload + failure → put the sent payload back
 * - follow-up text / attachments / quotes typed during send → leave alone
 *
 * Fail keeps draft (#599 / P1-3). Success must not swallow follow-up input.
 */
export function nextComposerSubmitSettlement(
  opts: ComposerSubmitPayload & { sendSucceeded: boolean },
): ComposerSubmitSettlement {
  const idle = isComposerEmptyAfterOptimisticClear(
    opts.currentText,
    opts.currentAttachments,
    opts.currentQuotes,
  );
  if (!idle && !composerMatchesSentPayload(opts)) return "leave";
  return opts.sendSucceeded ? "persist-clear" : "restore";
}

/**
 * 发送失败后应移除的乐观消息 id。
 *
 * 只有 Host 已接受 prompt（可能已写入 journal）时才保留用户气泡；
 * 连接/恢复失败时 prompt 从未 dispatch，用户气泡必须一起移除，
 * 不能把消息显示成“已送达模型”。队列发送始终同时移除两者。
 */
export function failedSendOptimisticDropIds(opts: {
  promptAccepted: boolean;
  fromQueue: boolean;
  userMessageId: string;
  pendingAssistantId: string;
}): string[] {
  if (opts.fromQueue || !opts.promptAccepted) {
    return [opts.userMessageId, opts.pendingAssistantId];
  }
  return [opts.pendingAssistantId];
}

/**
 * A new-chat send materializes a session and adopts that view, so `stillHere`
 * is false. The per-project new-session buffer must still be wiped on success,
 * or the next "New session" restores the just-sent prompt (#620).
 *
 * Follow-up on the new thread is a per-session draft — do not keep the
 * project buffer just because we left the draft page.
 */
export function shouldClearProjectDraftAfterNewChatSend(opts: {
  fromNewChatPage: boolean;
  sendSucceeded: boolean;
}): boolean {
  return opts.fromNewChatPage && opts.sendSucceeded;
}

/**
 * Follow-up send on a real thread must still drop a project buffer that is
 * exactly the prompt we just sent. Otherwise New session keeps restoring it
 * (pre-#620 leftovers, or a send that materialized the session first).
 */
export function shouldClearMatchingProjectDraft(opts: {
  projectDraftText: string | null | undefined;
  sentText: string;
  projectDraftAttachments?: readonly AttachmentPath[];
  projectDraftQuotes?: readonly QuoteSnapshot[];
  sentAttachments?: readonly AttachmentPath[];
  sentQuotes?: readonly QuoteSnapshot[];
}): boolean {
  const saved = opts.projectDraftText ?? "";
  const sent = opts.sentText ?? "";
  if (!(sent.length > 0 && saved === sent)) return false;
  // An existing-thread send that happens to reuse the same words must not
  // wipe an unsent new-task buffer that still has extra files or quotes.
  const sentAtt = new Set(
    (opts.sentAttachments ?? []).map((a) => localPathIdentity(a.path)),
  );
  if (
    (opts.projectDraftAttachments ?? []).some(
      (a) => !sentAtt.has(localPathIdentity(a.path)),
    )
  ) {
    return false;
  }
  const sentQ = new Set((opts.sentQuotes ?? []).map(quoteIdentity));
  if ((opts.projectDraftQuotes ?? []).some((q) => !sentQ.has(quoteIdentity(q)))) {
    return false;
  }
  return true;
}

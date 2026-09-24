import type { ComposerPrefsFreshness } from "./composerPrefsFreshness";

/** 一次 prefs 落盘的目标：项目与**会话**，必须在点击时定格。 */
export interface ComposerPrefsTarget {
  projectId: string | null;
  sessionId: string | null;
}

/** 落盘请求体：固定目标 + 本次要改的字段。 */
export type ComposerPrefsWriteBody = ComposerPrefsTarget & {
  modelId?: string;
  effort?: string;
};

/**
 * 把一次 composer prefs 写入排队落盘。
 *
 * `body` 以**值**传入而非回调：目标项目/会话必须在点击那一刻定格，因为写入要
 * 排队等前面的落盘完成，排队期间用户可能已经切到别的会话。执行时再去读
 * `session.sessionId`，就会把这次选择写进另一个会话 —— 这正是「一个会话切模型，
 * 另一个会话跟着变」的成因。
 *
 * 调用方也不得在回调里读回本次写入自身的 promise（例如把返回值先存进 ref，
 * 再在回调里读这个 ref 当作排队前驱）：那样写入会等自己完成，整条串行链永久
 * 卡死，之后所有 prefs 写入（含切模型）都不会再发出。排队与发送屏障由返回的
 * promise 表达，前驱由 {@link ComposerPrefsFreshness} 内部维护。
 */
export function writeComposerPrefs(
  freshness: ComposerPrefsFreshness,
  body: ComposerPrefsWriteBody,
  send: (body: ComposerPrefsWriteBody) => Promise<unknown>,
  onError: (error: unknown) => void,
): Promise<void> {
  return freshness.trackLocalWrite(async () => {
    try {
      await send(body);
    } catch (error) {
      onError(error);
    }
  });
}

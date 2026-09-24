import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { ComposerPrefsFreshness } from "./composerPrefsFreshness";
import { writeComposerPrefs, type ComposerPrefsWriteBody } from "./composerPrefsWrite";

/** 让串行链上的微任务全部排空。 */
async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

describe("writeComposerPrefs", () => {
  it("落盘成功时发出请求并让屏障 promise 结束", async () => {
    // Arrange
    const freshness = new ComposerPrefsFreshness();
    const sent: ComposerPrefsWriteBody[] = [];
    const onError = vi.fn();

    // Act
    await writeComposerPrefs(
      freshness,
      { projectId: "p-1", sessionId: "s-A", effort: "high" },
      async (body) => {
        sent.push(body);
      },
      onError,
    );

    // Assert
    expect(sent).toEqual([
      { projectId: "p-1", sessionId: "s-A", effort: "high" },
    ]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("落盘失败时上抛给 onError，屏障 promise 仍然结束", async () => {
    // Arrange
    const freshness = new ComposerPrefsFreshness();
    const failure = new Error("ipc down");
    const onError = vi.fn();

    // Act
    await writeComposerPrefs(
      freshness,
      { projectId: null, sessionId: null, modelId: "m-1" },
      async () => {
        throw failure;
      },
      onError,
    );

    // Assert
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("排队期间切到别的会话，落盘仍写到点击时的那个会话", async () => {
    // Arrange：先占住串行链，模拟上一次落盘还在途。
    const freshness = new ComposerPrefsFreshness();
    const sent: ComposerPrefsWriteBody[] = [];
    let releaseFirst!: () => void;
    const firstWrite = writeComposerPrefs(
      freshness,
      { projectId: null, sessionId: "s-A", effort: "low" },
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
      () => undefined,
    );

    // Act：点击时定格 s-B，随后用户切走，落盘才真正执行。
    const secondWrite = writeComposerPrefs(
      freshness,
      { projectId: null, sessionId: "s-B", modelId: "m-1" },
      async (body) => {
        sent.push(body);
      },
      () => undefined,
    );
    await flush();
    expect(sent).toEqual([]); // 串行：上一次未完成前不发出
    releaseFirst();
    await Promise.all([firstWrite, secondWrite]);

    // Assert
    expect(sent).toEqual([{ projectId: null, sessionId: "s-B", modelId: "m-1" }]);
  });

  it("不再存在自锁的排队前驱实现", async () => {
    // Arrange / Act：旧的 `queueComposerPreferenceApply` 允许把「本次写入自己的
    // promise」当排队前驱传进去，写入因此永远等自己，整条链卡死、后续切模型都
    // 发不出请求。该实现已删除，prefs 写入统一走本模块。
    const source = await readFile(
      new URL("../app/AppWorkbench.tsx", import.meta.url),
      "utf8",
    );

    // Assert
    expect(source).not.toContain("queueComposerPreferenceApply");
  });
});

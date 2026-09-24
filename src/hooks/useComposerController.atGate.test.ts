/**
 * @vitest-environment jsdom
 *
 * 回归（评审 2）：`@` 面板的「失焦即关闭」。
 *
 * 旧的 DOM 探测（`shouldProbeComposerLiveDom`）在编辑器失焦时不再上报查询，面板随之
 * 关闭；改成由 `ComposerEditor` 主动上报后，这个判定必须留在消费侧，否则用 Tab 移出
 * 输入框后面板会常驻（浮层只在外部 mousedown 与 Escape 时关闭，Tab 不触发）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useComposerController } from "./useComposerController";

afterEach(cleanup);

const RANGE = { from: 1, to: 4, query: "ab" };

describe("reportAtQuery 的焦点闸门", () => {
  it("编辑器失焦时上报被忽略", () => {
    // Arrange
    const { result } = renderHook(() => useComposerController(""));
    const input = document.createElement("div");
    document.body.appendChild(input);
    act(() => {
      result.current.composerInputRef.current = input;
    });

    // Act —— activeElement 仍是 body（等于失焦）
    act(() => {
      result.current.reportAtQuery(RANGE);
    });

    // Assert
    expect(result.current.liveAt.present).toBe(false);
  });

  it("编辑器聚焦时上报生效", () => {
    // Arrange
    const { result } = renderHook(() => useComposerController(""));
    const input = document.createElement("div");
    input.tabIndex = 0;
    document.body.appendChild(input);
    act(() => {
      result.current.composerInputRef.current = input;
      input.focus();
    });

    // Act
    act(() => {
      result.current.reportAtQuery(RANGE);
    });

    // Assert
    expect(result.current.liveAt).toMatchObject({
      present: true,
      query: "ab",
      start: 1,
      end: 4,
    });
  });

  it("失焦时上报 null 仍然清掉已有查询", () => {
    // Arrange —— 先聚焦让面板可见
    const { result } = renderHook(() => useComposerController(""));
    const input = document.createElement("div");
    input.tabIndex = 0;
    document.body.appendChild(input);
    act(() => {
      result.current.composerInputRef.current = input;
      input.focus();
      result.current.reportAtQuery(RANGE);
    });
    expect(result.current.liveAt.present).toBe(true);

    // Act —— 失焦后编辑器上报 null
    act(() => {
      input.blur();
      result.current.reportAtQuery(null);
    });

    // Assert
    expect(result.current.liveAt.present).toBe(false);
  });
});

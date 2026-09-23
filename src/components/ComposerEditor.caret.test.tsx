/**
 * @vitest-environment jsdom
 *
 * 回归：通过 `@` 面板插入文件引用后，光标必须停在 chip 之后（编辑器文本空间）。
 *
 * 复现用户顺序：draft 里已有 `@query`，选中文件后 `insertAtTokenAsRef` 重建 draft，
 * 请求落点，再把新 draft 推给 `ComposerEditor`（触发 setContent + placePendingCaret）。
 * 断言的是 `getComposerCaretOffset`（编辑器文本空间偏移），不是 DOM 位置。
 */
import { afterEach, describe, expect, it } from "vitest";
import "@/test/jsdomStubs";
import { cleanup, render, waitFor } from "@testing-library/react";
import { StrictMode, useState } from "react";
import {
  ComposerEditor,
  getComposerCaretOffset,
  getComposerEditorText,
  requestComposerStoredCaret,
} from "@/components/ComposerEditor";
import { insertAtTokenAsRef } from "@/lib/atFileQuery";
import {
  locateAtRangeInMarkdown,
  refCaretInEditorText,
} from "@/lib/composerMarkdown";

// EditorView.scrollToSelection → Range#getClientRects / getBoundingClientRect，
// jsdom 未实现，缺一个就会在 selectionchange 时抛未处理异常。
if (typeof Range.prototype.getClientRects !== "function") {
  Range.prototype.getClientRects = () =>
    Object.assign([], { item: () => null }) as unknown as DOMRectList;
}
if (typeof Range.prototype.getBoundingClientRect !== "function") {
  Range.prototype.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    }) as unknown as DOMRect;
}

const TOKEN = "[[file:/repo/a.ts]]";

let pushDraft: (next: string) => void = () => {};

function Harness({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  pushDraft = setValue;
  return <ComposerEditor value={value} onChange={setValue} aria-label="t" />;
}

afterEach(cleanup);

/** 走一遍 applyAtFile 的顺序，返回 chip 之后的编辑器文本偏移。 */
async function insertRef(
  initial: string,
  query: string,
): Promise<number | null> {
  const range = locateAtRangeInMarkdown(initial, query);
  const inserted = insertAtTokenAsRef(initial, range, TOKEN);
  const { container } = render(
    <StrictMode>
      <Harness initial={initial} />
    </StrictMode>,
  );
  const el = await waitFor(() => {
    const node = container.querySelector<HTMLElement>(".composer__input");
    if (!node) throw new Error("editor not mounted");
    return node;
  });
  const caret = refCaretInEditorText({
    editorText: getComposerEditorText(el),
    query,
    range,
    token: TOKEN,
    storedCaret: inserted.caret,
  });
  el.focus();
  requestComposerStoredCaret(caret);
  pushDraft(inserted.draft);
  await waitFor(() => {
    expect(getComposerEditorText(el)).toContain("[[file:/repo/a.ts]]");
  });
  return getComposerCaretOffset(el);
}

describe("caret after an @ reference insert", () => {
  it("stops right after the chip at the end of a list item", async () => {
    // Arrange / Act
    const caret = await insertRef("- 第一个文件 @", "");
    // Assert — 编辑器文本空间里 chip 之后是 25（Markdown 里是 28）
    expect(caret).toBe(25);
  });

  it("stops right after the chip mid-sentence in a list item", async () => {
    // Arrange / Act
    const caret = await insertRef("- 在 @atF 里找", "atF");
    // Assert — 编辑器文本空间里是 21（Markdown 里是 23）
    expect(caret).toBe(21);
  });

  it("stops right after the chip at the end of a plain paragraph", async () => {
    // Arrange / Act
    const caret = await insertRef("看 @", "");
    // Assert
    expect(caret).toBe(21);
  });

  it("stops right after the chip mid-sentence in a plain paragraph", async () => {
    // Arrange / Act
    const caret = await insertRef("在 @atF 里找", "atF");
    // Assert
    expect(caret).toBe(21);
  });
});

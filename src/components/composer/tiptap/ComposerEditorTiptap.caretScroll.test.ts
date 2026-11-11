/**
 * 溢出光标滚动决策的行为测试（jsdom + 手工几何覆盖）。
 *
 * 覆盖：末尾钉底、最小滚动、几何未知不滚动（回归：长文本上方修改时
 * 视窗被无条件拽到底部）。
 *
 * @vitest-environment jsdom
 */
import "@/test/jsdomStubs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  scrollComposerCaretAfterResize,
  type ComposerCaretSource,
} from "./ComposerEditorTiptap";
import { scrollComposerCaretIntoView } from "@/components/ComposerEditor";

/** 构造可控制的伪滚动容器：jsdom 无布局，几何全部手工注入。 */
function makeScroller(opts: {
  scrollHeight: number;
  clientHeight: number;
  boxTop?: number;
  boxBottom?: number;
}): HTMLElement {
  const el = document.createElement("div");
  let top = opts.scrollHeight;
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => top,
  });
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    get: () => opts.clientHeight,
  });
  el.getBoundingClientRect = (() => ({
    top: opts.boxTop ?? 0,
    bottom: opts.boxBottom ?? opts.clientHeight,
  })) as () => DOMRect;
  return el;
}

describe("scrollComposerCaretAfterResize", () => {
  beforeEach(() => {
    // jsdom 里 scrollTop 可写但 layout 恒为 0，重置即可。
  });

  it("不溢出时不做任何滚动", () => {
    const el = makeScroller({ scrollHeight: 200, clientHeight: 220 });
    el.scrollTop = 0;
    scrollComposerCaretAfterResize(el, {
      atEnd: false,
      rect: () => ({ top: 10, bottom: 30 }),
    });
    expect(el.scrollTop).toBe(0);
  });

  it("光标塌缩在文档末尾时原子钉底到 maxScroll", () => {
    const el = makeScroller({ scrollHeight: 500, clientHeight: 220 });
    el.scrollTop = 40;
    scrollComposerCaretAfterResize(el, { atEnd: true, rect: () => null });
    expect(el.scrollTop).toBe(280); // 500 - 220
  });

  it("光标在视口内时不滚动（长文本上方修改的主回归路径）", () => {
    const el = makeScroller({ scrollHeight: 500, clientHeight: 220 });
    el.scrollTop = 40;
    scrollComposerCaretAfterResize(el, {
      atEnd: false,
      rect: () => ({ top: 100, bottom: 122 }),
    });
    expect(el.scrollTop).toBe(40);
  });

  it("光标在视口上方时最小上滚，不钉底", () => {
    const el = makeScroller({ scrollHeight: 500, clientHeight: 220 });
    el.scrollTop = 40;
    scrollComposerCaretAfterResize(el, {
      atEnd: false,
      rect: () => ({ top: -20, bottom: 2 }),
    });
    // 需要 -(0 - (-20) + 4) = -24 → 40 - 24 = 16
    expect(el.scrollTop).toBe(16);
  });

  it("光标在视口下方时下滚并夹紧到 maxScroll", () => {
    const el = makeScroller({ scrollHeight: 500, clientHeight: 220 });
    el.scrollTop = 0;
    scrollComposerCaretAfterResize(el, {
      atEnd: false,
      rect: () => ({ top: 300, bottom: 322 }),
    });
    // delta = 322 - 220 + 4 = 106，未超过 max 280
    expect(el.scrollTop).toBe(106);
  });

  it("光标几何未知时不滚动（IME 组合态等）", () => {
    const el = makeScroller({ scrollHeight: 500, clientHeight: 220 });
    el.scrollTop = 40;
    scrollComposerCaretAfterResize(el, {
      atEnd: false,
      rect: () => null,
    });
    expect(el.scrollTop).toBe(40);
  });

  it("caret 缺省（非输入路径）时不滚动", () => {
    const el = makeScroller({ scrollHeight: 500, clientHeight: 220 });
    el.scrollTop = 40;
    scrollComposerCaretAfterResize(el, undefined);
    expect(el.scrollTop).toBe(40);
  });

  it("末尾钉底的方向可上可下：滚动位置高于 max 时被拉回", () => {
    const el = makeScroller({ scrollHeight: 500, clientHeight: 220 });
    el.scrollTop = 280;
    const caret: ComposerCaretSource = { atEnd: true, rect: () => null };
    scrollComposerCaretAfterResize(el, caret);
    expect(el.scrollTop).toBe(280);
  });
});

describe("scrollComposerCaretIntoView（legacy contenteditable 路径）", () => {
  it("光标几何未知时不钉底（回归：无条件 pin bottom）", () => {
    const el = makeScroller({ scrollHeight: 500, clientHeight: 220 });
    el.scrollTop = 40;
    // jsdom 的 getSelection rangeCount 为 0 → 几何未知 → 应保持原位。
    scrollComposerCaretIntoView(el);
    expect(el.scrollTop).toBe(40);
  });
});

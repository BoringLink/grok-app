/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { UserMessageBody } from "./ThreadUserBody";

afterEach(cleanup);

function renderBody(content: string): HTMLElement {
  const { container } = render(
    <UserMessageBody
      content={content}
      scheduledLabel="Scheduled"
      remoteImLabel="Remote IM"
      locale="en"
    />,
  );
  return container;
}

describe("user bubble renders like the composer", () => {
  it("renders stored escapes as the characters the user typed", () => {
    // Arrange —— journal 里就是这样的源码
    const content = "\\# trending topic\n\n1\\. 这不是清单\n\n&gt; 不是引用";

    // Act
    const root = renderBody(content);

    // Assert
    expect(root.textContent).toContain("# trending topic");
    expect(root.textContent).toContain("1. 这不是清单");
    expect(root.textContent).toContain("> 不是引用");
    expect(root.textContent).not.toContain("\\");
    expect(root.textContent).not.toContain("&gt;");
  });

  it("renders headings, bold and fenced code as blocks", () => {
    // Arrange
    const content = "## **标题**\n\n正文\n\n```js\nconst a = 1;\n```";

    // Act
    const root = renderBody(content);

    // Assert
    const heading = root.querySelector("h2");
    expect(heading?.textContent).toBe("标题");
    expect(heading?.querySelector("strong")).not.toBeNull();
    expect(root.textContent).toContain("正文");
    expect(root.querySelector("pre code")?.textContent).toContain(
      "const a = 1;",
    );
  });

  it("renders literal escaped marks without formatting", () => {
    // Arrange —— 粘贴字面量 `a *b* c` 时 draft 会保留防御性转义
    const content = "a \\*b\\* c";

    // Act
    const root = renderBody(content);

    // Assert
    expect(root.textContent).toBe("a *b* c");
    expect(root.querySelector("em")).toBeNull();
  });
});

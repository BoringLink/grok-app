/**
 * BOR-56 回归护栏：输入框的 Markdown 渲染必须与聊天消息（`.chat-md`）对齐。
 *
 * 修掉的两个既有缺陷：
 * 1. Tailwind preflight（`node_modules/tailwindcss/preflight.css` 的
 *    `ol, ul, menu { list-style: none }`）清掉了全站列表标记，之后无人恢复，
 *    聊天消息与输入框都没有项目符号，`.chat-md li::marker` 也成了死规则。
 * 2. 旧 contenteditable 时代的 `.composer__input b/strong/i/em/a { inherit
 *    !important }` 压制规则让粗体、斜体、删除线、链接在输入框里渲染成普通
 *    文本——换成 TipTap 后该防御已无保护对象。
 *
 * 这些是样式层不变量，组件测试断言不到；沿用仓库既有的 CSS guard 范式
 * （见 composerColumn.guard.test.ts）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const styles = join(__dirname, "../styles");
const read = (name: string) => readFileSync(join(styles, name), "utf8");

const chatPart3 = read("chat.part3.css");
const modalsPart1 = read("modals.part1.css");
const settingsPart6 = read("settings.part6.css");

/** 取出第一条匹配 `rules[0]` 的规则体，便于逐条断言声明。 */
function ruleBody(css: string, pattern: RegExp): string | undefined {
  return css.match(pattern)?.[1];
}

describe("BOR-56 composer markdown alignment", () => {
  it("no longer strips inline marks inside the composer", () => {
    // Arrange / Act — 这条规则若回来，粗斜体/删除线/链接在输入框里会重新变成纯文本
    const suppression =
      /\.composer__input\s+(?:b|strong|i|em|u|s|font|a)\s*[,{][\s\S]{0,400}?font-weight:\s*inherit\s*!important/;

    // Assert
    expect(chatPart3).not.toMatch(suppression);
    expect(chatPart3).not.toMatch(/font-style:\s*inherit\s*!important/);
    expect(chatPart3).not.toMatch(/text-decoration:\s*none\s*!important/);
  });

  it("restores list markers for chat, preview and composer from one rule set", () => {
    // Arrange / Act / Assert — 同一个 preflight 根因，三个作用域一次补齐
    expect(settingsPart6).toMatch(
      /\.chat-md ul,\s*\n\.md-body ul,\s*\n\.composer__input ul\s*\{\s*list-style:\s*disc/s,
    );
    expect(settingsPart6).toMatch(
      /\.chat-md ol,\s*\n\.md-body ol,\s*\n\.composer__input ol\s*\{\s*list-style:\s*decimal/s,
    );
    // 嵌套层级不能回落到浏览器默认（那会让子项和父项长得一样）
    expect(settingsPart6).toMatch(/ul ul[\s\S]{0,160}?list-style:\s*circle/);
    expect(settingsPart6).toMatch(/ol ol[\s\S]{0,160}?list-style:\s*lower-alpha/);
    expect(settingsPart6).toMatch(/ol ol ol[\s\S]{0,160}?list-style:\s*lower-roman/);
  });

  it("renders composer text emphasis the way chat does", () => {
    // Arrange / Act
    const strong = ruleBody(modalsPart1, /\.composer__input strong\s*\{([\s\S]*?)\}/);
    const headings = ruleBody(
      modalsPart1,
      /\.composer__input h1,\s*\n\.composer__input h2,\s*\n\.composer__input h3\s*\{([\s\S]*?)\}/,
    );

    // Assert — 聊天侧 strong/标题都是 600，不是浏览器默认的 bolder(700)
    expect(strong).toMatch(/font-weight:\s*600/);
    expect(headings).toMatch(/font-weight:\s*600/);
    // h2 与聊天侧一致（1.12em）
    expect(modalsPart1).toMatch(
      /\.composer__input h2\s*\{\s*font-size:\s*1\.12em/s,
    );
  });

  it("renders composer links like .chat-md__link but keeps a text cursor", () => {
    // Arrange / Act
    const link = ruleBody(modalsPart1, /\.composer__input a\s*\{([\s\S]*?)\}/);

    // Assert — 点击应定位光标，不该把鼠标变成手型或直接开浏览器
    expect(link).toMatch(/color:\s*var\(--accent\)/);
    expect(link).toMatch(/text-decoration:\s*none/);
    expect(link).toMatch(/cursor:\s*text/);
  });

  it("renders composer code in the chat palette", () => {
    // Arrange / Act
    const pre = ruleBody(modalsPart1, /\.composer__input pre\s*\{([\s\S]*?)\}/);
    const inline = ruleBody(modalsPart1, /\.composer__input code\s*\{([\s\S]*?)\}/);
    const preCode = ruleBody(
      modalsPart1,
      /\.composer__input pre code\s*\{([\s\S]*?)\}/,
    );

    // Assert — 代码块与聊天侧同一套底色/描边/圆角；行内代码底色必须是共享 token
    // （聊天侧曾用半透明浮层、输入框用近黑实心，两边观感不同）
    expect(pre).toMatch(/background:\s*var\(--bg-code\)/);
    expect(pre).toMatch(/border:\s*1px solid var\(--border-subtle\)/);
    expect(pre).toMatch(/border-radius:\s*10px/);
    expect(inline).toMatch(/background:\s*var\(--md-inline-code-bg/);
    expect(inline).toMatch(/border-radius:\s*6px/);
    // 代码块内的 code 不能叠上行内代码的底色/描边/圆角
    expect(preCode).toMatch(/background:\s*transparent/);
    expect(preCode).toMatch(/border:\s*0/);
    expect(preCode).toMatch(/border-radius:\s*0/);
    // 未定义的 token 不能再回到输入框的 Markdown 规则里
    expect(modalsPart1).not.toMatch(/--bg-tertiary/);
  });

  it("keeps one shared inline-code background token for both surfaces", () => {
    // Arrange / Act — 聊天侧与输入框必须引用同一个定义，否则会各写一份字面量而漂移
    const lobeChat1 = readFileSync(
      join(__dirname, "../components/lobe-chat/lobe-chat.part1.css"),
      "utf8",
    );

    // Assert
    expect(lobeChat1).toMatch(/--chat-inline-code-bg:\s*var\(--md-inline-code-bg/);
    expect(modalsPart1).toMatch(/var\(--md-inline-code-bg/);
  });

  it("keeps the composer divider visible on purpose", () => {
    // Arrange / Act
    const hr = ruleBody(modalsPart1, /\.composer__input hr\s*\{([\s\S]*?)\}/);

    // Assert — 聊天侧故意 display:none，输入框必须让用户看见自己敲的 `---`；
    // 这是本 Issue 唯一一处有意的不对齐，别当 bug 改掉。
    expect(hr).toMatch(/border-top:\s*1px solid var\(--border-strong\)/);
    expect(hr).not.toMatch(/display:\s*none/);
  });
});

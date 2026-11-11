/**
 * Rendered-DOM find marks for the markdown preview.
 *
 * The preview is rendered HTML, so the source find bar cannot paint its hits
 * with ProseMirror or CodeMirror decorations. This wraps literal matches in
 * `<mark class="rp-find-hit">` instead and returns the active mark so the
 * caller can scroll it into view.
 */

const MARK_SELECTOR = "mark.rp-find-hit";

/** Remove every mark left by a previous query and merge the split text back. */
export function clearRenderedFindMarks(host: HTMLElement): void {
  host.querySelectorAll(MARK_SELECTOR).forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    parent.replaceChild(
      document.createTextNode(mark.textContent ?? ""),
      mark,
    );
    parent.normalize();
  });
}

type TextMatch = {
  node: Text;
  start: number;
  end: number;
  index: number;
};

function collectMatches(host: HTMLElement, query: string): TextMatch[] {
  const needle = query.toLowerCase();
  if (!needle) return [];
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  const matches: TextMatch[] = [];
  let node = walker.nextNode();
  while (node) {
    const text = node.nodeValue ?? "";
    const haystack = text.toLowerCase();
    let at = haystack.indexOf(needle);
    while (at !== -1) {
      matches.push({
        node: node as Text,
        start: at,
        end: at + needle.length,
        index: matches.length,
      });
      at = haystack.indexOf(needle, at + needle.length);
    }
    node = walker.nextNode();
  }
  return matches;
}

/**
 * Clear old marks and wrap every literal occurrence of `query`.
 * Returns the element for `activeIndex`, if that hit is currently rendered.
 */
export function markRenderedFindMatches(
  host: HTMLElement,
  query: string,
  activeIndex: number,
): HTMLElement | null {
  clearRenderedFindMarks(host);
  if (!query) return null;

  const matches = collectMatches(host, query);
  const byNode = new Map<Text, TextMatch[]>();
  matches.forEach((match) => {
    const list = byNode.get(match.node);
    if (list) list.push(match);
    else byNode.set(match.node, [match]);
  });

  let active: HTMLElement | null = null;
  byNode.forEach((list, node) => {
    // Descending order keeps earlier split offsets valid on the same node.
    [...list]
      .sort((a, b) => b.start - a.start)
      .forEach((match) => {
        const target = node.splitText(match.start);
        target.splitText(match.end - match.start);
        const mark = document.createElement("mark");
        mark.className =
          match.index === activeIndex ? "rp-find-hit is-active" : "rp-find-hit";
        target.parentNode?.insertBefore(mark, target);
        mark.appendChild(target);
        if (match.index === activeIndex) active = mark;
      });
  });
  return active;
}

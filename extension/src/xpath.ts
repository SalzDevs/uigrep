/** Positional XPath — fallback when CSS selectors are ambiguous. */

export function buildXPath(el: Element): string {
  if (el === document.documentElement) return "/html";

  const segments: string[] = [];
  let current: Element | null = el;
  const docEl = document.documentElement;

  while (current && current !== docEl) {
    const parent: Element | null = current.parentElement;
    if (!parent) break;
    const tag = current.tagName.toLowerCase();
    const sameTag = [...parent.children].filter(
      (c) => c.tagName === current!.tagName,
    );
    const index = sameTag.length > 1 ? sameTag.indexOf(current) + 1 : null;
    segments.unshift(index ? `${tag}[${index}]` : tag);
    current = parent;
  }
  return "/html/" + segments.join("/");
}

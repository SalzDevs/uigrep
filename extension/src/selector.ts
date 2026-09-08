/**
 * Shortest-stable CSS selector. Strategy:
 * 1. data-testid / data-test / data-cy attributes — best anchors
 * 2. id
 * 3. minimal tag path with nth-of-type until an anchor is found
 */

const TEST_ATTRS = ["data-testid", "data-test", "data-cy"] as const;

function hasId(el: Element): boolean {
  return (el.getAttribute("id")?.length ?? 0) > 0;
}

function escapedId(el: Element): string {
  return CSS.escape(el.getAttribute("id")!);
}

function testAttrSelector(el: Element): string | null {
  for (const attr of TEST_ATTRS) {
    const value = el.getAttribute(attr);
    if (value) return `[${attr}="${CSS.escape(value)}"]`;
  }
  return null;
}

function segment(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (tag === "html" || tag === "body") return tag;
  const classes = [...el.classList]
    .filter((c) => c.length > 0 && !/^[a-z0-9]{6,}$/i.test(c)) // drop hash-y classnames
    .slice(0, 2);
  let base = classes.length
    ? `${tag}.${classes.map((c) => CSS.escape(c)).join(".")}`
    : tag;
  if (!classes.length && !hasId(el)) {
    // disambiguate among same-tag siblings
    const parent: Element | null = el.parentElement;
    if (parent) {
      const sameTag = [...parent.children].filter(
        (c) => c.tagName === el.tagName,
      );
      if (sameTag.length > 1) {
        base += `:nth-of-type(${sameTag.indexOf(el) + 1})`;
      }
    }
  }
  return base;
}

export function buildSelector(el: Element): string {
  const direct = testAttrSelector(el);
  if (direct) return direct;
  if (hasId(el)) return `#${escapedId(el)}`;

  const parts: string[] = [];
  let current: Element | null = el;
  const docEl = document.documentElement;
  while (current && current !== docEl) {
    const anchor = testAttrSelector(current);
    if (anchor) {
      parts.unshift(anchor);
      break;
    }
    if (hasId(current)) {
      parts.unshift(`#${escapedId(current)}`);
      break;
    }
    parts.unshift(segment(current));
    current = current.parentElement;
  }
  if (current === docEl) parts.unshift("html");
  return parts.join(" > ");
}

/**
 * Pick mode — hover outline + click-to-select. Overlay is pointer-events:
 * none so events fall through to the page; we hit-test ourselves.
 */

const OUTLINE_ID = "uigrep-outline";
const LABEL_ID = "uigrep-label";
const BADGE_ID = "uigrep-badge";

export class PickMode {
  private active = false;
  private hovered: Element | null = null;
  private onSelect: (el: Element) => void;
  private outline: HTMLElement | null = null;
  private label: HTMLElement | null = null;
  private badge: HTMLElement | null = null;

  constructor(onSelect: (el: Element) => void) {
    this.onSelect = onSelect;
  }

  get isActive(): boolean {
    return this.active;
  }

  toggle(): void {
    if (this.active) this.stop();
    else this.start();
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    document.addEventListener("mousemove", this.onMouseMove, true);
    document.addEventListener("click", this.onClick, true);
    document.addEventListener("keydown", this.onKeyDown, true);
    this.badge = this.createBadge();
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    document.removeEventListener("mousemove", this.onMouseMove, true);
    document.removeEventListener("click", this.onClick, true);
    document.removeEventListener("keydown", this.onKeyDown, true);
    this.clearOutline();
    this.badge?.remove();
    this.badge = null;
  }

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.active) return;
    const target = document.elementFromPoint(e.clientX, e.clientY);
    if (!target || target === this.hovered) return;
    this.hovered = target;
    this.showOutline(target);
  };

  private onClick = (e: MouseEvent): void => {
    if (!this.active) return;
    e.preventDefault();
    e.stopPropagation();
    const target = document.elementFromPoint(e.clientX, e.clientY);
    if (target) {
      const el = target;
      this.onSelect(el);
    }
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") this.stop();
  };

  private showOutline(el: Element): void {
    this.clearOutline();
    const rect = el.getBoundingClientRect();
    const outline = document.createElement("div");
    outline.id = OUTLINE_ID;
    Object.assign(outline.style, {
      position: "fixed",
      left: `${rect.x - 2}px`,
      top: `${rect.y - 2}px`,
      width: `${rect.width + 4}px`,
      height: `${rect.height + 4}px`,
      border: "2px solid #ff4d6d",
      borderRadius: "2px",
      background: "rgba(255, 77, 109, 0.08)",
      pointerEvents: "none",
      zIndex: "2147483646",
      boxSizing: "border-box",
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.append(outline);
    this.outline = outline;

    const name =
      el.getAttribute("aria-label") ||
      el.getAttribute("data-testid") ||
      `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}`;
    const label = document.createElement("div");
    label.id = LABEL_ID;
    Object.assign(label.style, {
      position: "fixed",
      left: `${rect.x - 2}px`,
      top: `${Math.max(rect.y - 24, 0)}px`,
      padding: "2px 6px",
      background: "#ff4d6d",
      color: "#fff",
      font: "12px/1.4 ui-monospace, monospace",
      borderRadius: "2px",
      pointerEvents: "none",
      zIndex: "2147483647",
      maxWidth: "300px",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
    } satisfies Partial<CSSStyleDeclaration>);
    label.textContent = name;
    document.body.append(label);
    this.label = label;
  }

  private clearOutline(): void {
    this.outline?.remove();
    this.outline = null;
    this.label?.remove();
    this.label = null;
  }

  private createBadge(): HTMLElement {
    const badge = document.createElement("div");
    badge.id = BADGE_ID;
    Object.assign(badge.style, {
      position: "fixed",
      bottom: "16px",
      right: "16px",
      padding: "6px 12px",
      background: "#111318",
      color: "#fff",
      font: "13px/1.4 ui-monospace, monospace",
      borderRadius: "6px",
      pointerEvents: "none",
      zIndex: "2147483647",
      boxShadow: "0 2px 12px rgba(0,0,0,0.3)",
    } satisfies Partial<CSSStyleDeclaration>);
    badge.textContent = "uigrep: click element to select · Esc to exit";
    document.body.append(badge);
    return badge;
  }
}

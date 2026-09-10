import {
  SCHEMA_VERSION,
  captureSessionSchema,
  type Annotation,
  type Rect,
  type TargetCandidate,
} from "@uigrep/schema";
import type { BackgroundRequest, ContentRequest } from "../../lib/messages";
import { normalizeWireCapture, truncateUtf8 } from "../../lib/wire";

const OVERLAY_ID = "uigrep-overlay-host";
const MAX_SCANNED_ELEMENTS = 5_000;
const STYLE_PROPERTIES = [
  "display",
  "position",
  "width",
  "height",
  "margin",
  "padding",
  "gap",
  "align-items",
  "justify-content",
  "grid-template-columns",
  "overflow",
  "font-size",
  "font-weight",
  "line-height",
  "color",
  "background-color",
  "border",
  "border-radius",
  "box-shadow",
] as const;

type DraftAnnotation = Omit<Annotation, "status" | "hasMoreTargets">;

type Drag = {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
};

function intersects(a: Rect, b: DOMRect): boolean {
  return (
    a.x < b.right &&
    a.x + a.width > b.left &&
    a.y < b.bottom &&
    a.y + a.height > b.top
  );
}

function clippedText(element: Element): string {
  return truncateUtf8(
    (element.textContent ?? "").replace(/\s+/g, " ").trim(),
    2_000,
  );
}

function selectorFor(element: Element): string {
  const html = element as HTMLElement;
  if (html.dataset.testid)
    return `[data-testid="${CSS.escape(html.dataset.testid)}"]`;
  if (element.id) return `#${CSS.escape(element.id)}`;
  const pieces: string[] = [];
  let current: Element | null = element;
  while (current && pieces.length < 5) {
    let piece = current.tagName.toLowerCase();
    const stableClass = [...current.classList].find(
      (name) => !/[0-9]{4,}/.test(name),
    );
    if (stableClass) piece += `.${CSS.escape(stableClass)}`;
    pieces.unshift(piece);
    current = current.parentElement;
  }
  return pieces.join(" > ");
}

function roleFor(element: Element): string | undefined {
  const explicit = element.getAttribute("role");
  if (explicit) return explicit;
  const roles: Record<string, string> = {
    A: "link",
    BUTTON: "button",
    INPUT: "textbox",
    NAV: "navigation",
    MAIN: "main",
    FORM: "form",
    IMG: "img",
  };
  return roles[element.tagName];
}

function accessibleName(element: Element): string | undefined {
  const name =
    element.getAttribute("aria-label") ??
    element.getAttribute("alt") ??
    element.getAttribute("title") ??
    clippedText(element).slice(0, 512);
  return name || undefined;
}

function targetFor(
  element: Element,
  rank: number,
  selection: Rect,
): TargetCandidate {
  const box = element.getBoundingClientRect();
  const html = element as HTMLElement;
  const computed = getComputedStyle(element);
  const area = Math.max(1, box.width * box.height);
  const overlapWidth = Math.max(
    0,
    Math.min(box.right, selection.x + selection.width) -
      Math.max(box.left, selection.x),
  );
  const overlapHeight = Math.max(
    0,
    Math.min(box.bottom, selection.y + selection.height) -
      Math.max(box.top, selection.y),
  );
  const overlap = Math.min(1, (overlapWidth * overlapHeight) / area);
  const role = roleFor(element);
  const stable = Boolean(html.dataset.testid || element.id || role);
  const attributes: Record<string, string> = Object.fromEntries(
    [...element.attributes]
      .filter(
        ({ name }) =>
          name === "id" ||
          name === "class" ||
          name === "role" ||
          name.startsWith("aria-") ||
          name.startsWith("data-"),
      )
      .slice(0, 20)
      .filter(({ name }) => new TextEncoder().encode(name).length <= 256)
      .map(({ name, value }) => [name, truncateUtf8(value, 2_000)]),
  );
  const styleFacts: Record<string, string> = Object.fromEntries(
    STYLE_PROPERTIES.map(
      (property) =>
        [
          property,
          truncateUtf8(computed.getPropertyValue(property), 1024),
        ] as const,
    ).filter(([, value]) => value.length > 0),
  );
  const boundedSelector = (
    value: string | undefined,
    max: number,
  ): string | undefined =>
    value && new TextEncoder().encode(value).length <= max ? value : undefined;
  return {
    id: crypto.randomUUID(),
    rank,
    tag: truncateUtf8(element.tagName.toLowerCase(), 64),
    text: clippedText(element),
    rect: { x: box.x, y: box.y, width: box.width, height: box.height },
    selectors: {
      testId: boundedSelector(html.dataset.testid, 256),
      id: boundedSelector(element.id, 256),
      css: boundedSelector(selectorFor(element), 2048),
      role: boundedSelector(role, 128),
      accessibleName: boundedSelector(accessibleName(element), 512),
    },
    attributes,
    domSnippet: truncateUtf8(element.outerHTML, 12_288),
    styleFacts,
    score: Math.min(
      1,
      overlap * 0.65 + (stable ? 0.25 : 0) + (clippedText(element) ? 0.1 : 0),
    ),
  };
}

function candidatesFor(rect: Rect): TargetCandidate[] {
  const elements: Element[] = [];
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_ELEMENT,
  );
  let scanned = 0;
  while (walker.nextNode() && scanned++ < MAX_SCANNED_ELEMENTS) {
    const element = walker.currentNode as Element;
    if (element.closest(`#${OVERLAY_ID}`) || elements.includes(element))
      continue;
    const box = element.getBoundingClientRect();
    if (box.width > 0 && box.height > 0 && intersects(rect, box))
      elements.push(element);
  }
  return elements
    .map((element, index) => targetFor(element, index + 1, rect))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map((target, index) => ({ ...target, rank: index + 1 }));
}

function rectFromDrag(drag: Drag): Rect {
  return {
    x: Math.min(drag.startX, drag.currentX),
    y: Math.min(drag.startY, drag.currentY),
    width: Math.abs(drag.currentX - drag.startX),
    height: Math.abs(drag.currentY - drag.startY),
  };
}

class CaptureOverlay {
  private readonly host: HTMLDivElement;
  private readonly shadow: ShadowRoot;
  private readonly layer: HTMLDivElement;
  private readonly toolbar: HTMLDivElement;
  private annotations: DraftAnnotation[] = [];
  private drag: Drag | undefined;
  private sending = false;
  public get isActive(): boolean {
    return this.host.isConnected;
  }

  public constructor() {
    this.host = document.createElement("div");
    this.host.id = OVERLAY_ID;
    this.shadow = this.host.attachShadow({ mode: "closed" });
    this.shadow.innerHTML = `<style>${this.styles()}</style>`;
    this.layer = document.createElement("div");
    this.layer.className = "layer";
    this.toolbar = document.createElement("div");
    this.toolbar.className = "toolbar";
    this.shadow.append(this.layer, this.toolbar);
    document.documentElement.append(this.host);
    this.renderToolbar();
    this.bind();
  }

  public destroy(): void {
    this.drag = undefined;
    if (this.resizeTimer) window.clearTimeout(this.resizeTimer);
    document.removeEventListener("keydown", this.onKeydown, true);
    window.removeEventListener("scroll", this.onScroll, true);
    window.removeEventListener("resize", this.onResize);
    this.host.remove();
  }

  private bind(): void {
    this.layer.addEventListener("pointerdown", (event) => {
      if (
        event.button !== 0 ||
        !event.isPrimary ||
        this.sending ||
        this.drag ||
        this.annotations.length >= 50
      )
        return;
      if ((event.target as HTMLElement).closest(".annotation-ui")) return;
      event.preventDefault();
      event.stopPropagation();
      this.drag = {
        startX: event.clientX,
        startY: event.clientY,
        currentX: event.clientX,
        currentY: event.clientY,
      };
      this.layer.setPointerCapture(event.pointerId);
    });
    this.layer.addEventListener("pointermove", (event) => {
      if (!this.drag) return;
      this.drag.currentX = event.clientX;
      this.drag.currentY = event.clientY;
      this.renderDraft(rectFromDrag(this.drag));
    });
    this.layer.addEventListener("pointerup", (event) => {
      if (!this.drag) return;
      const drag = {
        ...this.drag,
        currentX: event.clientX,
        currentY: event.clientY,
      };
      this.drag = undefined;
      if (this.layer.hasPointerCapture(event.pointerId))
        this.layer.releasePointerCapture(event.pointerId);
      this.shadow.querySelector(".draft")?.remove();
      const rect = rectFromDrag(drag);
      if (rect.width < 4 || rect.height < 4) {
        this.toolbar.dataset.error = "Drag a larger region to select it.";
        return;
      }
      try {
        this.addAnnotation(rect, "drag");
      } catch (error) {
        this.toolbar.dataset.error =
          error instanceof Error
            ? error.message
            : "Cannot inspect this region. Try another.";
      }
    });
    const cancelDrag = () => {
      this.drag = undefined;
      this.shadow.querySelector(".draft")?.remove();
    };
    this.layer.addEventListener("pointercancel", () => {
      cancelDrag();
    });
    this.layer.addEventListener("lostpointercapture", () => {
      cancelDrag();
    });
    document.addEventListener("keydown", this.onKeydown, true);
    window.addEventListener("scroll", this.onScroll, true);
    window.addEventListener("resize", this.onResize);
  }

  private resizeTimer: number | undefined;

  private readonly onScroll = (): void => this.render();

  private readonly onResize = (): void => {
    if (this.resizeTimer) window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => this.reanchorAnnotations(), 120);
  };

  /** After reflow, snap each outline back onto its element by re-resolving selectors. */
  private reanchorAnnotations(): void {
    for (const annotation of this.annotations) {
      let best: { rect: Rect; distance: number } | undefined;
      const centerX =
        annotation.viewportRect.x + annotation.viewportRect.width / 2;
      const centerY =
        annotation.viewportRect.y + annotation.viewportRect.height / 2;
      for (const target of annotation.targets) {
        let element: Element | null = null;
        try {
          if (target.selectors.testId)
            element = document.querySelector(
              `[data-testid="${CSS.escape(target.selectors.testId)}"]`,
            );
          if (!element && target.selectors.id)
            element = document.getElementById(target.selectors.id);
          if (!element && target.selectors.css)
            element = document.querySelector(target.selectors.css);
        } catch {
          element = null;
        }
        if (!element) continue;
        const box = element.getBoundingClientRect();
        if (box.width < 2 || box.height < 2) continue;
        const distance = Math.hypot(
          box.x + box.width / 2 - centerX,
          box.y + box.height / 2 - centerY,
        );
        if (!best || distance < best.distance)
          best = {
            rect: { x: box.x, y: box.y, width: box.width, height: box.height },
            distance,
          };
      }
      if (best && best.distance < 400) {
        annotation.viewportRect = best.rect;
        annotation.pageRect = {
          ...best.rect,
          x: best.rect.x + scrollX,
          y: best.rect.y + scrollY,
        };
      }
    }
    this.render();
  }

  private readonly onKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") this.destroy();
    if (
      event.key === "Enter" &&
      (event.ctrlKey || event.metaKey) &&
      this.annotations.length
    )
      void this.send();
  };

  private addAnnotation(rect: Rect, selectionMethod: "click" | "drag"): void {
    if (this.sending || this.annotations.length >= 50) return;
    this.annotations.push({
      id: crypto.randomUUID(),
      order: this.annotations.length + 1,
      comment: "",
      selectionMethod,
      viewportRect: rect,
      pageRect: { ...rect, x: rect.x + scrollX, y: rect.y + scrollY },
      scroll: { x: scrollX, y: scrollY },
      targets: candidatesFor(rect),
    });
    this.render();
  }

  private renderDraft(rect: Rect): void {
    let draft = this.shadow.querySelector<HTMLDivElement>(".draft");
    if (!draft) {
      draft = document.createElement("div");
      draft.className = "draft";
      this.layer.append(draft);
    }
    Object.assign(draft.style, {
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  }

  private render(): void {
    this.layer.replaceChildren();
    for (const annotation of this.annotations) {
      const outline = document.createElement("div");
      outline.className = "outline annotation-ui";
      Object.assign(outline.style, {
        left: `${annotation.pageRect.x - scrollX}px`,
        top: `${annotation.pageRect.y - scrollY}px`,
        width: `${annotation.viewportRect.width}px`,
        height: `${annotation.viewportRect.height}px`,
      });
      const marker = document.createElement("button");
      marker.className = "marker annotation-ui";
      marker.type = "button";
      marker.textContent = annotation.comment ? String(annotation.order) : "+";
      marker.setAttribute(
        "aria-label",
        `Add comment to selection ${annotation.order}`,
      );
      marker.addEventListener("click", (event) => {
        event.stopPropagation();
        this.openComment(annotation, outline);
      });
      outline.append(marker);
      this.layer.append(outline);
    }
    this.renderToolbar();
  }

  private openComment(annotation: DraftAnnotation, outline: HTMLElement): void {
    outline.querySelector(".composer")?.remove();
    const composer = document.createElement("div");
    composer.className = "composer annotation-ui";
    const textarea = document.createElement("textarea");
    textarea.placeholder = "What should change?";
    textarea.maxLength = 4_000;
    textarea.value = annotation.comment;
    textarea.addEventListener("input", () => {
      annotation.comment = truncateUtf8(textarea.value, 4000);
      this.renderToolbar();
    });
    const close = document.createElement("button");
    close.type = "button";
    close.className = "close";
    close.textContent = "✕";
    close.setAttribute("aria-label", "Close comment (text is kept)");
    close.addEventListener("click", () => {
      annotation.comment = truncateUtf8(textarea.value.trim(), 4000);
      this.render();
    });
    const done = document.createElement("button");
    done.type = "button";
    done.textContent = "Done";
    done.addEventListener("click", () => {
      annotation.comment = truncateUtf8(textarea.value.trim(), 4000);
      this.render();
    });
    composer.append(close, textarea, done);
    outline.append(composer);
    textarea.focus();
  }

  private renderToolbar(): void {
    this.toolbar.replaceChildren();
    const count = document.createElement("span");
    count.textContent = `${this.annotations.length} annotation${this.annotations.length === 1 ? "" : "s"}`;
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => this.destroy());
    const send = document.createElement("button");
    send.type = "button";
    send.className = "primary";
    send.textContent = this.sending ? "Sending…" : "Send to agent";
    send.disabled = this.sending || this.annotations.length === 0;
    send.addEventListener("click", () => void this.send());
    this.toolbar.append(count, cancel, send);
  }

  private async send(): Promise<void> {
    if (this.sending || !this.isActive || !this.annotations.length) return;
    this.sending = true;
    delete this.toolbar.dataset.error;
    this.renderToolbar();
    try {
      const parsed = captureSessionSchema.safeParse({
        schemaVersion: SCHEMA_VERSION,
        id: crypto.randomUUID(),
        capturedAt: new Date().toISOString(),
        status: "pending",
        page: {
          url: location.href,
          title: truncateUtf8(document.title, 1000),
          viewport: {
            width: innerWidth,
            height: innerHeight,
            devicePixelRatio,
          },
          scroll: { x: scrollX, y: scrollY },
          colorScheme: matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light",
        },
        annotations: this.annotations,
        relationships: [],
      });
      if (!parsed.success)
        throw new Error(
          "This selection exceeds capture limits. Select fewer or smaller regions and retry.",
        );
      const capture = normalizeWireCapture(parsed.data);
      const response: { ok: boolean; error?: string } =
        await browser.runtime.sendMessage({
          type: "send-capture",
          capture,
        } satisfies BackgroundRequest);
      if (!response?.ok)
        throw new Error(response?.error ?? "Unable to send capture.");
      this.destroy();
    } catch (error) {
      this.toolbar.dataset.error =
        error instanceof Error
          ? error.message
          : "Unable to send capture. Open companion options and retry.";
    } finally {
      this.sending = false;
      if (this.isActive) this.renderToolbar();
    }
  }

  private styles(): string {
    return `
      :host { all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; font-family: Inter, system-ui, sans-serif; }
      * { box-sizing: border-box; }
      .layer { position: fixed; inset: 0; pointer-events: auto; cursor: crosshair; background: rgba(15,23,42,.08); }
      .draft, .outline { position: fixed; border: 2px solid #38bdf8; background: rgba(56,189,248,.08); box-shadow: 0 0 0 1px rgba(15,23,42,.25); }
      .draft { pointer-events: none; border-style: dashed; }
      .marker { position: absolute; right: -14px; top: -14px; width: 28px; height: 28px; padding: 0; border: 2px solid white; border-radius: 50%; color: white; background: #0284c7; font-weight: 800; font: 800 14px/1 inherit; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
      .composer { position: absolute; right: -2px; top: 34px; width: 300px; padding: 34px 10px 10px; border-radius: 12px; background: #0f172a; box-shadow: 0 16px 40px rgba(2,6,23,.35); cursor: default; }
      .composer .close { position: absolute; top: 6px; right: 8px; padding: 2px 9px; border-radius: 6px; background: #1e293b; color: #fca5a5; font: 700 12px/1 inherit; }
      .composer .close:hover { color: #fecaca; background: #334155; }
      .toolbar { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); display: flex; align-items: center; gap: 10px; min-width: 330px; padding: 8px 10px 8px 14px; border: 1px solid rgba(255,255,255,.14); border-radius: 999px; color: #f8fafc; background: rgba(15,23,42,.96); box-shadow: 0 14px 36px rgba(2,6,23,.34); pointer-events: auto; cursor: default; }
      .composer textarea { width: 100%; min-height: 92px; resize: vertical; padding: 9px; border: 1px solid #475569; border-radius: 8px; color: #f8fafc; background: #1e293b; font: 13px/1.45 inherit; }
      .composer > button:not(.close) { float: right; margin-top: 8px; }
      .toolbar span { flex: 1; font-size: 13px; font-weight: 650; }
      button { padding: 7px 11px; border: 0; border-radius: 999px; color: #e2e8f0; background: #334155; font: 600 12px/1 inherit; cursor: pointer; }
      button.primary { color: #082f49; background: #7dd3fc; }
      button:disabled { opacity: .45; cursor: not-allowed; }
      .toolbar[data-error]::before { content: attr(data-error); position: absolute; left: 0; right: 0; bottom: calc(100% + 8px); padding: 8px 12px; border-radius: 8px; color: white; background: #be123c; }
    `;
  }
}

let activeOverlay: CaptureOverlay | undefined;

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_idle",
  main() {
    browser.runtime.onMessage.addListener((message: ContentRequest, sender) => {
      if (
        sender.id !== browser.runtime.id ||
        sender.tab ||
        !message ||
        typeof message !== "object"
      )
        return;
      if (message.type === "start-capture") {
        if (activeOverlay?.isActive) return;
        try {
          activeOverlay = new CaptureOverlay();
        } catch {
          activeOverlay?.destroy();
          activeOverlay = undefined;
        }
      }
      if (message.type === "cancel-capture") {
        activeOverlay?.destroy();
        activeOverlay = undefined;
      }
    });
  },
});

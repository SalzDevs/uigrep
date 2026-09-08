/** Queue panel — batch review list + send (decision 6). */

import type { Annotation, FeedbackSession } from "@uigrep/schema";
import {
  attachShadowUi,
  UI_STYLES,
  type UiHandle,
} from "./shared";

export interface QueuePanelOptions {
  getSession(): Promise<FeedbackSession | null>;
  onSend(session: FeedbackSession): Promise<void>;
  onDelete(annotationId: string): Promise<void>;
  onHighlight(annotation: Annotation): void;
  /** Pull server-side statuses before each render (verify loop sync) */
  syncStatuses(): Promise<void>;
  /** Human confirms fixed → re-capture evidence, mark verified */
  onVerify(annotation: Annotation): Promise<void>;
  /** Human says still broken → re-capture, reopen for the agent */
  onReopen(annotation: Annotation): Promise<void>;
}

const STATUS_ORDER: Record<Annotation["status"], number> = {
  open: 0,
  sent: 1,
  fixed: 2,
  verified: 3,
  dismissed: 4,
};

export class QueuePanel {
  private ui: UiHandle | null = null;
  private options: QueuePanelOptions;

  constructor(options: QueuePanelOptions) {
    this.options = options;
  }

  get isOpen(): boolean {
    return this.ui !== null;
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else void this.open();
  }

  close(): void {
    this.ui?.destroy();
    this.ui = null;
  }

  async open(): Promise<void> {
    if (this.ui) this.close();
    this.ui = attachShadowUi();
    const style = document.createElement("style");
    style.textContent = UI_STYLES;
    this.ui.root.append(style);
    await this.render();
  }

  async refresh(): Promise<void> {
    if (this.ui) await this.render();
  }

  private async render(): Promise<void> {
    const root = this.ui!.root;
    root.querySelectorAll(".ug-panel").forEach((el) => el.remove());
    await this.options.syncStatuses();
    const session = await this.options.getSession();

    const panel = document.createElement("div");
    panel.className = "ug-panel";

    const annotations = [...(session?.annotations ?? [])].sort(
      (a, b) =>
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
        a.createdAt.localeCompare(b.createdAt),
    );

    const sendable = annotations.some((a) => a.status === "open");

    panel.innerHTML = `
      <div class="ug-header">
        <span>uigrep · ${annotations.length} annotation${annotations.length === 1 ? "" : "s"}</span>
        <span style="cursor:pointer" data-act="close">✕</span>
      </div>
      ${
        annotations.length === 0
          ? `<div class="ug-empty">No annotations yet.<br>Press Alt+Shift+U and click an element.</div>`
          : `<ul class="ug-list">${annotations
              .map((a) => {
                const actions =
                  a.status === "fixed"
                    ? `
                <div style="display:flex;gap:6px;margin-top:6px">
                  <button class="ug-btn ug-btn-primary" style="padding:4px 10px;font-size:11px" data-act="verify" data-id="${a.id}">✓ Fixed</button>
                  <button class="ug-btn ug-btn-ghost" style="padding:4px 10px;font-size:11px" data-act="reopen" data-id="${a.id}">Still broken</button>
                </div>`
                    : "";
                return `
            <li class="ug-item" data-id="${a.id}">
              <img class="ug-thumb" src="${a.screenshot}" alt="">
              <div class="ug-body">
                <span class="ug-status" data-status="${a.status}">${a.status}</span>
                <span class="ug-selector" title="${a.element.selector}">${a.element.selector}</span>
                <div class="ug-comment">${escapeHtml(a.comment)}</div>
                ${actions}
              </div>
              <button class="ug-del" title="Delete">✕</button>
            </li>`;
              })
              .join("")}</ul>`
      }
      <div class="ug-footer">
        <button class="ug-btn ug-btn-primary" data-act="send" ${sendable ? "" : "disabled style='opacity:0.4;cursor:default'"}>
          Send to agent
        </button>
      </div>
    `;
    root.append(panel);

    panel.addEventListener("click", async (e) => {
      const target = e.target as HTMLElement;
      const act = target.closest("[data-act]")?.getAttribute("data-act");
      if (act === "close") return this.close();
      if (act === "send" && session) {
        await this.options.onSend(session);
        return;
      }
      const item = target.closest(".ug-item");
      if (!item) return;
      const id = item.getAttribute("data-id")!;
      const annotation = session!.annotations.find((a) => a.id === id);
      if (target.classList.contains("ug-del") && annotation) {
        await this.options.onDelete(id);
        await this.render();
        return;
      }
      if (annotation && act === "verify") {
        target.setAttribute("disabled", "true");
        target.textContent = "verifying…";
        await this.options.onVerify(annotation);
        await this.render();
        return;
      }
      if (annotation && act === "reopen") {
        target.setAttribute("disabled", "true");
        await this.options.onReopen(annotation);
        await this.render();
        return;
      }
      if (annotation) {
        this.options.onHighlight(annotation);
      }
    });
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

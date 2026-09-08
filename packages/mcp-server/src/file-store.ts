/**
 * FileFeedbackStore — durable variant of the in-memory store.
 * Persists to ~/.uigrep/feedback.json so sessions survive server restarts.
 * Durable *queue* state stays in browser storage (decision 8); this holds
 * what has been sent to agents.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { FeedbackSession } from "@uigrep/schema";
import { InMemoryFeedbackStore } from "./store.ts";

export class FileFeedbackStore extends InMemoryFeedbackStore {
  private readonly filePath: string;
  private loaded = false;

  constructor(filePath?: string) {
    super();
    this.filePath =
      filePath ?? join(homedir(), ".uigrep", "feedback.json");
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (Array.isArray(raw.sessions)) {
        for (const session of raw.sessions as FeedbackSession[]) {
          await super.putSession(session);
        }
      }
    } catch {
      // missing/corrupt file → start clean
    }
  }

  private persist(): void {
    const sessions = (
      this as unknown as { sessions: Map<string, FeedbackSession> }
    ).sessions;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(
      this.filePath,
      JSON.stringify({ sessions: [...sessions.values()] }, null, 2),
    );
  }

  override async putSession(session: FeedbackSession): Promise<void> {
    await this.load();
    await super.putSession(session);
    this.persist();
  }

  override async markFixed(
    annotationId: string,
    afterScreenshot?: string,
  ): Promise<void> {
    await this.load();
    await super.markFixed(annotationId, afterScreenshot);
    this.persist();
  }

  override async dismiss(annotationId: string): Promise<void> {
    await this.load();
    await super.dismiss(annotationId);
    this.persist();
  }

  override async markVerified(annotationId: string): Promise<void> {
    await this.load();
    await super.markVerified(annotationId);
    this.persist();
  }
}

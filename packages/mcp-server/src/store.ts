/**
 * Feedback store — where the extension delivers sessions and the agent reads
 * them. In-memory for phase 2; the phase-5 transport bridge will push into
 * whatever implementation is wired here.
 *
 * Decision 8 puts durable queue state in browser storage; this store holds
 * what has been *sent* to agents. Keep it swappable.
 */

import type { Annotation, FeedbackSession } from "@uigrep/schema";

export interface FeedbackStore {
  /** Extension pushes a full session (batch send, decision 6) */
  putSession(session: FeedbackSession): Promise<void>;
  /** Agent pulls: sessions with annotations not yet fixed/verified/dismissed */
  getPendingSessions(): Promise<FeedbackSession[]>;
  /** Agent claims work done on an annotation → status "fixed" */
  markFixed(annotationId: string, afterScreenshot?: string): Promise<void>;
  /** Human dismissed via extension UI */
  dismiss(annotationId: string): Promise<void>;
  /** Extension verify flow: re-capture evidence → status "verified" */
  markVerified(annotationId: string): Promise<void>;
}

export class InMemoryFeedbackStore implements FeedbackStore {
  private sessions = new Map<string, FeedbackSession>();

  async putSession(session: FeedbackSession): Promise<void> {
    this.sessions.set(session.id, structuredClone(session));
  }

  async getPendingSessions(): Promise<FeedbackSession[]> {
    return [...this.sessions.values()]
      .map((s) => ({
        ...s,
        annotations: s.annotations.filter(
          (a: Annotation) => a.status === "open" || a.status === "sent",
        ),
      }))
      .filter((s) => s.annotations.length > 0);
  }

  async markFixed(annotationId: string, afterScreenshot?: string): Promise<void> {
    this.updateAnnotation(annotationId, (a) => ({
      ...a,
      status: "fixed",
      iteration: a.iteration + 1,
      updatedAt: new Date().toISOString(),
      afterScreenshot: afterScreenshot ?? a.afterScreenshot,
    }));
  }

  async dismiss(annotationId: string): Promise<void> {
    this.updateAnnotation(annotationId, (a) => ({
      ...a,
      status: "dismissed",
      updatedAt: new Date().toISOString(),
    }));
  }

  async markVerified(annotationId: string): Promise<void> {
    this.updateAnnotation(annotationId, (a) => ({
      ...a,
      status: "verified",
      updatedAt: new Date().toISOString(),
    }));
  }

  private updateAnnotation(
    annotationId: string,
    fn: (a: Annotation) => Annotation,
  ): void {
    for (const [id, session] of this.sessions) {
      const idx = session.annotations.findIndex((a) => a.id === annotationId);
      if (idx === -1) continue;
      const annotations = [...session.annotations];
      annotations[idx] = fn(annotations[idx]);
      this.sessions.set(id, { ...session, annotations });
      return;
    }
    throw new Error(`Unknown annotation: ${annotationId}`);
  }
}

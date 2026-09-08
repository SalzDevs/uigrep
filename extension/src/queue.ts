/**
 * Queue persistence — browser storage (decision 8), keyed by page URL.
 * One session per URL; annotations accumulate across pick sessions.
 * Payload IDs/timestamps everywhere = future paid-tier insurance (decision 11).
 */

import {
  annotationSchema,
  feedbackSessionSchema,
  type Annotation,
  type AnnotationStatus,
  type FeedbackSession,
} from "@uigrep/schema";

const STORAGE_KEY = "uigrep:sessions";

interface SessionIndex {
  [sessionKey: string]: FeedbackSession;
}

/** sessionKey = origin + pathname (query excluded: params churn breaks keys) */
export function sessionKeyFor(url: string): string {
  const u = new URL(url);
  return `${u.origin}${u.pathname}`;
}

export function newId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

async function readIndex(): Promise<SessionIndex> {
  const result = await browser.storage.local.get(STORAGE_KEY);
  return (result[STORAGE_KEY] as SessionIndex | undefined) ?? {};
}

async function writeIndex(index: SessionIndex): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY]: index });
}

export async function getSession(url: string): Promise<FeedbackSession | null> {
  const index = await readIndex();
  return index[sessionKeyFor(url)] ?? null;
}

export async function listSessions(): Promise<FeedbackSession[]> {
  return Object.values(await readIndex());
}

/** Removes annotations in terminal states from every session. */
export async function pruneResolved(): Promise<void> {
  const index = await readIndex();
  for (const [key, session] of Object.entries(index)) {
    const annotations = session.annotations.filter(
      (a) => a.status === "open" || a.status === "sent" || a.status === "fixed",
    );
    if (annotations.length === 0) delete index[key];
    else index[key] = { ...session, annotations, updatedAt: nowIso() };
  }
  await writeIndex(index);
}

export async function addAnnotation(
  url: string,
  pageTitle: string | undefined,
  viewport: FeedbackSession["viewport"],
  annotation: Omit<Annotation, "id" | "sessionId" | "iteration" | "status" | "createdAt" | "updatedAt">,
): Promise<Annotation> {
  const index = await readIndex();
  const key = sessionKeyFor(url);
  const existing = index[key];

  const full: Annotation = annotationSchema.parse({
    ...annotation,
    id: newId(),
    sessionId: existing?.id ?? newId(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });

  if (!existing) {
    index[key] = feedbackSessionSchema.parse({
      id: full.sessionId,
      url,
      pageTitle,
      viewport,
      annotations: [full],
      createdAt: full.createdAt,
      updatedAt: full.updatedAt,
    });
  } else {
    index[key] = {
      ...existing,
      pageTitle: pageTitle ?? existing.pageTitle,
      annotations: [...existing.annotations, full],
      updatedAt: full.updatedAt,
    };
  }

  await writeIndex(index);
  return full;
}

export async function updateAnnotationStatus(
  annotationId: string,
  status: AnnotationStatus,
  extra: Partial<Pick<Annotation, "afterScreenshot">> = {},
): Promise<void> {
  const index = await readIndex();
  for (const [, session] of Object.entries(index)) {
    const idx = session.annotations.findIndex((a) => a.id === annotationId);
    if (idx === -1) continue;
    const annotations = [...session.annotations];
    annotations[idx] = annotationSchema.parse({
      ...annotations[idx],
      status,
      updatedAt: nowIso(),
      ...extra,
    });
    await writeIndex({
      ...index,
      [sessionKeyFor(session.url)]: {
        ...session,
        annotations,
        updatedAt: nowIso(),
      },
    });
    return;
  }
  throw new Error(`Unknown annotation: ${annotationId}`);
}

export async function removeAnnotation(annotationId: string): Promise<void> {
  const index = await readIndex();
  for (const [key, session] of Object.entries(index)) {
    const annotations = session.annotations.filter((a) => a.id !== annotationId);
    if (annotations.length === session.annotations.length) continue;
    if (annotations.length === 0) delete index[key];
    else
      index[key] = {
        ...session,
        annotations,
        updatedAt: nowIso(),
      };
    break;
  }
  await writeIndex(index);
}

/**
 * Marks every open annotation in the session as sent — batch delivery
 * (decision 6). Called by phase 5's transport bridge on successful push.
 */
export async function markSessionSent(url: string): Promise<void> {
  const session = await getSession(url);
  if (!session) return;
  const annotations = session.annotations.map((a) =>
    a.status === "open"
      ? annotationSchema.parse({ ...a, status: "sent", updatedAt: nowIso() })
      : a,
  );
  const index = await readIndex();
  await writeIndex({
    ...index,
    [sessionKeyFor(url)]: { ...session, annotations, updatedAt: nowIso() },
  });
}

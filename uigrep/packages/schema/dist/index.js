import { z } from 'zod';
export const SCHEMA_VERSION = '1.0.0';
export const CONTEXT_BUDGETS = {
    efficient: {
        manifestBytes: 2_048,
        annotationBytes: 1_024,
        rankedTargets: 5,
        ancestorDepth: 3,
        domBytes: 2_048,
        styleFacts: 20,
    },
    balanced: {
        manifestBytes: 4_096,
        annotationBytes: 2_048,
        rankedTargets: 10,
        ancestorDepth: 5,
        domBytes: 4_096,
        styleFacts: 40,
    },
    deep: {
        manifestBytes: 8_192,
        annotationBytes: 4_096,
        rankedTargets: 20,
        ancestorDepth: 8,
        domBytes: 12_288,
        styleFacts: 100,
    },
};
export const contextModeSchema = z.enum(['efficient', 'balanced', 'deep']);
export const rectSchema = z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().nonnegative(),
    height: z.number().finite().nonnegative(),
});
export const selectorSetSchema = z.object({
    testId: z.string().max(256).optional(),
    id: z.string().max(256).optional(),
    css: z.string().max(2_048).optional(),
    xpath: z.string().max(2_048).optional(),
    role: z.string().max(128).optional(),
    accessibleName: z.string().max(512).optional(),
});
export const targetCandidateSchema = z.object({
    id: z.string().uuid(),
    rank: z.number().int().min(1),
    tag: z.string().max(64),
    text: z.string().max(2_000),
    rect: rectSchema,
    selectors: selectorSetSchema,
    attributes: z.record(z.string(), z.string().max(2_000)).default({}),
    domSnippet: z.string().max(12_288),
    styleFacts: z.record(z.string(), z.string().max(1_024)).default({}),
    score: z.number().min(0).max(1),
});
export const screenshotRefSchema = z.object({
    resourceUri: z.string().startsWith('uigrep://'),
    mimeType: z.enum(['image/png', 'image/webp', 'image/jpeg']),
    byteLength: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
});
export const annotationSchema = z.object({
    id: z.string().uuid(),
    order: z.number().int().positive(),
    comment: z.string().max(4_000).default(''),
    selectionMethod: z.enum(['click', 'drag']),
    viewportRect: rectSchema,
    pageRect: rectSchema,
    scroll: z.object({ x: z.number().finite(), y: z.number().finite() }),
    screenshot: screenshotRefSchema.optional(),
    targets: z.array(targetCandidateSchema).max(20),
    hasMoreTargets: z.boolean().default(false),
    status: z.enum(['pending', 'in_progress', 'resolved', 'blocked']).default('pending'),
});
export const annotationRelationshipSchema = z.object({
    type: z.enum(['reference', 'match', 'align', 'preserve', 'avoid-changing']),
    sourceAnnotationId: z.string().uuid(),
    targetAnnotationId: z.string().uuid(),
    properties: z.array(z.string().max(128)).max(20).default([]),
});
export const captureSessionSchema = z.object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    id: z.string().uuid(),
    capturedAt: z.string().datetime(),
    status: z.enum(['draft', 'pending', 'in_progress', 'resolved', 'blocked']),
    page: z.object({
        url: z.string().url().max(8_192),
        title: z.string().max(1_000),
        viewport: z.object({
            width: z.number().int().positive(),
            height: z.number().int().positive(),
            devicePixelRatio: z.number().positive().max(10),
        }),
        scroll: z.object({ x: z.number().finite(), y: z.number().finite() }),
        colorScheme: z.enum(['light', 'dark', 'no-preference']),
    }),
    annotations: z.array(annotationSchema).min(1).max(50),
    relationships: z.array(annotationRelationshipSchema).max(100).default([]),
});
export const captureManifestSchema = captureSessionSchema
    .pick({ schemaVersion: true, id: true, capturedAt: true, status: true, page: true })
    .extend({
    annotations: z.array(annotationSchema.pick({ id: true, order: true, comment: true, status: true }).extend({
        targetSummary: z.string().max(500),
    })),
    relationshipCount: z.number().int().nonnegative(),
});
export const daemonEventSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('start_capture') }),
    z.object({ type: z.literal('cancel_capture') }),
    z.object({ type: z.literal('state_changed'), state: z.enum(['ready', 'selecting', 'sending', 'sent', 'error', 'paused']), annotationCount: z.number().int().nonnegative().optional() }),
    z.object({ type: z.literal('capture_stored'), sessionId: z.string().uuid() }),
]);
export function summarizeTarget(target) {
    if (!target)
        return 'Visual region';
    const identity = target.selectors.testId ?? target.selectors.accessibleName ?? target.text;
    return [target.tag, identity.trim()].filter(Boolean).join(' · ').slice(0, 500);
}
export function toCaptureManifest(session) {
    return captureManifestSchema.parse({
        ...session,
        annotations: session.annotations.map((annotation) => ({
            id: annotation.id,
            order: annotation.order,
            comment: annotation.comment,
            status: annotation.status,
            targetSummary: summarizeTarget(annotation.targets[0]),
        })),
        relationshipCount: session.relationships.length,
    });
}
//# sourceMappingURL=index.js.map
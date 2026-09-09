import { z } from 'zod';
export declare const SCHEMA_VERSION: "1.0.0";
export declare const CONTEXT_BUDGETS: {
    readonly efficient: {
        readonly manifestBytes: 2048;
        readonly annotationBytes: 1024;
        readonly rankedTargets: 5;
        readonly ancestorDepth: 3;
        readonly domBytes: 2048;
        readonly styleFacts: 20;
    };
    readonly balanced: {
        readonly manifestBytes: 4096;
        readonly annotationBytes: 2048;
        readonly rankedTargets: 10;
        readonly ancestorDepth: 5;
        readonly domBytes: 4096;
        readonly styleFacts: 40;
    };
    readonly deep: {
        readonly manifestBytes: 8192;
        readonly annotationBytes: 4096;
        readonly rankedTargets: 20;
        readonly ancestorDepth: 8;
        readonly domBytes: 12288;
        readonly styleFacts: 100;
    };
};
export declare const contextModeSchema: z.ZodEnum<{
    efficient: "efficient";
    balanced: "balanced";
    deep: "deep";
}>;
export type ContextMode = z.infer<typeof contextModeSchema>;
export declare const rectSchema: z.ZodObject<{
    x: z.ZodNumber;
    y: z.ZodNumber;
    width: z.ZodNumber;
    height: z.ZodNumber;
}, z.core.$strip>;
export type Rect = z.infer<typeof rectSchema>;
export declare const selectorSetSchema: z.ZodObject<{
    testId: z.ZodOptional<z.ZodString>;
    id: z.ZodOptional<z.ZodString>;
    css: z.ZodOptional<z.ZodString>;
    xpath: z.ZodOptional<z.ZodString>;
    role: z.ZodOptional<z.ZodString>;
    accessibleName: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const targetCandidateSchema: z.ZodObject<{
    id: z.ZodString;
    rank: z.ZodNumber;
    tag: z.ZodString;
    text: z.ZodString;
    rect: z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
        width: z.ZodNumber;
        height: z.ZodNumber;
    }, z.core.$strip>;
    selectors: z.ZodObject<{
        testId: z.ZodOptional<z.ZodString>;
        id: z.ZodOptional<z.ZodString>;
        css: z.ZodOptional<z.ZodString>;
        xpath: z.ZodOptional<z.ZodString>;
        role: z.ZodOptional<z.ZodString>;
        accessibleName: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    attributes: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
    domSnippet: z.ZodString;
    styleFacts: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
    score: z.ZodNumber;
}, z.core.$strip>;
export type TargetCandidate = z.infer<typeof targetCandidateSchema>;
export declare const screenshotRefSchema: z.ZodObject<{
    resourceUri: z.ZodString;
    mimeType: z.ZodEnum<{
        "image/png": "image/png";
        "image/webp": "image/webp";
        "image/jpeg": "image/jpeg";
    }>;
    byteLength: z.ZodNumber;
    width: z.ZodNumber;
    height: z.ZodNumber;
}, z.core.$strip>;
export declare const annotationSchema: z.ZodObject<{
    id: z.ZodString;
    order: z.ZodNumber;
    comment: z.ZodDefault<z.ZodString>;
    selectionMethod: z.ZodEnum<{
        click: "click";
        drag: "drag";
    }>;
    viewportRect: z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
        width: z.ZodNumber;
        height: z.ZodNumber;
    }, z.core.$strip>;
    pageRect: z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
        width: z.ZodNumber;
        height: z.ZodNumber;
    }, z.core.$strip>;
    scroll: z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, z.core.$strip>;
    screenshot: z.ZodOptional<z.ZodObject<{
        resourceUri: z.ZodString;
        mimeType: z.ZodEnum<{
            "image/png": "image/png";
            "image/webp": "image/webp";
            "image/jpeg": "image/jpeg";
        }>;
        byteLength: z.ZodNumber;
        width: z.ZodNumber;
        height: z.ZodNumber;
    }, z.core.$strip>>;
    targets: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        rank: z.ZodNumber;
        tag: z.ZodString;
        text: z.ZodString;
        rect: z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
            width: z.ZodNumber;
            height: z.ZodNumber;
        }, z.core.$strip>;
        selectors: z.ZodObject<{
            testId: z.ZodOptional<z.ZodString>;
            id: z.ZodOptional<z.ZodString>;
            css: z.ZodOptional<z.ZodString>;
            xpath: z.ZodOptional<z.ZodString>;
            role: z.ZodOptional<z.ZodString>;
            accessibleName: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
        attributes: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
        domSnippet: z.ZodString;
        styleFacts: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
        score: z.ZodNumber;
    }, z.core.$strip>>;
    hasMoreTargets: z.ZodDefault<z.ZodBoolean>;
    status: z.ZodDefault<z.ZodEnum<{
        pending: "pending";
        in_progress: "in_progress";
        resolved: "resolved";
        blocked: "blocked";
    }>>;
}, z.core.$strip>;
export type Annotation = z.infer<typeof annotationSchema>;
export declare const annotationRelationshipSchema: z.ZodObject<{
    type: z.ZodEnum<{
        reference: "reference";
        match: "match";
        align: "align";
        preserve: "preserve";
        "avoid-changing": "avoid-changing";
    }>;
    sourceAnnotationId: z.ZodString;
    targetAnnotationId: z.ZodString;
    properties: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export declare const captureSessionSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<"1.0.0">;
    id: z.ZodString;
    capturedAt: z.ZodString;
    status: z.ZodEnum<{
        pending: "pending";
        in_progress: "in_progress";
        resolved: "resolved";
        blocked: "blocked";
        draft: "draft";
    }>;
    page: z.ZodObject<{
        url: z.ZodString;
        title: z.ZodString;
        viewport: z.ZodObject<{
            width: z.ZodNumber;
            height: z.ZodNumber;
            devicePixelRatio: z.ZodNumber;
        }, z.core.$strip>;
        scroll: z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, z.core.$strip>;
        colorScheme: z.ZodEnum<{
            light: "light";
            dark: "dark";
            "no-preference": "no-preference";
        }>;
    }, z.core.$strip>;
    annotations: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        order: z.ZodNumber;
        comment: z.ZodDefault<z.ZodString>;
        selectionMethod: z.ZodEnum<{
            click: "click";
            drag: "drag";
        }>;
        viewportRect: z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
            width: z.ZodNumber;
            height: z.ZodNumber;
        }, z.core.$strip>;
        pageRect: z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
            width: z.ZodNumber;
            height: z.ZodNumber;
        }, z.core.$strip>;
        scroll: z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, z.core.$strip>;
        screenshot: z.ZodOptional<z.ZodObject<{
            resourceUri: z.ZodString;
            mimeType: z.ZodEnum<{
                "image/png": "image/png";
                "image/webp": "image/webp";
                "image/jpeg": "image/jpeg";
            }>;
            byteLength: z.ZodNumber;
            width: z.ZodNumber;
            height: z.ZodNumber;
        }, z.core.$strip>>;
        targets: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            rank: z.ZodNumber;
            tag: z.ZodString;
            text: z.ZodString;
            rect: z.ZodObject<{
                x: z.ZodNumber;
                y: z.ZodNumber;
                width: z.ZodNumber;
                height: z.ZodNumber;
            }, z.core.$strip>;
            selectors: z.ZodObject<{
                testId: z.ZodOptional<z.ZodString>;
                id: z.ZodOptional<z.ZodString>;
                css: z.ZodOptional<z.ZodString>;
                xpath: z.ZodOptional<z.ZodString>;
                role: z.ZodOptional<z.ZodString>;
                accessibleName: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            attributes: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
            domSnippet: z.ZodString;
            styleFacts: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
            score: z.ZodNumber;
        }, z.core.$strip>>;
        hasMoreTargets: z.ZodDefault<z.ZodBoolean>;
        status: z.ZodDefault<z.ZodEnum<{
            pending: "pending";
            in_progress: "in_progress";
            resolved: "resolved";
            blocked: "blocked";
        }>>;
    }, z.core.$strip>>;
    relationships: z.ZodDefault<z.ZodArray<z.ZodObject<{
        type: z.ZodEnum<{
            reference: "reference";
            match: "match";
            align: "align";
            preserve: "preserve";
            "avoid-changing": "avoid-changing";
        }>;
        sourceAnnotationId: z.ZodString;
        targetAnnotationId: z.ZodString;
        properties: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>>;
}, z.core.$strip>;
export type CaptureSession = z.infer<typeof captureSessionSchema>;
export declare const captureManifestSchema: z.ZodObject<{
    id: z.ZodString;
    status: z.ZodEnum<{
        pending: "pending";
        in_progress: "in_progress";
        resolved: "resolved";
        blocked: "blocked";
        draft: "draft";
    }>;
    schemaVersion: z.ZodLiteral<"1.0.0">;
    capturedAt: z.ZodString;
    page: z.ZodObject<{
        url: z.ZodString;
        title: z.ZodString;
        viewport: z.ZodObject<{
            width: z.ZodNumber;
            height: z.ZodNumber;
            devicePixelRatio: z.ZodNumber;
        }, z.core.$strip>;
        scroll: z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, z.core.$strip>;
        colorScheme: z.ZodEnum<{
            light: "light";
            dark: "dark";
            "no-preference": "no-preference";
        }>;
    }, z.core.$strip>;
    annotations: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        order: z.ZodNumber;
        comment: z.ZodDefault<z.ZodString>;
        status: z.ZodDefault<z.ZodEnum<{
            pending: "pending";
            in_progress: "in_progress";
            resolved: "resolved";
            blocked: "blocked";
        }>>;
        targetSummary: z.ZodString;
    }, z.core.$strip>>;
    relationshipCount: z.ZodNumber;
}, z.core.$strip>;
export type CaptureManifest = z.infer<typeof captureManifestSchema>;
export declare const daemonEventSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"start_capture">;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"cancel_capture">;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"state_changed">;
    state: z.ZodEnum<{
        error: "error";
        ready: "ready";
        selecting: "selecting";
        sending: "sending";
        sent: "sent";
        paused: "paused";
    }>;
    annotationCount: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"capture_stored">;
    sessionId: z.ZodString;
}, z.core.$strip>], "type">;
export type DaemonEvent = z.infer<typeof daemonEventSchema>;
export declare function summarizeTarget(target: TargetCandidate | undefined): string;
export declare function toCaptureManifest(session: CaptureSession): CaptureManifest;
//# sourceMappingURL=index.d.ts.map
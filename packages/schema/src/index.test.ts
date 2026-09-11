import { describe, expect, it } from "vitest";
import {
  captureSessionSchema,
  CONTEXT_BUDGETS,
  SCHEMA_VERSION,
  toCaptureManifest,
} from "./index.js";

const image = {
  resourceUri: "uigrep://captures/550e8400-e29b-41d4-a716-446655440000/a1.png",
  mimeType: "image/png" as const,
  byteLength: 12_400,
  width: 260,
  height: 88,
};

const session = captureSessionSchema.parse({
  schemaVersion: SCHEMA_VERSION,
  id: "550e8400-e29b-41d4-a716-446655440000",
  capturedAt: "2026-09-11T10:24:00.000Z",
  status: "pending",
  app: {
    name: "Ledger",
    bundleId: "com.salzdevs.ledger",
    windowTitle: "Invoices — March",
  },
  annotations: [
    {
      id: "550e8400-e29b-41d4-a716-446655440001",
      order: 1,
      comment: "Total overflows the card.",
      rect: { x: 812, y: 236, width: 184, height: 92 },
      image,
      elements: [
        {
          role: "text",
          label: "$12,480.00",
          identifier: "invoice-total-label",
        },
      ],
    },
  ],
});

describe("capture contracts", () => {
  it("applies safe defaults", () => {
    expect(session.annotations[0]?.elements).toHaveLength(1);
    expect(session.relationships).toEqual([]);
  });

  it("creates a compact manifest", () => {
    const manifest = toCaptureManifest(session);
    expect(manifest.annotations[0]?.comment).toBe(
      session.annotations[0]?.comment,
    );
    expect(JSON.stringify(manifest).length).toBeLessThan(
      CONTEXT_BUDGETS.efficient.manifestBytes * 4,
    );
  });

  it("rejects empty sessions", () => {
    expect(() =>
      captureSessionSchema.parse({ ...session, annotations: [] }),
    ).toThrow();
  });

  it("accepts pixel-only annotations without elements", () => {
    const pixelOnly = captureSessionSchema.parse({
      ...session,
      annotations: [
        {
          id: "550e8400-e29b-41d4-a716-446655440002",
          order: 1,
          comment: "This button is invisible in dark mode",
          rect: { x: 0, y: 0, width: 10, height: 10 },
          image,
        },
      ],
    });
    expect(pixelOnly.annotations[0]?.elements).toEqual([]);
  });
});

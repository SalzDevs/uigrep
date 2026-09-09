import { describe, expect, it } from 'vitest';
import { captureSessionSchema, CONTEXT_BUDGETS, SCHEMA_VERSION, toCaptureManifest } from './index.js';

const session = captureSessionSchema.parse({
  schemaVersion: SCHEMA_VERSION,
  id: '550e8400-e29b-41d4-a716-446655440000',
  capturedAt: '2026-09-09T12:00:00.000Z',
  status: 'pending',
  page: {
    url: 'http://localhost:3000/pricing',
    title: 'Pricing',
    viewport: { width: 1440, height: 900, devicePixelRatio: 1 },
    scroll: { x: 0, y: 0 },
    colorScheme: 'dark',
  },
  annotations: [
    {
      id: '550e8400-e29b-41d4-a716-446655440001',
      order: 1,
      comment: 'Align these cards.',
      selectionMethod: 'drag',
      viewportRect: { x: 100, y: 100, width: 600, height: 300 },
      pageRect: { x: 100, y: 100, width: 600, height: 300 },
      scroll: { x: 0, y: 0 },
      targets: [],
    },
  ],
});

describe('capture contracts', () => {
  it('applies safe defaults', () => {
    expect(session.annotations[0]?.status).toBe('pending');
    expect(session.relationships).toEqual([]);
  });

  it('creates a compact manifest', () => {
    const manifest = toCaptureManifest(session);
    expect(manifest.annotations[0]?.targetSummary).toBe('Visual region');
    expect(JSON.stringify(manifest).length).toBeLessThan(CONTEXT_BUDGETS.efficient.manifestBytes);
  });

  it('rejects empty sessions', () => {
    expect(() => captureSessionSchema.parse({ ...session, annotations: [] })).toThrow();
  });
});

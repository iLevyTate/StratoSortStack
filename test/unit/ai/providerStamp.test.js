'use strict';

jest.mock('../../../src/main/services/ServiceContainer', () => ({
  container: { tryResolve: jest.fn(() => null) },
  ServiceIds: {}
}));

const {
  resolveProviderIdFromRouter,
  stampAnalysisProvider
} = require('../../../src/main/analysis/providerStamp');

describe('resolveProviderIdFromRouter', () => {
  test('returns "local" when router is null', () => {
    expect(resolveProviderIdFromRouter(null)).toBe('local');
  });

  test('returns "local" when router is undefined', () => {
    expect(resolveProviderIdFromRouter(undefined)).toBe('local');
  });

  test('returns the chosen provider id from a working router', () => {
    const router = {
      choose: jest.fn(() => ({ id: 'anthropic' }))
    };
    expect(resolveProviderIdFromRouter(router)).toBe('anthropic');
    expect(router.choose).toHaveBeenCalledWith({
      operation: 'analyze',
      smartFolderId: null
    });
  });

  test('forwards smartFolderId for per-folder overrides', () => {
    const router = { choose: jest.fn(() => ({ id: 'openaiCompatible' })) };
    resolveProviderIdFromRouter(router, 'folder-123');
    expect(router.choose).toHaveBeenCalledWith({
      operation: 'analyze',
      smartFolderId: 'folder-123'
    });
  });

  test('returns "local" when router.choose throws (NO_PROVIDER_READY)', () => {
    const router = {
      choose: jest.fn(() => {
        const err = new Error('No provider ready');
        err.code = 'NO_PROVIDER_READY';
        throw err;
      })
    };
    expect(resolveProviderIdFromRouter(router)).toBe('local');
  });

  test('returns "local" when router.choose returns provider without id', () => {
    const router = { choose: jest.fn(() => ({})) };
    expect(resolveProviderIdFromRouter(router)).toBe('local');
  });
});

describe('stampAnalysisProvider', () => {
  test('stamps provider on a successful analysis object', () => {
    const analysis = { category: 'docs', suggestedName: 'foo' };
    stampAnalysisProvider(analysis, 'anthropic');
    expect(analysis.provider).toBe('anthropic');
  });

  test('does not stamp when analysis has an error', () => {
    const analysis = { error: 'Failed', category: null };
    stampAnalysisProvider(analysis, 'anthropic');
    expect(analysis.provider).toBeUndefined();
  });

  test('returns null/undefined inputs unchanged', () => {
    expect(stampAnalysisProvider(null, 'local')).toBeNull();
    expect(stampAnalysisProvider(undefined, 'local')).toBeUndefined();
  });

  test('returns primitives unchanged (defensive)', () => {
    expect(stampAnalysisProvider('not-an-object', 'local')).toBe('not-an-object');
    expect(stampAnalysisProvider(42, 'local')).toBe(42);
  });

  test('does not stamp when providerId is empty/falsy', () => {
    const analysis = { category: 'docs' };
    stampAnalysisProvider(analysis, '');
    expect(analysis.provider).toBeUndefined();
    stampAnalysisProvider(analysis, null);
    expect(analysis.provider).toBeUndefined();
  });

  test('returns the analysis object so it can be used inline', () => {
    const analysis = { category: 'docs' };
    expect(stampAnalysisProvider(analysis, 'local')).toBe(analysis);
  });

  test('prefers result.provider from documentLlm over pre-call router preview', () => {
    const analysis = { category: 'docs', provider: 'local' };
    stampAnalysisProvider(analysis, 'openaiCompatible');
    expect(analysis.provider).toBe('openaiCompatible');
    const fromResult = { category: 'docs', provider: 'local' };
    const providerId = fromResult.provider || 'openaiCompatible';
    stampAnalysisProvider(fromResult, providerId);
    expect(fromResult.provider).toBe('local');
  });
});

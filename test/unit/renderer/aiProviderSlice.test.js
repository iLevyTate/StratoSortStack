'use strict';
const reducer = require('../../../src/renderer/store/slices/aiProviderSlice').default;
const {
  fetchAiConfig,
  setProviderConfig,
  setProviderKey,
  removeProviderKey,
  testProvider,
  getKeyStatus,
  statusPushed
} = require('../../../src/renderer/store/slices/aiProviderSlice');

describe('aiProviderSlice', () => {
  test('initial state has defaults', () => {
    const s = reducer(undefined, { type: '@@INIT' });
    expect(s.loaded).toBe(false);
    expect(s.settings.providers.local.enabled).toBe(true);
    expect(s.keyStatus.anthropic).toEqual({ hasKey: false, lastFour: null });
  });

  test('fetchAiConfig.fulfilled merges settings + status', () => {
    const s = reducer(
      undefined,
      fetchAiConfig.fulfilled(
        {
          settings: {
            providers: { local: { enabled: true } },
            routing: { default: 'anthropic', perFolder: {} }
          },
          status: {
            providers: [{ id: 'local', enabled: true, ready: true }],
            routing: { default: 'anthropic', perFolder: {} }
          }
        },
        'req'
      )
    );
    expect(s.loaded).toBe(true);
    expect(s.status.routing.default).toBe('anthropic');
  });

  test('setProviderConfig.fulfilled mirrors enabled/model into settings.providers', () => {
    const s = reducer(
      undefined,
      setProviderConfig.fulfilled(
        {
          status: {
            providers: [{ id: 'openaiCompatible', enabled: true, ready: true }],
            routing: { default: 'local', perFolder: {} }
          }
        },
        'req',
        {
          provider: 'openaiCompatible',
          config: { enabled: true, model: 'gpt-4.1-mini', baseUrl: 'https://api.openai.com/v1' }
        }
      )
    );
    expect(s.settings.providers.openaiCompatible.enabled).toBe(true);
    expect(s.settings.providers.openaiCompatible.model).toBe('gpt-4.1-mini');
  });

  test('setProviderKey.fulfilled updates keyStatus with last four', () => {
    const action = setProviderKey.fulfilled(undefined, 'req', {
      provider: 'anthropic',
      key: 'sk-ant-XXXXabcd'
    });
    const s = reducer(undefined, action);
    expect(s.keyStatus.anthropic.hasKey).toBe(true);
    expect(s.keyStatus.anthropic.lastFour).toBe('abcd');
  });

  test('removeProviderKey.fulfilled clears keyStatus', () => {
    const start = reducer(
      undefined,
      setProviderKey.fulfilled(undefined, 'req', {
        provider: 'anthropic',
        key: 'sk-ant-test1234'
      })
    );
    const after = reducer(
      start,
      removeProviderKey.fulfilled(undefined, 'req', {
        provider: 'anthropic'
      })
    );
    expect(after.keyStatus.anthropic).toEqual({ hasKey: false, lastFour: null });
  });

  test('testProvider.fulfilled stores result keyed by provider', () => {
    const s = reducer(
      undefined,
      testProvider.fulfilled(
        { provider: 'anthropic', result: { success: true, ok: true, latencyMs: 234 } },
        'req',
        { provider: 'anthropic' }
      )
    );
    expect(s.testResults.anthropic.ok).toBe(true);
    expect(s.testResults.anthropic.latencyMs).toBe(234);
  });

  test('getKeyStatus.fulfilled updates keyStatus.lastFour', () => {
    const s = reducer(
      undefined,
      getKeyStatus.fulfilled(
        { provider: 'anthropic', status: { hasKey: true, lastFour: '9876' } },
        'req',
        { provider: 'anthropic' }
      )
    );
    expect(s.keyStatus.anthropic).toEqual({ hasKey: true, lastFour: '9876' });
  });

  test('getKeyStatus.rejected surfaces the structured error in lastError', () => {
    const s = reducer(
      undefined,
      getKeyStatus.rejected(
        null,
        'req',
        { provider: 'anthropic' },
        { message: 'keystore unavailable', code: 'ENCRYPTION_UNAVAILABLE' }
      )
    );
    expect(s.lastError).toBe('keystore unavailable');
  });

  test('statusPushed updates the status sub-tree', () => {
    const s = reducer(
      undefined,
      statusPushed({
        providers: [{ id: 'anthropic', enabled: true, ready: true }],
        routing: { default: 'anthropic', perFolder: {} }
      })
    );
    expect(s.status.providers).toHaveLength(1);
    expect(s.status.routing.default).toBe('anthropic');
    expect(s.settings.routing.default).toBe('anthropic');
  });

  test('statusPushed mirrors consent into settings', () => {
    const s = reducer(
      undefined,
      statusPushed({
        consent: { acknowledgedCloudAt: '2026-06-01T12:00:00.000Z' }
      })
    );
    expect(s.settings.consent.acknowledgedCloudAt).toBe('2026-06-01T12:00:00.000Z');
  });
});

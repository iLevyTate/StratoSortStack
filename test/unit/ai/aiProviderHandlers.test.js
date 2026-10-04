'use strict';

jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn() },
  app: {
    on: jest.fn(),
    getPath: jest.fn(() => '/tmp'),
    isPackaged: true
  },
  // ACKNOWLEDGE_CLOUD confirms consent in a main-process dialog; the default
  // answer here is "Enable cloud AI" (button 0). Individual tests override it.
  dialog: { showMessageBox: jest.fn(async () => ({ response: 0 })) },
  safeStorage: {
    isEncryptionAvailable: jest.fn(() => true),
    encryptString: jest.fn((s) => Buffer.from(s)),
    decryptString: jest.fn((b) => b.toString())
  },
  getPath: jest.fn(() => '/tmp')
}));

// ipcRegistry uses these symbols when validating handlers; provide stubs.
jest.mock('../../../src/main/core/ipcRegistry', () => ({
  registerHandler: (ipcMain, channel, handler) => ipcMain.handle(channel, handler),
  registerListener: (ipcMain, channel, handler) => ipcMain.on(channel, handler)
}));

jest.mock('../../../src/main/services/ServiceContainer', () => ({
  container: { resolve: () => null },
  ServiceIds: { LLAMA_SERVICE: 'llama' }
}));

// Keep a stable reference so tests can reach mock methods for introspection.
// Note: variable MUST be prefixed with "mock" (case-insensitive) for jest.mock() hoisting rules.
let mockKeyStoreInstance = null;

// Force lazy requires to load mocked providers / store
jest.mock('../../../src/main/services/ai/AIKeyStore', () => ({
  AIKeyStore: jest.fn().mockImplementation(() => {
    mockKeyStoreInstance = {
      get: jest.fn(async () => null),
      set: jest.fn(async () => ({ encryption: 'safeStorage' })),
      remove: jest.fn(async () => undefined),
      status: jest.fn(async () => ({ hasKey: false, lastFour: null }))
    };
    return mockKeyStoreInstance;
  })
}));

jest.mock('../../../src/main/services/ai/providers/LocalLlamaProvider', () => ({
  LocalLlamaProvider: jest.fn().mockImplementation(() => ({
    id: 'local',
    displayName: 'Local Llama',
    ready: () => true,
    analyze: jest.fn(async () => ({ text: 'OK', usage: {} }))
  }))
}));

jest.mock('../../../src/main/services/ai/providers/AnthropicProvider', () => ({
  AnthropicProvider: jest.fn().mockImplementation(() => ({
    id: 'anthropic',
    displayName: 'Anthropic Claude',
    ready: async () => false,
    analyze: jest.fn(async () => ({ text: 'OK', usage: {} }))
  }))
}));

jest.mock('../../../src/main/services/ai/providers/OpenAICompatibleProvider', () => ({
  OpenAICompatibleProvider: jest.fn().mockImplementation(({ getKey, baseUrl } = {}) => ({
    id: 'openaiCompatible',
    displayName: 'OpenAI / Custom',
    _baseUrl: baseUrl || 'https://api.openai.com/v1',
    _getKey: getKey,
    _readyCache: false,
    ready() {
      return this._readyCache;
    },
    analyze: jest.fn(async () => ({ text: 'OK', usage: {} }))
  }))
}));

const registerAiProviderIpc = require('../../../src/main/ipc/aiProvider');
const { ipcMain } = require('electron');

describe('AI provider IPC handlers', () => {
  let context;
  let handlers;
  // Simulate in-memory settings store; save() merges + stores, get() reads.
  let settingsCache;

  beforeAll(() => {
    settingsCache = {};
    context = {
      core: {
        ipcMain,
        IPC_CHANNELS: {
          AI_PROVIDER: {
            GET_CONFIG: 'ai-provider:get-config',
            SET_PROVIDER_CONFIG: 'ai-provider:set-provider-config',
            SET_KEY: 'ai-provider:set-key',
            GET_KEY_STATUS: 'ai-provider:get-key-status',
            REMOVE_KEY: 'ai-provider:remove-key',
            TEST_PROVIDER: 'ai-provider:test-provider',
            GET_USAGE: 'ai-provider:get-usage',
            SET_ROUTING: 'ai-provider:set-routing',
            ACKNOWLEDGE_CLOUD: 'ai-provider:acknowledge-cloud',
            STATUS_CHANGED: 'ai-provider:status-changed'
          }
        },
        logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
      },
      // Mimic SettingsService API (no set(key,val); uses get(key) + save(fullObj)):
      settingsService: {
        get: jest.fn((key) => settingsCache[key]),
        getAll: jest.fn(() => ({ ...settingsCache })),
        load: jest.fn(async () => ({ ...settingsCache })),
        save: jest.fn(async (full) => {
          Object.assign(settingsCache, full);
          return full;
        })
      },
      getServiceIntegration: () => null
    };
    Object.setPrototypeOf(
      context,
      require('../../../src/main/ipc/IpcServiceContext').IpcServiceContext.prototype
    );
    registerAiProviderIpc(context);

    handlers = {};
    for (const [channel, fn] of ipcMain.handle.mock.calls) {
      handlers[channel] = fn;
    }
  });

  test('registers all invokable handlers', () => {
    expect(Object.keys(handlers).sort()).toEqual([
      'ai-provider:acknowledge-cloud',
      'ai-provider:get-config',
      'ai-provider:get-key-status',
      'ai-provider:get-usage',
      'ai-provider:remove-key',
      'ai-provider:set-key',
      'ai-provider:set-provider-config',
      'ai-provider:set-routing',
      'ai-provider:test-provider'
    ]);
  });

  test('GET_CONFIG returns settings + status', async () => {
    const res = await handlers['ai-provider:get-config']({}, {});
    expect(res.success).toBe(true);
    expect(res.settings.providers.local.enabled).toBe(true);
    expect(res.status.providers).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'local' })])
    );
  });

  test('SET_KEY persists via key store and reports success after consent', async () => {
    // Cloud-provider key writes now require consent. Acknowledge first.
    await handlers['ai-provider:acknowledge-cloud']({}, {});
    const res = await handlers['ai-provider:set-key'](
      {},
      { provider: 'anthropic', key: 'sk-ant-x' }
    );
    expect(res.success).toBe(true);
  });

  test('SET_KEY syncs openaiCompatible ready:true in returned status', async () => {
    mockKeyStoreInstance.get.mockImplementation(async (provider) =>
      provider === 'openaiCompatible' ? 'sk-openai-test' : null
    );
    await handlers['ai-provider:acknowledge-cloud']({}, {});
    await handlers['ai-provider:set-provider-config'](
      {},
      { provider: 'openaiCompatible', config: { enabled: true } }
    );
    const res = await handlers['ai-provider:set-key'](
      {},
      { provider: 'openaiCompatible', key: 'sk-openai-test' }
    );
    expect(res.success).toBe(true);
    const openai = res.status?.providers?.find((p) => p.id === 'openaiCompatible');
    expect(openai?.ready).toBe(true);
    expect(openai?.enabled).toBe(true);
  });

  test('GET_KEY_STATUS reports hasKey:false initially', async () => {
    const res = await handlers['ai-provider:get-key-status']({}, { provider: 'anthropic' });
    expect(res).toEqual({ success: true, hasKey: false, lastFour: null });
  });

  test('SET_ROUTING refuses cloud override without prior consent', async () => {
    // Reset settings to a no-consent baseline.
    settingsCache.ai = undefined;
    const res = await handlers['ai-provider:set-routing'](
      {},
      { perFolder: { 'tax-uuid': 'anthropic' } }
    );
    expect(res.success).toBe(false);
    expect(res.code).toBe('CONSENT_REQUIRED');
  });

  test('ACKNOWLEDGE_CLOUD then SET_ROUTING merges routing.perFolder and persists', async () => {
    const ack = await handlers['ai-provider:acknowledge-cloud']({}, {});
    expect(ack.success).toBe(true);

    const res = await handlers['ai-provider:set-routing'](
      {},
      { perFolder: { 'tax-uuid': 'anthropic' } }
    );
    expect(res.success).toBe(true);
    const cfg = await handlers['ai-provider:get-config']({}, {});
    expect(cfg.settings.routing.perFolder['tax-uuid']).toBe('anthropic');
  });

  test('SET_ROUTING with null perFolder value clears the override (T15)', async () => {
    // Set up consent + an override first.
    await handlers['ai-provider:acknowledge-cloud']({}, {});
    await handlers['ai-provider:set-routing']({}, { perFolder: { 'tax-uuid': 'anthropic' } });
    const before = await handlers['ai-provider:get-config']({}, {});
    expect(before.settings.routing.perFolder['tax-uuid']).toBe('anthropic');

    // Clear via null
    const res = await handlers['ai-provider:set-routing']({}, { perFolder: { 'tax-uuid': null } });
    expect(res.success).toBe(true);

    const after = await handlers['ai-provider:get-config']({}, {});
    expect(after.settings.routing.perFolder['tax-uuid']).toBeUndefined();
  });

  test('ACKNOWLEDGE_CLOUD records consent only after the main-process dialog is confirmed', async () => {
    const { dialog } = require('electron');
    settingsCache.ai = undefined;

    dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });
    const declined = await handlers['ai-provider:acknowledge-cloud']({}, {});
    expect(declined.success).toBe(false);
    expect(declined.code).toBe('CONSENT_DECLINED');
    expect(settingsCache.ai?.consent?.acknowledgedCloudAt).toBeUndefined();

    const routed = await handlers['ai-provider:set-routing']({}, { default: 'anthropic' });
    expect(routed.code).toBe('CONSENT_REQUIRED');

    dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
    const accepted = await handlers['ai-provider:acknowledge-cloud']({}, {});
    expect(accepted.success).toBe(true);
    expect(typeof settingsCache.ai.consent.acknowledgedCloudAt).toBe('string');
    const options = dialog.showMessageBox.mock.calls.at(-1).at(-1);
    expect(options.buttons).toEqual(['Enable cloud AI', 'Keep local']);
    expect(options.cancelId).toBe(1);
  });

  test('ACKNOWLEDGE_CLOUD fails closed when no dialog can confirm it, and when the dialog throws', async () => {
    const { dialog } = require('electron');
    settingsCache.ai = undefined;

    const showMessageBox = dialog.showMessageBox;
    dialog.showMessageBox = undefined;
    try {
      const noDialog = await handlers['ai-provider:acknowledge-cloud']({}, {});
      expect(noDialog.success).toBe(false);
      expect(noDialog.code).toBe('CONSENT_DECLINED');
      expect(settingsCache.ai?.consent?.acknowledgedCloudAt).toBeUndefined();
    } finally {
      dialog.showMessageBox = showMessageBox;
    }

    dialog.showMessageBox.mockRejectedValueOnce(new Error('dialog exploded'));
    const threw = await handlers['ai-provider:acknowledge-cloud']({}, {});
    expect(threw.success).toBe(false);
    expect(threw.code).toBe('CONSENT_DECLINED');
    expect(settingsCache.ai?.consent?.acknowledgedCloudAt).toBeUndefined();
  });

  test('ACKNOWLEDGE_CLOUD skips the dialog only for an unpackaged STRATOSORT_E2E run', async () => {
    const electron = require('electron');
    const { dialog } = electron;
    settingsCache.ai = undefined;
    const previousEnv = process.env.STRATOSORT_E2E;
    const previousPackaged = electron.app.isPackaged;
    dialog.showMessageBox.mockClear();
    try {
      // Packaged build: the env flag changes nothing.
      process.env.STRATOSORT_E2E = '1';
      dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });
      const packaged = await handlers['ai-provider:acknowledge-cloud']({}, {});
      expect(packaged.success).toBe(false);
      expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);

      electron.app.isPackaged = false;
      const e2e = await handlers['ai-provider:acknowledge-cloud']({}, {});
      expect(e2e.success).toBe(true);
      expect(typeof settingsCache.ai.consent.acknowledgedCloudAt).toBe('string');
      expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    } finally {
      electron.app.isPackaged = previousPackaged;
      if (previousEnv === undefined) delete process.env.STRATOSORT_E2E;
      else process.env.STRATOSORT_E2E = previousEnv;
    }
  });

  test('TEST_PROVIDER fails when provider is not ready', async () => {
    const res = await handlers['ai-provider:test-provider']({}, { provider: 'anthropic' });
    expect(res.success).toBe(false);
    // The handler maps the AUTH_FAILED code to a safe user-facing message; we
    // assert the typed code rather than the prose so future copy changes
    // don't break the contract.
    expect(res.errorCode).toBe('AUTH_FAILED');
    expect(typeof res.error).toBe('string');
    expect(res.error.length).toBeGreaterThan(0);
  });

  test('error messages do not leak provider key material', async () => {
    // Force a failure path via the keystore throwing an error that contains
    // key material. The IPC envelope must NOT echo the provider error message
    // verbatim — it must collapse to a safe generic message so secrets in
    // raw error strings can't reach the renderer / DevTools.
    expect(mockKeyStoreInstance).not.toBeNull();
    mockKeyStoreInstance.set.mockRejectedValueOnce(
      new Error('vault error with sk-ant-leaked-key-xxxxx in msg')
    );

    const badRes = await handlers['ai-provider:set-key'](
      {},
      {
        provider: 'anthropic',
        key: 'sk-ant-leaked-key-xxxxx'
      }
    );
    expect(badRes.success).toBe(false);
    // No part of the leaked key (or any sk- prefix at all) reaches the envelope.
    expect(badRes.error).not.toContain('sk-ant-leaked-key-xxxxx');
    expect(badRes.error).not.toContain('sk-ant');
    expect(badRes.error).not.toContain('vault error');
    // The error envelope carries the typed code so the renderer can show
    // localized messaging without reading raw error text.
    expect(typeof badRes.errorCode).toBe('string');
  });

  test('GET_USAGE returns stub zeros for both providers', async () => {
    const res = await handlers['ai-provider:get-usage']({}, {});
    expect(res.success).toBe(true);
    expect(res.thisMonth.anthropic.estCostUsd).toBe(0);
    expect(res.thisMonth.openaiCompatible.estCostUsd).toBe(0);
  });

  test('SET_PROVIDER_CONFIG enable=true requires cloud consent first', async () => {
    settingsCache.ai = undefined;
    const blocked = await handlers['ai-provider:set-provider-config'](
      {},
      { provider: 'anthropic', config: { enabled: true, model: 'claude-opus-4-7' } }
    );
    expect(blocked.success).toBe(false);
    expect(blocked.code).toBe('CONSENT_REQUIRED');
  });

  test('SET_PROVIDER_CONFIG merges provider config after consent', async () => {
    await handlers['ai-provider:acknowledge-cloud']({}, {});
    const res = await handlers['ai-provider:set-provider-config'](
      {},
      {
        provider: 'anthropic',
        config: { enabled: true, model: 'claude-opus-4-7' }
      }
    );
    expect(res.success).toBe(true);
    const cfg = await handlers['ai-provider:get-config']({}, {});
    expect(cfg.settings.providers.anthropic.model).toBe('claude-opus-4-7');
    expect(cfg.settings.providers.anthropic.enabled).toBe(true);
  });

  test('SET_PROVIDER_CONFIG rejects http baseUrl that is not localhost', async () => {
    await handlers['ai-provider:acknowledge-cloud']({}, {});
    const res = await handlers['ai-provider:set-provider-config'](
      {},
      {
        provider: 'openaiCompatible',
        config: { baseUrl: 'http://attacker.example/v1' }
      }
    );
    expect(res.success).toBe(false);
    // Schema-level validation rejects unsafe URLs before the handler runs.
    expect(res.error).toBeDefined();
  });

  test('SET_PROVIDER_CONFIG with baseUrl-only (no enabled) requires consent', async () => {
    // Bypass attempt closed: a renderer must not be able to set baseUrl on a
    // cloud provider without first acknowledging cloud, even if `enabled` is
    // left undefined. Pre-fix, the gate only checked when enabled === true.
    settingsCache.ai = undefined;
    const res = await handlers['ai-provider:set-provider-config'](
      {},
      {
        provider: 'openaiCompatible',
        config: { baseUrl: 'https://api.openai.com/v1' }
      }
    );
    expect(res.success).toBe(false);
    expect(res.code).toBe('CONSENT_REQUIRED');
  });

  test('SET_PROVIDER_CONFIG allows clearing (enabled: false alone) without consent', async () => {
    settingsCache.ai = undefined;
    const res = await handlers['ai-provider:set-provider-config'](
      {},
      {
        provider: 'anthropic',
        config: { enabled: false }
      }
    );
    // Disabling a cloud provider should always be allowed — it's a privacy-
    // preserving action and shouldn't require re-acknowledging cloud.
    expect(res.success).toBe(true);
  });

  test('SET_KEY for cloud provider requires consent', async () => {
    settingsCache.ai = undefined;
    const res = await handlers['ai-provider:set-key'](
      {},
      { provider: 'anthropic', key: 'sk-ant-x' }
    );
    expect(res.success).toBe(false);
    expect(res.code).toBe('CONSENT_REQUIRED');
  });

  test('TEST_PROVIDER for cloud provider requires consent', async () => {
    settingsCache.ai = undefined;
    const res = await handlers['ai-provider:test-provider']({}, { provider: 'anthropic' });
    expect(res.success).toBe(false);
    expect(res.code).toBe('CONSENT_REQUIRED');
  });

  test('GET_CONFIG repairs a hand-edited blob: bad baseUrl disables the provider and reroutes local', async () => {
    settingsCache.ai = {
      providers: {
        openaiCompatible: { enabled: true, baseUrl: 'http://attacker.example/v1' }
      },
      routing: { default: 'openaiCompatible', perFolder: { 'tax-uuid': 'openaiCompatible' } },
      consent: { acknowledgedCloudAt: '2020-01-01T00:00:00.000Z' }
    };
    const res = await handlers['ai-provider:get-config']({}, {});
    expect(res.success).toBe(true);
    expect(res.settings.providers.openaiCompatible).toMatchObject({
      enabled: false,
      baseUrl: 'https://api.openai.com/v1'
    });
    expect(res.settings.routing).toEqual({ default: 'local', perOperation: {}, perFolder: {} });
    expect(context.core.logger.warn).toHaveBeenCalledWith(
      '[ai] stored AI settings repaired on read',
      expect.objectContaining({ issues: expect.any(Array) })
    );
  });

  test('GET_CONFIG resets cloud routing to local when stored consent is missing', async () => {
    settingsCache.ai = {
      providers: {},
      routing: { default: 'anthropic', perFolder: { a: 'anthropic', b: 'local' } },
      consent: {}
    };
    const res = await handlers['ai-provider:get-config']({}, {});
    expect(res.settings.routing).toEqual({
      default: 'local',
      perOperation: {},
      perFolder: { b: 'local' }
    });
  });

  test('hasCloudConsent rejects malformed acknowledgedCloudAt values', async () => {
    // A corrupted settings.json with a non-ISO truthy string must NOT
    // be honored as consent.
    settingsCache.ai = {
      providers: {},
      routing: { default: 'local', perFolder: {} },
      consent: { acknowledgedCloudAt: 'totally not a date' }
    };
    const res = await handlers['ai-provider:set-key'](
      {},
      { provider: 'anthropic', key: 'sk-ant-x' }
    );
    expect(res.success).toBe(false);
    expect(res.code).toBe('CONSENT_REQUIRED');
  });

  test('SET_ROUTING refuses a cloud per-operation entry without prior consent', async () => {
    settingsCache.ai = undefined;
    const res = await handlers['ai-provider:set-routing'](
      {},
      { perOperation: { chat: 'anthropic' } }
    );
    expect(res.success).toBe(false);
    expect(res.code).toBe('CONSENT_REQUIRED');
  });

  test('SET_ROUTING sets, keeps and clears per-operation entries', async () => {
    settingsCache.ai = undefined;
    await handlers['ai-provider:acknowledge-cloud']({}, {});
    let res = await handlers['ai-provider:set-routing']({}, { perOperation: { chat: 'local' } });
    expect(res.success).toBe(true);
    res = await handlers['ai-provider:set-routing']({}, { perOperation: { analyze: 'anthropic' } });
    expect(res.success).toBe(true);

    let cfg = await handlers['ai-provider:get-config']({}, {});
    expect(cfg.settings.routing.perOperation).toEqual({ chat: 'local', analyze: 'anthropic' });
    expect(cfg.status.routing.perOperation).toEqual({ chat: 'local', analyze: 'anthropic' });

    res = await handlers['ai-provider:set-routing']({}, { perOperation: { analyze: null } });
    expect(res.success).toBe(true);
    cfg = await handlers['ai-provider:get-config']({}, {});
    expect(cfg.settings.routing.perOperation).toEqual({ chat: 'local' });
  });

  test('SET_PROVIDER_CONFIG stores a spend cap and null removes it', async () => {
    settingsCache.ai = undefined;
    await handlers['ai-provider:acknowledge-cloud']({}, {});
    let res = await handlers['ai-provider:set-provider-config'](
      {},
      { provider: 'anthropic', config: { spendCapMonthlyUsd: 25 } }
    );
    expect(res.success).toBe(true);
    let cfg = await handlers['ai-provider:get-config']({}, {});
    expect(cfg.settings.providers.anthropic.spendCapMonthlyUsd).toBe(25);

    res = await handlers['ai-provider:set-provider-config'](
      {},
      { provider: 'anthropic', config: { spendCapMonthlyUsd: null } }
    );
    expect(res.success).toBe(true);
    cfg = await handlers['ai-provider:get-config']({}, {});
    expect(cfg.settings.providers.anthropic).not.toHaveProperty('spendCapMonthlyUsd');
    expect(settingsCache.ai.providers.anthropic).not.toHaveProperty('spendCapMonthlyUsd');
  });
});

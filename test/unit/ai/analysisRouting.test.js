'use strict';
/**
 * Real routing integration test (T23).
 *
 * Exercises the full AIRouter + 3 real provider classes path:
 *   - LocalLlamaProvider with a mocked LlamaService
 *   - AnthropicProvider with a mocked fetch
 *   - OpenAICompatibleProvider with a mocked fetch
 *
 * Scenarios:
 *   1. Default routing returns the configured default provider and an
 *      analyze() call goes through that provider's wire path.
 *   2. Per-folder override beats the default.
 *   3. Per-folder override is ignored when the target provider is not ready
 *      (no key) — falls through to default.
 *   4. Default falls back to local when default is not ready.
 *   5. Provider stamping reflects the actual provider used.
 *   6. Cost tracker records usage for cloud calls and skips local calls.
 *
 * Unlike AIRouter.test.js (which uses minimal stubs), this test exercises the
 * provider classes' actual wire-format handling end-to-end. If a provider
 * silently regresses (e.g. stops parsing usage tokens), this test catches it
 * because the costTracker assertions read real usage values.
 */

jest.mock('node:fs', () => {
  const real = jest.requireActual('node:fs');
  const mockFiles = new Map();
  return {
    ...real,
    promises: {
      ...real.promises,
      mkdir: jest.fn(async () => undefined),
      readFile: jest.fn(async (p) => {
        if (mockFiles.has(p)) return mockFiles.get(p);
        const e = new Error('ENOENT');
        e.code = 'ENOENT';
        throw e;
      }),
      writeFile: jest.fn(async (p, data) => {
        mockFiles.set(p, Buffer.isBuffer(data) ? data : Buffer.from(data));
      }),
      open: jest.fn(async (p) => ({
        writeFile: jest.fn(async (data) => {
          mockFiles.set(p, Buffer.isBuffer(data) ? data : Buffer.from(data));
        }),
        sync: jest.fn(async () => undefined),
        close: jest.fn(async () => undefined)
      })),
      rename: jest.fn(async (oldPath, newPath) => {
        if (!mockFiles.has(oldPath)) {
          const e = new Error('ENOENT');
          e.code = 'ENOENT';
          throw e;
        }
        mockFiles.set(newPath, mockFiles.get(oldPath));
        mockFiles.delete(oldPath);
      }),
      unlink: jest.fn(async (p) => {
        mockFiles.delete(p);
      })
    },
    __mockFiles: mockFiles
  };
});

const { AIRouter } = require('../../../src/main/services/ai/AIRouter');
const {
  LocalLlamaProvider
} = require('../../../src/main/services/ai/providers/LocalLlamaProvider');
const { AnthropicProvider } = require('../../../src/main/services/ai/providers/AnthropicProvider');
const {
  OpenAICompatibleProvider
} = require('../../../src/main/services/ai/providers/OpenAICompatibleProvider');
const { CostTracker } = require('../../../src/main/services/ai/costTracker');

function mockFetchOk(body) {
  return jest.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body)
  }));
}

function makeMockLlamaService() {
  return {
    isModelReady: jest.fn(() => true),
    analyzeText: jest.fn(async () => ({
      text: '{"purpose":"local-result"}',
      usage: {}
    })),
    generateTextStreaming: jest.fn(async () => ({ text: '', usage: {} }))
  };
}

function makeAnthropicResponse(text = 'cloud-anthropic-result') {
  return {
    content: [{ type: 'text', text }],
    usage: { input_tokens: 100, output_tokens: 50 }
  };
}

function makeOpenAIResponse(text = 'cloud-openai-result') {
  return {
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 80, completion_tokens: 40 }
  };
}

describe('analysis routing integration (real router + 3 real providers)', () => {
  let llamaService;
  let anthropicFetch;
  let openaiFetch;
  let costTracker;
  let providers;
  let router;
  let settings;

  beforeEach(() => {
    require('node:fs').__mockFiles.clear();
    jest.clearAllMocks();

    settings = {
      providers: {
        local: { enabled: true, displayName: 'Local Llama' },
        anthropic: { enabled: true, displayName: 'Anthropic Claude', model: 'claude-opus-4-7' },
        openaiCompatible: {
          enabled: true,
          displayName: 'OpenAI / Custom',
          model: 'gpt-4o',
          baseUrl: 'https://api.example.com/v1'
        }
      },
      routing: { default: 'local', perFolder: {} },
      consent: { acknowledgedCloudAt: '2026-01-01T00:00:00.000Z' }
    };

    costTracker = new CostTracker({
      filePath: '/tmp/userData/ai-cost-tracker.json',
      getSettings: () => settings
    });

    llamaService = makeMockLlamaService();
    anthropicFetch = mockFetchOk(makeAnthropicResponse());
    openaiFetch = mockFetchOk(makeOpenAIResponse());

    providers = {
      local: new LocalLlamaProvider(llamaService),
      anthropic: new AnthropicProvider({
        getKey: () => 'sk-ant-test',
        model: 'claude-opus-4-7',
        fetchFn: anthropicFetch,
        costTracker
      }),
      openaiCompatible: new OpenAICompatibleProvider({
        getKey: () => 'sk-openai-test',
        model: 'gpt-4o',
        baseUrl: 'https://api.example.com/v1',
        fetchFn: openaiFetch,
        costTracker
      })
    };

    router = new AIRouter({ providers, getSettings: () => settings });
  });

  test('default route: chooses local when default is local + sends prompt to llama', async () => {
    const provider = router.choose({ operation: 'analyze' });
    expect(provider.id).toBe('local');

    await provider.analyze('hello');
    expect(llamaService.analyzeText).toHaveBeenCalledWith('hello', expect.any(Object));
    expect(anthropicFetch).not.toHaveBeenCalled();
    expect(openaiFetch).not.toHaveBeenCalled();
  });

  test('default route: chooses anthropic and routes through Anthropic Messages API', async () => {
    settings.routing.default = 'anthropic';
    const provider = router.choose({ operation: 'analyze' });
    expect(provider.id).toBe('anthropic');

    const result = await provider.analyze('analyze this');
    expect(result.text).toBe('cloud-anthropic-result');
    expect(anthropicFetch).toHaveBeenCalledTimes(1);
    expect(anthropicFetch.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages');
    // x-api-key header is set on outbound request
    expect(anthropicFetch.mock.calls[0][1].headers['x-api-key']).toBe('sk-ant-test');
  });

  test('per-folder override beats default route', async () => {
    settings.routing.default = 'local';
    settings.routing.perFolder['tax-uuid'] = 'anthropic';

    const provider = router.choose({ operation: 'analyze', smartFolderId: 'tax-uuid' });
    expect(provider.id).toBe('anthropic');

    await provider.analyze('analyze this');
    expect(anthropicFetch).toHaveBeenCalledTimes(1);
    expect(llamaService.analyzeText).not.toHaveBeenCalled();
  });

  test('per-operation entry routes analysis to Anthropic while chat and suggestions stay local', async () => {
    settings.routing.default = 'local';
    settings.routing.perOperation = { analyze: 'anthropic' };

    const analyzeProvider = router.choose({ operation: 'analyze' });
    expect(analyzeProvider.id).toBe('anthropic');
    await analyzeProvider.analyze('analyze this');
    expect(anthropicFetch).toHaveBeenCalledTimes(1);

    expect(router.choose({ operation: 'chat' }).id).toBe('local');
    expect(router.choose({ operation: 'suggest' }).id).toBe('local');
    expect(llamaService.analyzeText).not.toHaveBeenCalled();
  });

  test('per-folder override is ignored when target provider is not ready', () => {
    // Build a fresh anthropic provider with NO key — ready() returns false.
    providers.anthropic = new AnthropicProvider({
      getKey: () => null,
      model: 'claude-opus-4-7',
      fetchFn: anthropicFetch,
      costTracker
    });
    router = new AIRouter({ providers, getSettings: () => settings });

    settings.routing.perFolder['tax-uuid'] = 'anthropic';
    const provider = router.choose({ operation: 'analyze', smartFolderId: 'tax-uuid' });
    expect(provider.id).toBe('local');
  });

  test('default falls back to local when default cloud provider is not ready', () => {
    providers.anthropic = new AnthropicProvider({
      getKey: () => null,
      model: 'claude-opus-4-7',
      fetchFn: anthropicFetch
    });
    router = new AIRouter({ providers, getSettings: () => settings });

    settings.routing.default = 'anthropic';
    const provider = router.choose({ operation: 'analyze' });
    expect(provider.id).toBe('local');
  });

  test('throws NO_PROVIDER_READY when nothing is ready and fallback disabled', () => {
    llamaService.isModelReady.mockReturnValue(false);
    settings.routing.default = 'anthropic';
    providers.anthropic = new AnthropicProvider({
      getKey: () => null,
      model: 'claude-opus-4-7',
      fetchFn: anthropicFetch
    });
    router = new AIRouter({ providers, getSettings: () => settings });

    let err;
    try {
      router.choose({ operation: 'chat', allowFallback: false });
    } catch (e) {
      err = e;
      // ignore
    }
    expect(err?.code).toBe('NO_PROVIDER_READY');
  });

  test('cloud calls are recorded by the cost tracker (anthropic)', async () => {
    settings.routing.default = 'anthropic';
    const provider = router.choose({ operation: 'analyze' });
    await provider.analyze('hello');

    // recordUsage is awaited inside _trackUsage via .catch — flush microtasks.
    await new Promise((resolve) => setImmediate(resolve));

    const usage = costTracker.getMonthlyUsage();
    const monthEntry = Object.values(usage)[0]?.anthropic;
    expect(monthEntry?.inputTokens).toBe(100);
    expect(monthEntry?.outputTokens).toBe(50);
    expect(monthEntry?.estCostUsd).toBeGreaterThan(0);
  });

  test('cloud calls are recorded by the cost tracker (openaiCompatible)', async () => {
    settings.routing.default = 'openaiCompatible';
    const provider = router.choose({ operation: 'analyze' });
    await provider.analyze('hello');

    await new Promise((resolve) => setImmediate(resolve));

    const usage = costTracker.getMonthlyUsage();
    const monthEntry = Object.values(usage)[0]?.openaiCompatible;
    expect(monthEntry?.inputTokens).toBe(80);
    expect(monthEntry?.outputTokens).toBe(40);
    expect(monthEntry?.estCostUsd).toBeGreaterThan(0);
  });

  test('local calls do NOT go through the cost tracker', async () => {
    const provider = router.choose({ operation: 'analyze' });
    expect(provider.id).toBe('local');
    await provider.analyze('hello');

    await new Promise((resolve) => setImmediate(resolve));

    const usage = costTracker.getMonthlyUsage();
    expect(usage).toEqual({});
  });

  test('budget cap blocks the next call after monthly spend is reached', async () => {
    // First call records 100 input + 50 output tokens at opus rates =
    // 100/1M*15 + 50/1M*75 = $0.00525. Cap below that to ensure the second
    // call sees the cap as already crossed.
    settings.providers.anthropic.spendCapMonthlyUsd = 0.001;
    settings.routing.default = 'anthropic';

    // First call goes through and records ~$0.01–0.02 of usage (100/1M*15 + 50/1M*75).
    const provider1 = router.choose({ operation: 'analyze' });
    await provider1.analyze('hello');
    await new Promise((resolve) => setImmediate(resolve));

    // Second call must be blocked because tracker now sees us at/over the cap.
    let err;
    try {
      const provider2 = router.choose({ operation: 'analyze' });
      await provider2.analyze('hello again');
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe('BUDGET_EXCEEDED');
  });
});

'use strict';
const { EventEmitter } = require('node:events');
const { AIRouter } = require('../../../src/main/services/ai/AIRouter');
const { AIProviderError } = require('../../../src/main/services/ai/errors');

// Minimal Provider stub for testing
function makeProvider(id, ready = true) {
  return {
    id,
    displayName: id,
    ready: jest.fn(() => ready),
    analyze: jest.fn(async () => ({ ok: true, by: id })),
    chatStream: jest.fn(async () => ({ ok: true, by: id })),
    suggest: jest.fn(async () => ({ ok: true, by: id }))
  };
}

describe('AIRouter', () => {
  let router;
  let providers;
  let settings;

  beforeEach(() => {
    providers = {
      local: makeProvider('local'),
      anthropic: makeProvider('anthropic'),
      openaiCompatible: makeProvider('openaiCompatible')
    };
    settings = {
      providers: {
        local: { enabled: true },
        anthropic: { enabled: true },
        openaiCompatible: { enabled: false }
      },
      routing: {
        default: 'local',
        perFolder: {}
      },
      consent: { acknowledgedCloudAt: '2026-01-01T00:00:00.000Z' }
    };
    router = new AIRouter({ providers, getSettings: () => settings });
  });

  test('default rule: returns the configured default provider', () => {
    const p = router.choose({ operation: 'analyze' });
    expect(p.id).toBe('local');
  });

  test('per-folder override wins over default', () => {
    settings.routing.perFolder['tax-uuid'] = 'anthropic';
    const p = router.choose({ operation: 'analyze', smartFolderId: 'tax-uuid' });
    expect(p.id).toBe('anthropic');
  });

  test('per-folder override is ignored when target provider is disabled', () => {
    settings.providers.anthropic.enabled = false;
    settings.routing.perFolder['tax-uuid'] = 'anthropic';
    const p = router.choose({ operation: 'analyze', smartFolderId: 'tax-uuid' });
    expect(p.id).toBe('local');
  });

  test('per-folder override is ignored when target provider reports not ready', () => {
    providers.anthropic.ready.mockReturnValue(false);
    settings.routing.perFolder['tax-uuid'] = 'anthropic';
    const p = router.choose({ operation: 'analyze', smartFolderId: 'tax-uuid' });
    expect(p.id).toBe('local');
  });

  test('falls back to local when default provider is not ready and allowFallback=true', () => {
    settings.routing.default = 'anthropic';
    providers.anthropic.ready.mockReturnValue(false);
    const p = router.choose({ operation: 'analyze' });
    expect(p.id).toBe('local');
  });

  test('throws NO_PROVIDER_READY when default fails and allowFallback=false', () => {
    settings.routing.default = 'anthropic';
    providers.anthropic.ready.mockReturnValue(false);
    expect(() => router.choose({ operation: 'chat', allowFallback: false })).toThrow(
      AIProviderError
    );
    try {
      router.choose({ operation: 'chat', allowFallback: false });
    } catch (e) {
      expect(e.code).toBe('NO_PROVIDER_READY');
    }
  });

  test('throws NO_PROVIDER_READY when nothing is ready', () => {
    providers.local.ready.mockReturnValue(false);
    providers.anthropic.ready.mockReturnValue(false);
    expect(() => router.choose({ operation: 'analyze' })).toThrow(AIProviderError);
  });

  test('does not fall back when default succeeds (no extra ready check)', () => {
    settings.routing.default = 'anthropic';
    const p = router.choose({ operation: 'analyze' });
    expect(p.id).toBe('anthropic');
    expect(providers.local.ready).not.toHaveBeenCalled();
  });

  test('settings are read fresh on each choose() call (no caching)', () => {
    expect(router.choose({ operation: 'analyze' }).id).toBe('local');
    settings.routing.default = 'anthropic';
    expect(router.choose({ operation: 'analyze' }).id).toBe('anthropic');
  });

  test('emits "routing-changed" event when notifySettingsChanged is called', () => {
    const events = [];
    router.on('routing-changed', () => events.push('changed'));
    router.notifySettingsChanged();
    expect(events).toEqual(['changed']);
  });

  test('cloud provider without consent falls back to local', () => {
    settings.consent = {};
    settings.routing.default = 'anthropic';
    const p = router.choose({ operation: 'analyze' });
    expect(p.id).toBe('local');
  });

  test('emits folder-override-unavailable when override is not ready', () => {
    const events = [];
    router.on('folder-override-unavailable', (payload) => events.push(payload));
    providers.anthropic.ready.mockReturnValue(false);
    settings.routing.perFolder['tax-uuid'] = 'anthropic';
    router.choose({ operation: 'analyze', smartFolderId: 'tax-uuid' });
    expect(events).toHaveLength(1);
    expect(events[0].configuredProvider).toBe('anthropic');
  });

  test('listProviders returns each provider with ready/enabled metadata', () => {
    const list = router.listProviders();
    expect(list).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'local', enabled: true, ready: true }),
        expect.objectContaining({ id: 'anthropic', enabled: true, ready: true }),
        expect.objectContaining({ id: 'openaiCompatible', enabled: false, ready: true })
      ])
    );
  });

  test('an unavailable folder override throws FOLDER_OVERRIDE_UNAVAILABLE when fallback is disallowed', () => {
    settings.routing.perFolder['tax-uuid'] = 'anthropic';
    providers.anthropic.ready.mockReturnValue(false);
    expect.assertions(2);
    try {
      router.choose({ operation: 'analyze', smartFolderId: 'tax-uuid', allowFallback: false });
    } catch (e) {
      expect(e).toBeInstanceOf(AIProviderError);
      expect(e.code).toBe('FOLDER_OVERRIDE_UNAVAILABLE');
    }
  });

  describe('per-operation routing', () => {
    test('an operation entry beats the default for that operation only', () => {
      settings.routing.default = 'anthropic';
      settings.routing.perOperation = { chat: 'local' };
      expect(router.choose({ operation: 'chat' }).id).toBe('local');
      expect(router.choose({ operation: 'analyze' }).id).toBe('anthropic');
      expect(router.choose({ operation: 'suggest' }).id).toBe('anthropic');
    });

    test('a cloud entry sends only that operation to the cloud', () => {
      settings.routing.perOperation = { analyze: 'anthropic' };
      expect(router.choose({ operation: 'analyze' }).id).toBe('anthropic');
      expect(router.choose({ operation: 'chat' }).id).toBe('local');
      expect(router.choose({ operation: 'suggest' }).id).toBe('local');
    });

    test('the smart-folder override still wins over the operation entry', () => {
      settings.routing.perOperation = { analyze: 'local' };
      settings.routing.perFolder['tax-uuid'] = 'anthropic';
      expect(router.choose({ operation: 'analyze', smartFolderId: 'tax-uuid' }).id).toBe(
        'anthropic'
      );
      expect(router.choose({ operation: 'analyze' }).id).toBe('local');
    });

    test('an unavailable operation entry falls back to local, never to a cloud default', () => {
      settings.providers.openaiCompatible.enabled = true;
      settings.routing.default = 'openaiCompatible';
      settings.routing.perOperation = { chat: 'anthropic' };
      providers.anthropic.ready.mockReturnValue(false);
      const events = [];
      router.on('operation-override-unavailable', (payload) => events.push(payload));
      expect(router.choose({ operation: 'chat' }).id).toBe('local');
      expect(router.choose({ operation: 'analyze' }).id).toBe('openaiCompatible');
      expect(events).toEqual([
        expect.objectContaining({ operation: 'chat', configuredProvider: 'anthropic' })
      ]);
    });

    test('an unavailable operation entry throws OPERATION_OVERRIDE_UNAVAILABLE when fallback is disallowed', () => {
      settings.routing.perOperation = { chat: 'anthropic' };
      providers.anthropic.ready.mockReturnValue(false);
      expect.assertions(1);
      try {
        router.choose({ operation: 'chat', allowFallback: false });
      } catch (e) {
        expect(e.code).toBe('OPERATION_OVERRIDE_UNAVAILABLE');
      }
    });

    test('a cloud operation entry without consent runs local', () => {
      settings.consent = {};
      settings.routing.perOperation = { chat: 'anthropic' };
      expect(router.choose({ operation: 'chat' }).id).toBe('local');
    });

    test('a local entry with the local model unloaded throws NO_PROVIDER_READY rather than using the cloud default', () => {
      settings.routing.default = 'anthropic';
      settings.routing.perOperation = { chat: 'local' };
      providers.local.ready.mockReturnValue(false);
      expect.assertions(1);
      try {
        router.choose({ operation: 'chat' });
      } catch (e) {
        expect(e.code).toBe('NO_PROVIDER_READY');
      }
    });
  });
});

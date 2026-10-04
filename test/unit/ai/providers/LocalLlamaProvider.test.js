'use strict';
const {
  LocalLlamaProvider
} = require('../../../../src/main/services/ai/providers/LocalLlamaProvider');

describe('LocalLlamaProvider', () => {
  function makeLlamaService(overrides = {}) {
    return {
      isModelReady: jest.fn(() => true),
      analyzeText: jest.fn(async (prompt, options) => ({
        text: `local-analyze-of:${prompt.slice(0, 20)}`,
        format: options?.format ?? 'text'
      })),
      generateTextStreaming: jest.fn(async ({ prompt, onToken }) => {
        if (typeof onToken === 'function') onToken('chunk-1');
        return `local-stream-of:${prompt.slice(0, 20)}`;
      }),
      ...overrides
    };
  }

  test('exposes id and displayName', () => {
    const p = new LocalLlamaProvider(makeLlamaService());
    expect(p.id).toBe('local');
    expect(p.displayName).toBe('Local Llama');
  });

  test('ready() returns true when llamaService reports model ready', () => {
    const p = new LocalLlamaProvider(makeLlamaService());
    expect(p.ready()).toBe(true);
  });

  test('ready() returns false when llamaService reports not ready', () => {
    const p = new LocalLlamaProvider(makeLlamaService({ isModelReady: () => false }));
    expect(p.ready()).toBe(false);
  });

  test('ready() returns false when no llamaService is provided', () => {
    const p = new LocalLlamaProvider(null);
    expect(p.ready()).toBe(false);
  });

  test('ready() handles llamaService without isModelReady gracefully', () => {
    const p = new LocalLlamaProvider({/* no isModelReady */});
    expect(p.ready()).toBe(false);
  });

  test('analyze() delegates to llamaService.analyzeText with same args', async () => {
    const llama = makeLlamaService();
    const p = new LocalLlamaProvider(llama);
    const result = await p.analyze('please summarize this document', { format: 'json' });
    expect(llama.analyzeText).toHaveBeenCalledWith('please summarize this document', {
      format: 'json'
    });
    expect(result.text).toContain('local-analyze-of:');
  });

  test('chatStream() delegates to llamaService.generateTextStreaming', async () => {
    const llama = makeLlamaService();
    const p = new LocalLlamaProvider(llama);
    const tokens = [];
    const result = await p.chatStream({
      prompt: 'tell me a story',
      systemPrompt: 'be brief',
      onToken: (t) => tokens.push(t)
    });
    expect(llama.generateTextStreaming).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'tell me a story',
        systemPrompt: 'be brief'
      })
    );
    expect(tokens).toEqual(['chunk-1']);
    expect(result).toContain('local-stream-of:');
  });

  test('suggest() is an alias of analyze() (same call path)', async () => {
    const llama = makeLlamaService();
    const p = new LocalLlamaProvider(llama);
    const result = await p.suggest('which folder fits?', { format: 'json' });
    expect(llama.analyzeText).toHaveBeenCalledWith('which folder fits?', { format: 'json' });
    expect(result.text).toContain('local-analyze-of:');
  });

  test('analyze throws AIProviderError(PROVIDER_FAILED) when underlying service throws', async () => {
    const llama = makeLlamaService({
      analyzeText: jest.fn(async () => {
        throw new Error('llama crashed');
      })
    });
    const p = new LocalLlamaProvider(llama);
    await expect(p.analyze('x', {})).rejects.toMatchObject({
      name: 'AIProviderError',
      code: 'PROVIDER_FAILED'
    });
  });

  test('analyze throws AIProviderError(NO_PROVIDER_READY) when no llamaService', async () => {
    const p = new LocalLlamaProvider(null);
    await expect(p.analyze('x', {})).rejects.toMatchObject({
      name: 'AIProviderError',
      code: 'NO_PROVIDER_READY'
    });
  });

  test('chatStream throws AIProviderError(PROVIDER_FAILED) when underlying service throws', async () => {
    const llama = makeLlamaService({
      generateTextStreaming: jest.fn(async () => {
        throw new Error('boom');
      })
    });
    const p = new LocalLlamaProvider(llama);
    await expect(p.chatStream({ prompt: 'x' })).rejects.toMatchObject({
      name: 'AIProviderError',
      code: 'PROVIDER_FAILED'
    });
  });
});

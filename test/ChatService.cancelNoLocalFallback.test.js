/**
 * A user cancel of a cloud chat stream must never start a local generation,
 * whatever error shape the provider throws for it. A provider that wraps the
 * abort as a transient code (NETWORK_ERROR) used to slip past the
 * `err.name === 'AbortError'` guard and fall back to the local model.
 */

jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

const ChatService = require('../src/main/services/ChatService');
const { AIProviderError } = require('../src/main/services/ai/errors');

function makeService() {
  const llamaService = {
    generateTextStreaming: jest.fn(async () => ({ response: 'local answer', truncated: false }))
  };
  const service = new ChatService({ llamaService });
  return { service, llamaService };
}

describe('ChatService._streamWithLocalFallback after a user cancel', () => {
  test('a NETWORK_ERROR thrown while the signal is aborted does not fall back to local', async () => {
    const { service, llamaService } = makeService();
    const controller = new AbortController();
    const cloudProvider = {
      id: 'anthropic',
      chatStream: jest.fn(async () => {
        controller.abort();
        throw new AIProviderError('NETWORK_ERROR', 'fetch failed');
      })
    };

    await expect(
      service._streamWithLocalFallback({
        cloudProvider,
        prompt: 'p',
        signal: controller.signal,
        onToken: () => {}
      })
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(llamaService.generateTextStreaming).not.toHaveBeenCalled();
  });

  test('a NETWORK_ERROR without a cancel still falls back to local', async () => {
    const { service, llamaService } = makeService();
    const cloudProvider = {
      id: 'anthropic',
      chatStream: jest.fn(async () => {
        throw new AIProviderError('NETWORK_ERROR', 'fetch failed');
      })
    };

    const result = await service._streamWithLocalFallback({
      cloudProvider,
      prompt: 'p',
      signal: new AbortController().signal,
      onToken: () => {}
    });
    expect(result.viaFallback).toBe(true);
    expect(result.fallbackReason).toBe('NETWORK_ERROR');
    expect(llamaService.generateTextStreaming).toHaveBeenCalledTimes(1);
  });
});

/**
 * Cloud-to-local fallback policy for ChatService.
 *
 * Pre-fix: ChatService called `router.choose({ allowFallback: false })` and
 * surfaced any cloud failure as a fatal "Chat failed". v2.0.9 was always
 * local, so users upgrading to v3 with a cloud provider configured saw
 * harder failures than v2 ever produced.
 *
 * Policy after fix (matches `documentLlm.js`):
 *   - BUDGET_EXCEEDED / RATE_LIMITED / NETWORK_ERROR / PROVIDER_FAILED
 *     → fall back to local Llama transparently, log a warning, emit a
 *       `status` event so the renderer can surface "using local model".
 *   - AUTH_FAILED / CONTENT_TOO_LONG / etc. (non-listed codes) still throw
 *     so the user can fix their config — silent local routing would hide
 *     a misconfiguration.
 *   - AbortError always re-throws (user-initiated cancel is not a cloud
 *     failure).
 */

jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

jest.mock('../src/main/utils/jsonRepair', () => ({
  extractAndParseJSON: jest.fn(() => ({}))
}));

const ChatService = require('../src/main/services/ChatService');

function makeAIProviderError(code, message = code) {
  const err = new Error(message);
  err.name = 'AIProviderError';
  err.code = code;
  return err;
}

function makeService() {
  const llamaService = {
    generateTextStreaming: jest.fn(async ({ onToken }) => {
      onToken?.('local-token');
      return { response: 'local-token' };
    })
  };
  const service = new ChatService({ llamaService });
  return { service, llamaService };
}

describe('ChatService._streamWithLocalFallback', () => {
  test('returns cloud text when cloud succeeds', async () => {
    const { service, llamaService } = makeService();
    const cloudProvider = {
      id: 'openai',
      chatStream: jest.fn(async ({ onToken }) => {
        onToken?.('cloud-token');
        return { text: 'cloud-token' };
      })
    };

    const result = await service._streamWithLocalFallback({
      cloudProvider,
      prompt: 'hi',
      signal: new AbortController().signal,
      onToken: () => {}
    });

    expect(result).toEqual({ text: 'cloud-token', viaFallback: false, truncated: false });
    expect(cloudProvider.chatStream).toHaveBeenCalledTimes(1);
    expect(llamaService.generateTextStreaming).not.toHaveBeenCalled();
  });

  test('falls back to local Llama on transient cloud error (NETWORK_ERROR)', async () => {
    const { service, llamaService } = makeService();
    const cloudProvider = {
      id: 'openai',
      chatStream: jest.fn().mockRejectedValue(makeAIProviderError('NETWORK_ERROR'))
    };

    const tokens = [];
    const result = await service._streamWithLocalFallback({
      cloudProvider,
      prompt: 'hi',
      signal: new AbortController().signal,
      onToken: (t) => tokens.push(t)
    });

    expect(result.viaFallback).toBe(true);
    expect(result.fallbackReason).toBe('NETWORK_ERROR');
    expect(result.text).toBe('local-token');
    expect(llamaService.generateTextStreaming).toHaveBeenCalledTimes(1);
    // Local-stream tokens MUST flow through the original onToken, otherwise
    // the renderer's preview-delta UI would freeze on a blank reply during
    // the fallback path.
    expect(tokens).toContain('local-token');
  });

  test.each(['BUDGET_EXCEEDED', 'RATE_LIMITED', 'PROVIDER_FAILED'])(
    'falls back to local on transient cloud error (%s)',
    async (code) => {
      const { service, llamaService } = makeService();
      const cloudProvider = {
        chatStream: jest.fn().mockRejectedValue(makeAIProviderError(code))
      };

      const result = await service._streamWithLocalFallback({
        cloudProvider,
        prompt: 'hi',
        signal: new AbortController().signal,
        onToken: () => {}
      });

      expect(result.viaFallback).toBe(true);
      expect(result.fallbackReason).toBe(code);
      expect(llamaService.generateTextStreaming).toHaveBeenCalledTimes(1);
    }
  );

  test('does NOT fall back on AUTH_FAILED — surfaces error so user can fix config', async () => {
    const { service, llamaService } = makeService();
    const authErr = makeAIProviderError('AUTH_FAILED', 'invalid api key');
    const cloudProvider = {
      chatStream: jest.fn().mockRejectedValue(authErr)
    };

    await expect(
      service._streamWithLocalFallback({
        cloudProvider,
        prompt: 'hi',
        signal: new AbortController().signal,
        onToken: () => {}
      })
    ).rejects.toBe(authErr);
    expect(llamaService.generateTextStreaming).not.toHaveBeenCalled();
  });

  test('does NOT fall back on CONTENT_TOO_LONG', async () => {
    const { service, llamaService } = makeService();
    const cloudProvider = {
      chatStream: jest.fn().mockRejectedValue(makeAIProviderError('CONTENT_TOO_LONG'))
    };

    await expect(
      service._streamWithLocalFallback({
        cloudProvider,
        prompt: 'hi',
        signal: new AbortController().signal,
        onToken: () => {}
      })
    ).rejects.toMatchObject({ code: 'CONTENT_TOO_LONG' });
    expect(llamaService.generateTextStreaming).not.toHaveBeenCalled();
  });

  test('user-initiated AbortError re-throws (not treated as cloud failure)', async () => {
    const { service, llamaService } = makeService();
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    const cloudProvider = {
      chatStream: jest.fn().mockRejectedValue(abortErr)
    };

    await expect(
      service._streamWithLocalFallback({
        cloudProvider,
        prompt: 'hi',
        signal: new AbortController().signal,
        onToken: () => {}
      })
    ).rejects.toBe(abortErr);
    // Abort is the user cancelling, not a cloud failure — local must NOT run.
    expect(llamaService.generateTextStreaming).not.toHaveBeenCalled();
  });

  test('null cloudProvider routes directly to local without invoking router', async () => {
    const { service, llamaService } = makeService();

    const result = await service._streamWithLocalFallback({
      cloudProvider: null,
      prompt: 'hi',
      signal: new AbortController().signal,
      onToken: () => {}
    });

    expect(result.viaFallback).toBe(false);
    expect(result.text).toBe('local-token');
    expect(llamaService.generateTextStreaming).toHaveBeenCalledTimes(1);
  });
});

// F-102: NETWORK_ERROR can now fire mid-stream (providers classify
// reader.read() rejections). If tokens already streamed through onToken,
// a local retry would append a second answer to the partial one the user
// saw — the guard surfaces the failure instead.
describe('ChatService._streamWithLocalFallback tokensEmitted guard (F-102)', () => {
  test('does NOT fall back when the cloud stream died after emitting tokens', async () => {
    const { service, llamaService } = makeService();
    const midStreamErr = makeAIProviderError('NETWORK_ERROR', 'stream failed mid-read');
    midStreamErr.tokensEmitted = true;
    const cloudProvider = {
      chatStream: jest.fn(async ({ onToken }) => {
        onToken?.('partial-cloud-');
        throw midStreamErr;
      })
    };

    await expect(
      service._streamWithLocalFallback({
        cloudProvider,
        prompt: 'hi',
        signal: new AbortController().signal,
        onToken: () => {}
      })
    ).rejects.toBe(midStreamErr);
    expect(llamaService.generateTextStreaming).not.toHaveBeenCalled();
  });

  test('still falls back when the stream died before any token (tokensEmitted=false)', async () => {
    const { service, llamaService } = makeService();
    const earlyErr = makeAIProviderError('NETWORK_ERROR', 'stream failed mid-read');
    earlyErr.tokensEmitted = false;
    const cloudProvider = {
      chatStream: jest.fn().mockRejectedValue(earlyErr)
    };

    const result = await service._streamWithLocalFallback({
      cloudProvider,
      prompt: 'hi',
      signal: new AbortController().signal,
      onToken: () => {}
    });

    expect(result.viaFallback).toBe(true);
    expect(result.fallbackReason).toBe('NETWORK_ERROR');
    expect(llamaService.generateTextStreaming).toHaveBeenCalledTimes(1);
  });
});

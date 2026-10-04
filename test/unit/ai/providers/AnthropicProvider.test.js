'use strict';
const {
  AnthropicProvider
} = require('../../../../src/main/services/ai/providers/AnthropicProvider');

const ENDPOINT = 'https://api.anthropic.com/v1/messages';

function mockFetchOk(body) {
  return jest.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body)
  }));
}

function mockFetchHttpError(status, body = '') {
  return jest.fn(async () => ({
    ok: false,
    status,
    headers: { get: (h) => (h === 'retry-after' ? '30' : 'application/json') },
    json: async () => (typeof body === 'string' ? { error: { message: body } } : body),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  }));
}

function mockFetchSse(events) {
  return jest.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'text/event-stream' },
    body: {
      getReader: () => {
        let i = 0;
        const enc = new TextEncoder();
        const chunks = events.map((e) =>
          enc.encode(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
        );
        return {
          read: async () => {
            if (i >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: chunks[i++] };
          },
          releaseLock: () => {}
        };
      }
    }
  }));
}

describe('AnthropicProvider', () => {
  test('id and displayName', () => {
    const p = new AnthropicProvider({ getKey: () => 'sk-ant-x', model: 'claude-opus-4-7' });
    expect(p.id).toBe('anthropic');
    expect(p.displayName).toBe('Anthropic Claude');
  });

  test('ready() is true when getKey returns a non-empty string', async () => {
    const p = new AnthropicProvider({ getKey: () => 'sk-ant-x', model: 'claude-opus-4-7' });
    expect(await p.ready()).toBe(true);
  });

  test('ready() is false when no key configured', async () => {
    const p = new AnthropicProvider({ getKey: () => null, model: 'claude-opus-4-7' });
    expect(await p.ready()).toBe(false);
  });

  test('analyze() POSTs the correct request body to /v1/messages', async () => {
    const fetchFn = mockFetchOk({
      content: [{ type: 'text', text: '{"category":"Tax","summary":"Q4"}' }],
      usage: { input_tokens: 100, output_tokens: 20 }
    });
    const p = new AnthropicProvider({
      getKey: () => 'sk-ant-test',
      model: 'claude-opus-4-7',
      fetchFn
    });
    const result = await p.analyze('analyze this doc: ...', { jsonMode: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.headers['x-api-key']).toBe('sk-ant-test');
    expect(init.headers['anthropic-version']).toBeDefined();
    expect(init.headers['content-type']).toBe('application/json');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('claude-opus-4-7');
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content).toContain('analyze this doc');
    // Result returns parsed JSON object when jsonMode=true and response is JSON
    expect(result.text).toContain('Tax');
    expect(result.usage).toEqual({ input_tokens: 100, output_tokens: 20 });
  });

  test('analyze() returns text as-is when jsonMode=false', async () => {
    const fetchFn = mockFetchOk({
      content: [{ type: 'text', text: 'just some text' }],
      usage: { input_tokens: 5, output_tokens: 5 }
    });
    const p = new AnthropicProvider({
      getKey: () => 'sk-ant-test',
      model: 'claude-haiku-4-5',
      fetchFn
    });
    const result = await p.analyze('hi', { jsonMode: false });
    expect(result.text).toBe('just some text');
  });

  test('analyze() maps HTTP 401 to AUTH_FAILED', async () => {
    const fetchFn = mockFetchHttpError(401, {
      error: { type: 'authentication_error', message: 'invalid key' }
    });
    const p = new AnthropicProvider({ getKey: () => 'sk-bad', model: 'claude-opus-4-7', fetchFn });
    await expect(p.analyze('x')).rejects.toMatchObject({
      name: 'AIProviderError',
      code: 'AUTH_FAILED'
    });
  });

  test('analyze() maps HTTP 429 to RATE_LIMITED with retry-after metadata', async () => {
    const fetchFn = mockFetchHttpError(429, { error: { message: 'rate limited' } });
    const p = new AnthropicProvider({ getKey: () => 'sk-x', model: 'claude-opus-4-7', fetchFn });
    let caught;
    try {
      await p.analyze('x');
    } catch (e) {
      caught = e;
    }
    expect(caught.code).toBe('RATE_LIMITED');
  });

  test('analyze() maps HTTP 413 / overloaded to CONTENT_TOO_LONG', async () => {
    const fetchFn = mockFetchHttpError(413, { error: { message: 'too large' } });
    const p = new AnthropicProvider({ getKey: () => 'sk-x', model: 'claude-opus-4-7', fetchFn });
    await expect(p.analyze('x')).rejects.toMatchObject({ code: 'CONTENT_TOO_LONG' });
  });

  test('analyze() maps fetch network errors to NETWORK_ERROR', async () => {
    const fetchFn = jest.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const p = new AnthropicProvider({ getKey: () => 'sk-x', model: 'claude-opus-4-7', fetchFn });
    await expect(p.analyze('x')).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  test('analyze() maps unparseable response to INVALID_RESPONSE', async () => {
    const fetchFn = jest.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => {
        throw new Error('not json');
      },
      text: async () => 'garbage'
    }));
    const p = new AnthropicProvider({ getKey: () => 'sk-x', model: 'claude-opus-4-7', fetchFn });
    await expect(p.analyze('x')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  test('chatStream() parses SSE content_block_delta events and calls onToken per token', async () => {
    const fetchFn = mockFetchSse([
      { event: 'message_start', data: { type: 'message_start' } },
      {
        event: 'content_block_delta',
        data: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } }
      },
      {
        event: 'content_block_delta',
        data: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } }
      },
      { event: 'message_delta', data: { type: 'message_delta', usage: { output_tokens: 2 } } },
      { event: 'message_stop', data: { type: 'message_stop' } }
    ]);
    const p = new AnthropicProvider({
      getKey: () => 'sk-ant-test',
      model: 'claude-sonnet-4-6',
      fetchFn
    });
    const tokens = [];
    const result = await p.chatStream({
      prompt: 'hi',
      systemPrompt: 'be brief',
      onToken: (t) => tokens.push(t)
    });
    expect(tokens).toEqual(['Hello', ' world']);
    expect(result.text).toBe('Hello world');
  });

  test('chatStream() request body includes stream:true and system parameter', async () => {
    const fetchFn = mockFetchSse([{ event: 'message_stop', data: { type: 'message_stop' } }]);
    const p = new AnthropicProvider({ getKey: () => 'sk-x', model: 'claude-opus-4-7', fetchFn });
    await p.chatStream({ prompt: 'hi', systemPrompt: 'sys' });
    const [, init] = fetchFn.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.stream).toBe(true);
    expect(body.system).toBe('sys');
    expect(body.messages[0].content).toBe('hi');
  });

  test('chatStream() respects AbortSignal', async () => {
    const fetchFn = jest.fn(async (url, init) => {
      // Simulate abort after fetch starts
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });
    const p = new AnthropicProvider({ getKey: () => 'sk-x', model: 'claude-opus-4-7', fetchFn });
    const ac = new AbortController();
    ac.abort();
    await expect(p.chatStream({ prompt: 'hi', signal: ac.signal })).rejects.toMatchObject({
      code: 'NETWORK_ERROR'
    });
  });

  test('chatStream() processes a final SSE event without trailing blank line', async () => {
    // Some servers flush message_delta (carrying the usage block) and then
    // close the connection without the standard \r\n\r\n event terminator.
    // The handler must drain the trailing buffer instead of dropping it.
    const enc = new TextEncoder();
    const ev1 = enc.encode(
      'data: ' +
        JSON.stringify({
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'hi' }
        }) +
        '\n\n'
    );
    // Final chunk has NO trailing \n\n — would be dropped before the fix.
    const ev2 = enc.encode(
      'data: ' +
        JSON.stringify({
          type: 'message_delta',
          usage: { input_tokens: 11, output_tokens: 22 }
        })
    );
    const chunks = [ev1, ev2];
    const fetchFn = jest.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'text/event-stream' },
      body: {
        getReader: () => {
          let i = 0;
          return {
            read: async () => {
              if (i >= chunks.length) return { done: true, value: undefined };
              return { done: false, value: chunks[i++] };
            },
            releaseLock: () => {}
          };
        }
      }
    }));
    const onToken = jest.fn();
    const recordUsage = jest.fn(async () => undefined);
    const p = new AnthropicProvider({
      getKey: () => 'sk-x',
      model: 'claude-opus-4-7',
      fetchFn,
      costTracker: { recordUsage }
    });
    const result = await p.chatStream({ prompt: 'q', onToken });
    expect(result.text).toBe('hi');
    expect(result.usage).toMatchObject({ input_tokens: 11, output_tokens: 22 });
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 11, outputTokens: 22 })
    );
  });

  test('chatStream() aborts with STREAM_IDLE_TIMEOUT when the server stalls', async () => {
    let cancelFn;
    const fetchFn = jest.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'text/event-stream' },
      body: {
        getReader: () => ({
          read: () =>
            new Promise((_, reject) => {
              cancelFn = (err) => reject(err);
            }),
          cancel: (err) => {
            cancelFn?.(err || new Error('cancelled'));
            return Promise.resolve();
          },
          releaseLock: () => {}
        })
      }
    }));
    // streamIdleTimeoutMs is exposed as a constructor option specifically so
    // this test can fire the watchdog quickly. Without it, the test would
    // wait the full 60s production window.
    const p = new AnthropicProvider({
      getKey: () => 'sk-x',
      model: 'claude-opus-4-7',
      fetchFn,
      streamIdleTimeoutMs: 50
    });
    await expect(p.chatStream({ prompt: 'hi' })).rejects.toMatchObject({
      code: 'STREAM_IDLE_TIMEOUT'
    });
  });
});

// Fails-before coverage for F-100/F-101: a mid-body connection reset used to
// escape the AIProviderError taxonomy (raw undici error, no local fallback,
// raw message in the UI) and partial-stream usage was never recorded on any
// stream error path.
describe('AnthropicProvider mid-stream failure classification', () => {
  function mockFetchSseThenReject(events, error) {
    const enc = new TextEncoder();
    const chunks = events.map((e) => enc.encode(`event: e\ndata: ${JSON.stringify(e)}\n\n`));
    return jest.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'text/event-stream' },
      body: {
        getReader: () => {
          let i = 0;
          return {
            read: async () => {
              if (i < chunks.length) return { done: false, value: chunks[i++] };
              throw error;
            },
            cancel: () => Promise.resolve(),
            releaseLock: () => {}
          };
        }
      }
    }));
  }

  test('connection reset after tokens → NETWORK_ERROR, tokensEmitted=true, partial usage tracked', async () => {
    const recordUsage = jest.fn(async () => undefined);
    const fetchFn = mockFetchSseThenReject(
      [
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'par' } },
        { type: 'message_delta', usage: { input_tokens: 7, output_tokens: 3 } }
      ],
      new TypeError('terminated')
    );
    const p = new AnthropicProvider({
      getKey: () => 'sk-x',
      model: 'claude-opus-4-7',
      fetchFn,
      costTracker: { recordUsage }
    });
    const err = await p.chatStream({ prompt: 'q' }).catch((e) => e);
    expect(err).toMatchObject({
      name: 'AIProviderError',
      code: 'NETWORK_ERROR',
      tokensEmitted: true
    });
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 7, outputTokens: 3 })
    );
  });

  test('connection reset before any token → NETWORK_ERROR, tokensEmitted=false', async () => {
    const fetchFn = mockFetchSseThenReject([], new TypeError('terminated'));
    const p = new AnthropicProvider({ getKey: () => 'sk-x', model: 'claude-opus-4-7', fetchFn });
    const err = await p.chatStream({ prompt: 'q' }).catch((e) => e);
    expect(err).toMatchObject({
      name: 'AIProviderError',
      code: 'NETWORK_ERROR',
      tokensEmitted: false
    });
  });

  // M10: an exception exiting the read loop used to leave the response body
  // open until GC because finally only released the lock.
  test('a mid-stream read failure cancels the reader before releasing the lock', async () => {
    const order = [];
    const fetchFn = jest.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'text/event-stream' },
      body: {
        getReader: () => ({
          read: async () => {
            throw new TypeError('terminated');
          },
          cancel: jest.fn(async () => {
            order.push('cancel');
          }),
          releaseLock: jest.fn(() => {
            order.push('releaseLock');
          })
        })
      }
    }));
    const p = new AnthropicProvider({ getKey: () => 'sk-x', model: 'claude-opus-4-7', fetchFn });
    await expect(p.chatStream({ prompt: 'q' })).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(order).toEqual(['cancel', 'releaseLock']);
  });

  test('an in-band error event also cancels the reader', async () => {
    const cancel = jest.fn(async () => undefined);
    const enc = new TextEncoder();
    const chunk = enc.encode(
      `event: error\ndata: ${JSON.stringify({ type: 'error', error: { message: 'overloaded' } })}\n\n`
    );
    const fetchFn = jest.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'text/event-stream' },
      body: {
        getReader: () => {
          let sent = false;
          return {
            read: async () => {
              if (sent) return { done: true, value: undefined };
              sent = true;
              return { done: false, value: chunk };
            },
            cancel,
            releaseLock: () => {}
          };
        }
      }
    }));
    const p = new AnthropicProvider({ getKey: () => 'sk-x', model: 'claude-opus-4-7', fetchFn });
    await expect(p.chatStream({ prompt: 'q' })).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test('idle timeout after a usage event still records partial usage', async () => {
    const enc = new TextEncoder();
    const usageChunk = enc.encode(
      `event: e\ndata: ${JSON.stringify({
        type: 'message_delta',
        usage: { input_tokens: 5, output_tokens: 2 }
      })}\n\n`
    );
    let cancelFn;
    const fetchFn = jest.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'text/event-stream' },
      body: {
        getReader: () => {
          let emitted = false;
          return {
            read: () => {
              if (!emitted) {
                emitted = true;
                return Promise.resolve({ done: false, value: usageChunk });
              }
              return new Promise((_, reject) => {
                cancelFn = (err) => reject(err);
              });
            },
            cancel: (err) => {
              cancelFn?.(err || new Error('cancelled'));
              return Promise.resolve();
            },
            releaseLock: () => {}
          };
        }
      }
    }));
    const recordUsage = jest.fn(async () => undefined);
    const p = new AnthropicProvider({
      getKey: () => 'sk-x',
      model: 'claude-opus-4-7',
      fetchFn,
      costTracker: { recordUsage },
      streamIdleTimeoutMs: 50
    });
    await expect(p.chatStream({ prompt: 'hi' })).rejects.toMatchObject({
      code: 'STREAM_IDLE_TIMEOUT'
    });
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 5, outputTokens: 2 })
    );
  });
});

// H13: OUTPUT_TRUNCATED on a stream used to throw after every token had
// already been delivered via onToken, so callers discarded a complete (if
// cut-short) answer as a hard error.
describe('AnthropicProvider output truncation', () => {
  test('chatStream() resolves with truncated:true when stop_reason is max_tokens', async () => {
    const fetchFn = mockFetchSse([
      {
        event: 'content_block_delta',
        data: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Partial' } }
      },
      {
        event: 'content_block_delta',
        data: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' answer' } }
      },
      {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: 'max_tokens' },
          usage: { output_tokens: 2 }
        }
      },
      { event: 'message_stop', data: { type: 'message_stop' } }
    ]);
    const p = new AnthropicProvider({ getKey: () => 'sk-x', model: 'claude-opus-4-7', fetchFn });
    const tokens = [];
    const result = await p.chatStream({ prompt: 'q', onToken: (t) => tokens.push(t) });
    expect(tokens).toEqual(['Partial', ' answer']);
    expect(result).toMatchObject({ text: 'Partial answer', truncated: true });
  });

  test('chatStream() reports truncated:false on end_turn', async () => {
    const fetchFn = mockFetchSse([
      {
        event: 'content_block_delta',
        data: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Done' } }
      },
      {
        event: 'message_delta',
        data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} }
      }
    ]);
    const p = new AnthropicProvider({ getKey: () => 'sk-x', model: 'claude-opus-4-7', fetchFn });
    await expect(p.chatStream({ prompt: 'q' })).resolves.toMatchObject({
      text: 'Done',
      truncated: false
    });
  });

  test('analyze() (non-streaming) still throws OUTPUT_TRUNCATED but carries partialText', async () => {
    const fetchFn = mockFetchOk({
      content: [{ type: 'text', text: '{"category":"Fin' }],
      stop_reason: 'max_tokens',
      usage: {}
    });
    const p = new AnthropicProvider({ getKey: () => 'sk-x', model: 'claude-opus-4-7', fetchFn });
    await expect(p.analyze('x')).rejects.toMatchObject({
      code: 'OUTPUT_TRUNCATED',
      partialText: '{"category":"Fin'
    });
  });
});

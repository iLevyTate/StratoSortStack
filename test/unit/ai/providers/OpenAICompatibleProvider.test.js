'use strict';
const {
  OpenAICompatibleProvider
} = require('../../../../src/main/services/ai/providers/OpenAICompatibleProvider');

function mockFetchOk(body) {
  return jest.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body)
  }));
}
function mockFetchHttpError(status, body = {}) {
  return jest.fn(async () => ({
    ok: false,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body)
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
          enc.encode(`data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`)
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

describe('OpenAICompatibleProvider', () => {
  test('id and displayName defaults', () => {
    const p = new OpenAICompatibleProvider({
      getKey: () => 'sk-x',
      model: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1'
    });
    expect(p.id).toBe('openaiCompatible');
    expect(p.displayName).toBe('OpenAI / Custom');
  });

  test('displayName overridable via constructor', () => {
    const p = new OpenAICompatibleProvider({
      getKey: () => 'sk-x',
      model: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
      displayName: 'Groq'
    });
    expect(p.displayName).toBe('Groq');
  });

  test('a disallowed baseUrl leaves the provider unconfigured', async () => {
    for (const baseUrl of [
      'http://attacker.example/v1',
      'http://localhost.attacker.example/v1',
      'http://127.0.0.1@evil.example/v1',
      'ftp://api.openai.com/v1'
    ]) {
      const p = new OpenAICompatibleProvider({ getKey: () => 'sk-x', model: 'gpt-4o', baseUrl });
      expect(p._baseUrl).toBe('');
      expect(await p.ready()).toBe(false);
      await expect(p.analyze('hi')).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    }
  });

  test('loopback http baseUrls stay configured', () => {
    for (const baseUrl of [
      'http://localhost:11434/v1',
      'http://127.0.0.1:8080/v1',
      'http://[::1]/v1'
    ]) {
      const p = new OpenAICompatibleProvider({ getKey: () => 'sk-x', model: 'gpt-4o', baseUrl });
      expect(p._baseUrl).toBe(baseUrl);
    }
  });

  test('ready() requires both key and baseUrl', async () => {
    const noKey = new OpenAICompatibleProvider({
      getKey: () => null,
      model: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1'
    });
    expect(await noKey.ready()).toBe(false);
    const noBase = new OpenAICompatibleProvider({
      getKey: () => 'sk-x',
      model: 'gpt-4o',
      baseUrl: ''
    });
    expect(await noBase.ready()).toBe(false);
    const ok = new OpenAICompatibleProvider({
      getKey: () => 'sk-x',
      model: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1'
    });
    expect(await ok.ready()).toBe(true);
  });

  test('analyze() POSTs to <baseUrl>/chat/completions with Bearer auth', async () => {
    const fetchFn = mockFetchOk({
      choices: [{ message: { role: 'assistant', content: 'analysis result' } }],
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 }
    });
    const p = new OpenAICompatibleProvider({
      getKey: () => 'sk-test',
      model: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
      fetchFn
    });
    const result = await p.analyze('hello world', {});
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    expect(init.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('gpt-4o');
    expect(body.messages).toEqual([{ role: 'user', content: 'hello world' }]);
    expect(body.stream).toBe(false);
    expect(result.text).toBe('analysis result');
    expect(result.usage.total_tokens).toBe(60);
  });

  test('analyze() includes response_format when jsonMode=true', async () => {
    const fetchFn = mockFetchOk({
      choices: [{ message: { content: '{"foo":"bar"}' } }],
      usage: {}
    });
    const p = new OpenAICompatibleProvider({
      getKey: () => 'sk-x',
      model: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
      fetchFn
    });
    await p.analyze('give me json', { jsonMode: true });
    const [, init] = fetchFn.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  test('handles base URL with trailing slash gracefully', async () => {
    const fetchFn = mockFetchOk({
      choices: [{ message: { content: 'ok' } }],
      usage: {}
    });
    const p = new OpenAICompatibleProvider({
      getKey: () => 'sk-x',
      model: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1/',
      fetchFn
    });
    await p.analyze('hi');
    const [url] = fetchFn.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
  });

  test('analyze() maps 401 → AUTH_FAILED', async () => {
    const fetchFn = mockFetchHttpError(401, { error: { message: 'invalid' } });
    const p = new OpenAICompatibleProvider({
      getKey: () => 'sk-bad',
      model: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
      fetchFn
    });
    await expect(p.analyze('x')).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });

  test('analyze() maps 429 → RATE_LIMITED', async () => {
    const fetchFn = mockFetchHttpError(429, { error: { message: 'too many' } });
    const p = new OpenAICompatibleProvider({
      getKey: () => 'sk-x',
      model: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
      fetchFn
    });
    await expect(p.analyze('x')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  test('analyze() maps 400 with "context_length_exceeded" → CONTENT_TOO_LONG', async () => {
    const fetchFn = mockFetchHttpError(400, {
      error: { code: 'context_length_exceeded', message: 'too long' }
    });
    const p = new OpenAICompatibleProvider({
      getKey: () => 'sk-x',
      model: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
      fetchFn
    });
    await expect(p.analyze('x')).rejects.toMatchObject({ code: 'CONTENT_TOO_LONG' });
  });

  test('analyze() maps fetch network error → NETWORK_ERROR', async () => {
    const fetchFn = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const p = new OpenAICompatibleProvider({
      getKey: () => 'sk-x',
      model: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
      fetchFn
    });
    await expect(p.analyze('x')).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  test('analyze() maps unparseable response → INVALID_RESPONSE', async () => {
    const fetchFn = jest.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => {
        throw new Error('not json');
      },
      text: async () => 'garbage'
    }));
    const p = new OpenAICompatibleProvider({
      getKey: () => 'sk-x',
      model: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
      fetchFn
    });
    await expect(p.analyze('x')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  test('chatStream() parses SSE deltas and ignores [DONE]', async () => {
    const fetchFn = mockFetchSse([
      { choices: [{ delta: { content: 'Hello' } }] },
      { choices: [{ delta: { content: ' world' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      '[DONE]'
    ]);
    const p = new OpenAICompatibleProvider({
      getKey: () => 'sk-x',
      model: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
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

  test('chatStream() request body has stream:true and system as the first message', async () => {
    const fetchFn = mockFetchSse([{ choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]']);
    const p = new OpenAICompatibleProvider({
      getKey: () => 'sk-x',
      model: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
      fetchFn
    });
    await p.chatStream({ prompt: 'hi', systemPrompt: 'sys' });
    const [, init] = fetchFn.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.stream).toBe(true);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hi' });
  });
});

// Fails-before coverage for F-100/F-101 (same class as AnthropicProvider):
// mid-body connection resets escaped the AIProviderError taxonomy and
// partial-stream usage was never recorded on stream error paths.
describe('OpenAICompatibleProvider mid-stream failure classification', () => {
  function mockFetchSseThenReject(events, error) {
    const enc = new TextEncoder();
    const chunks = events.map((e) =>
      enc.encode(`data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`)
    );
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
        { choices: [{ delta: { content: 'par' } }] },
        { choices: [{ delta: {} }], usage: { prompt_tokens: 7, completion_tokens: 3 } }
      ],
      new TypeError('terminated')
    );
    const p = new OpenAICompatibleProvider({
      getKey: () => 'sk-x',
      model: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
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
    const p = new OpenAICompatibleProvider({
      getKey: () => 'sk-x',
      model: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
      fetchFn
    });
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
    const p = new OpenAICompatibleProvider({
      getKey: () => 'sk-x',
      model: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
      fetchFn
    });
    await expect(p.chatStream({ prompt: 'q' })).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(order).toEqual(['cancel', 'releaseLock']);
  });

  test('an in-band provider error chunk also cancels the reader', async () => {
    const cancel = jest.fn(async () => undefined);
    const enc = new TextEncoder();
    const chunk = enc.encode(`data: ${JSON.stringify({ error: { message: 'overloaded' } })}\n\n`);
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
    const p = new OpenAICompatibleProvider({
      getKey: () => 'sk-x',
      model: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
      fetchFn
    });
    await expect(p.chatStream({ prompt: 'q' })).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test('a clean stream does not cancel the reader', async () => {
    const cancel = jest.fn(async () => undefined);
    const enc = new TextEncoder();
    const chunk = enc.encode(
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`
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
    const p = new OpenAICompatibleProvider({
      getKey: () => 'sk-x',
      model: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
      fetchFn
    });
    await expect(p.chatStream({ prompt: 'q' })).resolves.toMatchObject({ text: 'ok' });
    expect(cancel).not.toHaveBeenCalled();
  });
});

// H13: OUTPUT_TRUNCATED on a stream used to throw after every token had
// already been delivered via onToken, so callers discarded a complete (if
// cut-short) answer as a hard error.
describe('OpenAICompatibleProvider output truncation', () => {
  test('chatStream() resolves with truncated:true when finish_reason is "length"', async () => {
    const fetchFn = mockFetchSse([
      { choices: [{ delta: { content: 'Partial' } }] },
      { choices: [{ delta: { content: ' answer' } }] },
      { choices: [{ delta: {}, finish_reason: 'length' }] },
      '[DONE]'
    ]);
    const p = new OpenAICompatibleProvider({
      getKey: () => 'sk-x',
      model: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
      fetchFn
    });
    const tokens = [];
    const result = await p.chatStream({ prompt: 'q', onToken: (t) => tokens.push(t) });
    expect(tokens).toEqual(['Partial', ' answer']);
    expect(result).toMatchObject({ text: 'Partial answer', truncated: true });
  });

  test('chatStream() reports truncated:false on a normal stop', async () => {
    const fetchFn = mockFetchSse([
      { choices: [{ delta: { content: 'Done' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      '[DONE]'
    ]);
    const p = new OpenAICompatibleProvider({
      getKey: () => 'sk-x',
      model: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
      fetchFn
    });
    await expect(p.chatStream({ prompt: 'q' })).resolves.toMatchObject({
      text: 'Done',
      truncated: false
    });
  });

  test('analyze() (non-streaming) still throws OUTPUT_TRUNCATED but carries partialText', async () => {
    const fetchFn = mockFetchOk({
      choices: [{ message: { content: '{"category":"Fin' }, finish_reason: 'length' }],
      usage: {}
    });
    const p = new OpenAICompatibleProvider({
      getKey: () => 'sk-x',
      model: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
      fetchFn
    });
    await expect(p.analyze('x')).rejects.toMatchObject({
      code: 'OUTPUT_TRUNCATED',
      partialText: '{"category":"Fin'
    });
  });
});

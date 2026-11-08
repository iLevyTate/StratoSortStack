/**
 * @jest-environment node
 */
'use strict';
/**
 * Cancellation must surface as an AbortError (never a normal success with the
 * partial text, never a transient NETWORK_ERROR that triggers a local
 * fallback), and base-URL credentials must never appear in error messages.
 * Fake fetch only; no network.
 */
const { ReadableStream } = require('stream/web');
const {
  OpenAICompatibleProvider
} = require('../../../../src/main/services/ai/providers/OpenAICompatibleProvider');

const enc = new TextEncoder();

/** SSE body that emits one token chunk every `gapMs`, then [DONE]. */
function sseResponse(tokens, gapMs = 5) {
  let i = 0;
  const body = new ReadableStream({
    async pull(controller) {
      await new Promise((r) => setTimeout(r, gapMs));
      if (i < tokens.length) {
        const chunk = { choices: [{ delta: { content: tokens[i++] } }] };
        controller.enqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      } else {
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
      }
    }
  });
  return { ok: true, status: 200, headers: { get: () => 'text/event-stream' }, body };
}

function makeProvider(fetchFn, baseUrl = 'https://api.example.test/v1') {
  return new OpenAICompatibleProvider({ getKey: () => 'sk-test', model: 'm', baseUrl, fetchFn });
}

/** fetch that never resolves until its signal aborts, then rejects like undici. */
function hangingFetch() {
  return jest.fn(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error('This operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      })
  );
}

describe('OpenAICompatibleProvider cancellation', () => {
  test('cancel mid-stream rejects with AbortError instead of resolving the partial text', async () => {
    const ac = new AbortController();
    const p = makeProvider(jest.fn(async () => sseResponse(['Hello', ' world', ' more', ' text'])));
    const seen = [];
    const run = p.chatStream({
      prompt: 'q',
      signal: ac.signal,
      onToken: (t) => {
        seen.push(t);
        if (seen.length === 2) ac.abort();
      }
    });
    await expect(run).rejects.toMatchObject({ name: 'AbortError', tokensEmitted: true });
  });

  test('an uncancelled stream still resolves with the full text', async () => {
    const p = makeProvider(jest.fn(async () => sseResponse(['Hello', ' world'])));
    await expect(
      p.chatStream({ prompt: 'q', signal: new AbortController().signal })
    ).resolves.toMatchObject({ text: 'Hello world', truncated: false });
  });

  test('cancel during the request handshake rejects with AbortError, not NETWORK_ERROR', async () => {
    const ac = new AbortController();
    const p = makeProvider(hangingFetch());
    const run = p.analyze('x', { signal: ac.signal });
    setTimeout(() => ac.abort(), 5);
    const err = await run.catch((e) => e);
    expect(err?.name).toBe('AbortError');
    expect(err?.code).not.toBe('NETWORK_ERROR');
  });

  test('cancel during a streaming handshake rejects with AbortError', async () => {
    const ac = new AbortController();
    const p = makeProvider(hangingFetch());
    const run = p.chatStream({ prompt: 'q', signal: ac.signal });
    setTimeout(() => ac.abort(), 5);
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('a network failure without a cancel is still NETWORK_ERROR', async () => {
    const p = makeProvider(
      jest.fn(async () => {
        throw new TypeError('fetch failed');
      })
    );
    await expect(p.analyze('x', { signal: new AbortController().signal })).rejects.toMatchObject({
      code: 'NETWORK_ERROR'
    });
  });
});

describe('OpenAICompatibleProvider base URL credentials', () => {
  const CREDENTIALED = 'https://alice:hunter2@gateway.example.test/v1';

  test('a base URL carrying user:password is never used to send the bearer key', async () => {
    const fetchFn = jest.fn(async () => {
      throw new TypeError(
        `Request cannot be constructed from a URL that includes credentials: ${CREDENTIALED}/chat/completions`
      );
    });
    const p = makeProvider(fetchFn, CREDENTIALED);
    expect(p.ready()).toBe(false);
    const err = await p.analyze('hi').catch((e) => e);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(String(err?.message)).not.toContain('hunter2');
  });

  test('network error messages never echo URL credentials', async () => {
    const fetchFn = jest.fn(async () => {
      throw new TypeError(
        'Request cannot be constructed from a URL that includes credentials: https://bob:s3cret@proxy.example.test/v1/chat/completions'
      );
    });
    const p = makeProvider(fetchFn);
    const err = await p.analyze('hi').catch((e) => e);
    expect(err?.code).toBe('NETWORK_ERROR');
    expect(String(err?.message)).not.toContain('s3cret');
    expect(String(err?.message)).toContain('api.example.test');
  });
});

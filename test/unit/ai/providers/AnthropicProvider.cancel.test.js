/**
 * @jest-environment node
 */
'use strict';
/**
 * A caller cancel must surface as an AbortError: never a normal success with
 * the partial text (ChatService would emit 'done' and save the cut-off turn),
 * and never a transient NETWORK_ERROR (ChatService would fall back to a local
 * generation after the user cancelled). Fake fetch only; no network.
 */
const { ReadableStream } = require('stream/web');
const {
  AnthropicProvider
} = require('../../../../src/main/services/ai/providers/AnthropicProvider');

const enc = new TextEncoder();

/** SSE body that emits one text_delta every `gapMs`, then message_stop. */
function sseResponse(tokens, gapMs = 5) {
  let i = 0;
  const body = new ReadableStream({
    async pull(controller) {
      await new Promise((r) => setTimeout(r, gapMs));
      if (i < tokens.length) {
        const data = {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: tokens[i++] }
        };
        controller.enqueue(
          enc.encode(`event: content_block_delta\ndata: ${JSON.stringify(data)}\n\n`)
        );
      } else {
        controller.enqueue(enc.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
        controller.close();
      }
    }
  });
  return { ok: true, status: 200, headers: { get: () => 'text/event-stream' }, body };
}

function makeProvider(fetchFn) {
  return new AnthropicProvider({ getKey: () => 'sk-ant-test', model: 'm', fetchFn });
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

describe('AnthropicProvider cancellation', () => {
  test('cancel mid-stream rejects with AbortError instead of resolving the partial text', async () => {
    const ac = new AbortController();
    const p = makeProvider(jest.fn(async () => sseResponse(['Hello', ' world', ' more', ' text'])));
    const seen = [];
    const run = p.chatStream({
      prompt: 'q',
      signal: ac.signal,
      onToken: (t) => {
        seen.push(t);
        if (seen.length === 1) ac.abort();
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

  test('cancel during a streaming handshake rejects with AbortError, not NETWORK_ERROR', async () => {
    const ac = new AbortController();
    const p = makeProvider(hangingFetch());
    const run = p.chatStream({ prompt: 'q', signal: ac.signal });
    setTimeout(() => ac.abort(), 5);
    const err = await run.catch((e) => e);
    expect(err?.name).toBe('AbortError');
    expect(err?.code).not.toBe('NETWORK_ERROR');
    expect(err?.tokensEmitted).toBe(false);
  });

  test('cancel during a non-stream handshake rejects with AbortError', async () => {
    const ac = new AbortController();
    const p = makeProvider(hangingFetch());
    const run = p.analyze('x', { signal: ac.signal });
    setTimeout(() => ac.abort(), 5);
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('cancel while the non-stream body is read rejects with AbortError', async () => {
    const ac = new AbortController();
    const p = makeProvider(
      jest.fn(async (_url, init) => ({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: () =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => {
              const err = new Error('This operation was aborted');
              err.name = 'AbortError';
              reject(err);
            });
          })
      }))
    );
    const run = p.analyze('x', { signal: ac.signal });
    setTimeout(() => ac.abort(), 5);
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('a network failure without a cancel is still NETWORK_ERROR', async () => {
    const p = makeProvider(
      jest.fn(async () => {
        throw new TypeError('fetch failed');
      })
    );
    await expect(
      p.chatStream({ prompt: 'q', signal: new AbortController().signal })
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });
});

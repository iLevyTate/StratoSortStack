'use strict';

describe('chat_with_documents tool', () => {
  let captured;
  const fakeMcp = {
    registerTool: (_n, _s, h) => {
      captured = h;
    }
  };

  const makeServices = (overrides = {}) => ({
    chat: {
      runOnce: jest.fn(async ({ query, sessionId }) => ({
        sessionId: sessionId || 'sess-1',
        answer: `Echo: ${query} [1]`,
        citations: [
          { id: 1, file_path: 'C:\\d\\a.pdf', file_name: 'a.pdf', snippet: 'Q4', chunk_index: 0 }
        ],
        tokens_used: { prompt: 100, completion: 20 }
      })),
      ...overrides.chat
    }
  });
  const {
    registerChatWithDocuments
  } = require('../../../../src/main/transports/mcp/tools/chatWithDocuments');

  test('returns answer + citations + session_id', async () => {
    const services = makeServices();
    registerChatWithDocuments(fakeMcp, services);
    const out = await captured({ query: 'what is in q4?', session_id: 'sess-1' });
    const body = JSON.parse(out.content[0].text);
    expect(body.answer).toContain('Echo:');
    expect(body.citations).toHaveLength(1);
    expect(body.session_id).toBe('sess-1');
  });

  test('always forces local-only inference (MCP privacy contract)', async () => {
    const services = makeServices();
    registerChatWithDocuments(fakeMcp, services);
    await captured({ query: 'what is in q4?', session_id: 'sess-1' });
    expect(services.chat.runOnce).toHaveBeenCalledWith(
      expect.objectContaining({ forceLocal: true })
    );
  });

  test('rejects empty query', async () => {
    registerChatWithDocuments(fakeMcp, makeServices());
    const out = await captured({ query: '' });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain('INVALID_QUERY');
  });

  test('serializes concurrent calls per session via mutex', async () => {
    let inFlight = 0;
    let max = 0;
    const services = makeServices({
      chat: {
        runOnce: jest.fn(async () => {
          inFlight++;
          max = Math.max(max, inFlight);
          await new Promise((r) => setTimeout(r, 20));
          inFlight--;
          return {
            sessionId: 'shared',
            answer: 'ok',
            citations: [],
            tokens_used: { prompt: 0, completion: 0 }
          };
        })
      }
    });
    registerChatWithDocuments(fakeMcp, services);
    await Promise.all([
      captured({ query: 'a', session_id: 'shared' }),
      captured({ query: 'b', session_id: 'shared' }),
      captured({ query: 'c', session_id: 'shared' })
    ]);
    expect(max).toBe(1);
  });
});

describe('chat_with_documents grounded flag', () => {
  test('passes grounded through and defaults it to false', async () => {
    let handler;
    const {
      registerChatWithDocuments
    } = require('../../../../src/main/transports/mcp/tools/chatWithDocuments');
    registerChatWithDocuments(
      { registerTool: (_n, _s, h) => (handler = h) },
      {
        chat: {
          runOnce: jest.fn(async () => ({
            sessionId: 's',
            answer: 'Nothing matched.',
            citations: [],
            grounded: false,
            tokens_used: { prompt: 1, completion: 1 }
          }))
        }
      }
    );
    const body = JSON.parse((await handler({ query: 'anything?' })).content[0].text);
    expect(body.grounded).toBe(false);
    expect(body.citations).toEqual([]);
  });
});

'use strict';
/**
 * Image content on the OpenAI-compatible request (cloud video frames), and
 * the shared frame filter both cloud providers send through.
 */
const {
  OpenAICompatibleProvider
} = require('../../../../src/main/services/ai/providers/OpenAICompatibleProvider');
const {
  MAX_IMAGES,
  normalizeImages,
  openAiUserContent
} = require('../../../../src/main/services/ai/providers/visionContent');

function mockFetchOk(body) {
  return jest.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body)
  }));
}

function makeProvider(fetchFn) {
  return new OpenAICompatibleProvider({
    getKey: () => 'sk-x',
    model: 'gpt-4o',
    baseUrl: 'https://api.openai.com/v1',
    fetchFn
  });
}

const OK_BODY = {
  choices: [{ message: { role: 'assistant', content: '{"category":"Work"}' } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
};

describe('OpenAICompatibleProvider image content', () => {
  test('analyze() sends up to four image_url data URLs ahead of the text', async () => {
    const fetchFn = mockFetchOk(OK_BODY);
    const p = makeProvider(fetchFn);
    const images = [1, 2, 3, 4, 5].map((n) => ({ mediaType: 'image/jpeg', data: `frame-${n}` }));

    await p.analyze('organize this video', { images });

    const body = JSON.parse(fetchFn.mock.calls[0][1].body);
    const user = body.messages.find((m) => m.role === 'user');
    expect(Array.isArray(user.content)).toBe(true);
    expect(user.content).toHaveLength(5);
    expect(user.content.filter((part) => part.type === 'image_url')).toHaveLength(4);
    expect(user.content[0]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/jpeg;base64,frame-1' }
    });
    expect(user.content[3].image_url.url).toBe('data:image/jpeg;base64,frame-4');
    expect(user.content[4]).toEqual({ type: 'text', text: 'organize this video' });
  });

  test('analyze() keeps the plain string content when no usable image is supplied', async () => {
    const fetchFn = mockFetchOk(OK_BODY);
    const p = makeProvider(fetchFn);

    await p.analyze('just text', { images: [{ mediaType: 'image/tiff', data: 'x' }] });

    const body = JSON.parse(fetchFn.mock.calls[0][1].body);
    const user = body.messages.find((m) => m.role === 'user');
    expect(user.content).toBe('just text');
  });
});

describe('visionContent.normalizeImages', () => {
  test('drops unsupported media types, empty or non-string data, and oversized frames', () => {
    const tooBig = 'a'.repeat(6_000_001);
    const out = normalizeImages([
      { mediaType: 'image/tiff', data: 'tiff' },
      { mediaType: 'image/png', data: '' },
      { mediaType: 'image/png', data: 42 },
      { mediaType: 'image/jpeg', data: tooBig },
      null,
      { mediaType: 'image/webp', data: 'ok-webp' },
      { mediaType: 'image/gif', data: 'ok-gif' }
    ]);
    expect(out).toEqual([
      { mediaType: 'image/webp', data: 'ok-webp' },
      { mediaType: 'image/gif', data: 'ok-gif' }
    ]);
  });

  test('a frame at the size limit is kept', () => {
    const atLimit = 'a'.repeat(6_000_000);
    expect(normalizeImages([{ mediaType: 'image/png', data: atLimit }])).toHaveLength(1);
  });

  test('caps at MAX_IMAGES after filtering, and non-arrays give no frames', () => {
    const bad = { mediaType: 'image/bmp', data: 'x' };
    const good = (n) => ({ mediaType: 'image/png', data: `f${n}` });
    const out = normalizeImages([bad, good(1), bad, good(2), good(3), good(4), good(5)]);
    expect(MAX_IMAGES).toBe(4);
    expect(out.map((f) => f.data)).toEqual(['f1', 'f2', 'f3', 'f4']);
    expect(normalizeImages(undefined)).toEqual([]);
    expect(normalizeImages({ mediaType: 'image/png', data: 'x' })).toEqual([]);
  });

  test('openAiUserContent stringifies a missing prompt and returns text alone without frames', () => {
    expect(openAiUserContent(undefined, [])).toBe('');
    expect(openAiUserContent('hi', null)).toBe('hi');
  });
});

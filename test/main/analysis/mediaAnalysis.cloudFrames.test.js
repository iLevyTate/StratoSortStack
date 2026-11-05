/**
 * Video frames go to a cloud Analysis provider only when the user turned on
 * "Describe video keyframes" AND accepted the consent text that names video
 * frames. Everything else stays on the transcript route.
 */

const fs = require('fs');
const path = require('path');

jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => '/mock/userData') }
}));

jest.mock('../../../src/shared/logger', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { createLogger: () => logger, createSafeLogger: () => logger, logger };
});

const mockRouter = {
  frameConsent: true,
  provider: null,
  choose: jest.fn(() => mockRouter.provider),
  hasFrameConsent: jest.fn(() => mockRouter.frameConsent)
};

jest.mock('../../../src/main/ipc/aiProvider', () => ({
  getActiveAiRouter: () => mockRouter
}));

const { analyzeMediaFile } = require('../../../src/main/analysis/mediaAnalysis');

function fakeWhisper() {
  return {
    transcribeMedia: jest.fn(async () => ({
      text: 'quarterly budget review',
      segments: [{ start: 0, end: 2, text: 'quarterly budget review' }],
      language: 'en',
      durationSeconds: 8
    }))
  };
}

// Writes real JPEG-ish files into the workspace the analyzer created, so the
// cloud call has bytes to read.
function frameWriter() {
  return jest.fn(async (_filePath, dir) => {
    const frames = [];
    for (let i = 0; i < 3; i += 1) {
      const framePath = path.join(dir, `frame-${i}.jpg`);
      fs.writeFileSync(framePath, Buffer.from(`jpeg-${i}`));
      frames.push({ timestamp: i * 2, framePath });
    }
    return frames;
  });
}

function cloudProvider() {
  return {
    id: 'anthropic',
    _model: 'claude-test',
    analyze: jest.fn(async () => ({
      text: '{"category":"Work","summary":"Budget review","confidence":80}'
    }))
  };
}

beforeEach(() => {
  mockRouter.frameConsent = true;
  mockRouter.provider = cloudProvider();
  mockRouter.choose.mockClear();
  mockRouter.hasFrameConsent.mockClear();
});

describe('cloud video frames', () => {
  test('with "Describe video keyframes" off, no frame is extracted or sent, even with consent', async () => {
    const extractKeyframes = frameWriter();
    const analyzeTextWithLlama = jest.fn(async () => ({ category: 'Work', confidence: 70 }));

    const result = await analyzeMediaFile(
      '/mock/meeting.mp4',
      { whisperService: fakeWhisper(), analyzeTextWithLlama, extractKeyframes, captionImage: null },
      { captionKeyframes: false }
    );

    expect(extractKeyframes).not.toHaveBeenCalled();
    expect(mockRouter.provider.analyze).not.toHaveBeenCalled();
    expect(analyzeTextWithLlama).toHaveBeenCalledTimes(1);
    expect(result.keyframes).toEqual([]);
  });

  test('consent given before video frames existed keeps frames local', async () => {
    mockRouter.frameConsent = false;
    const extractKeyframes = frameWriter();
    const captionImage = jest.fn(async () => 'a chart on a slide');
    const analyzeTextWithLlama = jest.fn(async () => ({ category: 'Work', confidence: 70 }));

    await analyzeMediaFile(
      '/mock/meeting.mp4',
      { whisperService: fakeWhisper(), analyzeTextWithLlama, extractKeyframes, captionImage },
      { captionKeyframes: true }
    );

    // Frames are still extracted for local captioning, but none is sent.
    expect(extractKeyframes).toHaveBeenCalledTimes(1);
    expect(mockRouter.provider.analyze).not.toHaveBeenCalled();
    expect(captionImage).toHaveBeenCalled();
    expect(analyzeTextWithLlama).toHaveBeenCalledTimes(1);
  });

  test('with the setting on and current consent, up to four frames go to the provider', async () => {
    const extractKeyframes = frameWriter();
    const analyzeTextWithLlama = jest.fn();

    const result = await analyzeMediaFile(
      '/mock/meeting.mp4',
      { whisperService: fakeWhisper(), analyzeTextWithLlama, extractKeyframes, captionImage: null },
      { captionKeyframes: true }
    );

    expect(mockRouter.provider.analyze).toHaveBeenCalledTimes(1);
    const options = mockRouter.provider.analyze.mock.calls[0][1];
    expect(options.images.length).toBeGreaterThan(0);
    expect(options.images.length).toBeLessThanOrEqual(4);
    expect(analyzeTextWithLlama).not.toHaveBeenCalled();
    expect(result.category).toBe('Work');
  });
});

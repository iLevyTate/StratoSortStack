'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const mockRouter = {
  frameConsent: true,
  provider: { id: 'anthropic', analyze: jest.fn() },
  choose: jest.fn(() => mockRouter.provider),
  hasFrameConsent: jest.fn(() => mockRouter.frameConsent)
};
jest.mock('../../../src/main/ipc/aiProvider', () => ({
  getActiveAiRouter: () => mockRouter
}));

const {
  analyzeVideoWithCloud,
  buildVideoPrompt,
  resolveCloudFrameProvider
} = require('../../../src/main/analysis/cloudMedia');

function writeFrame(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-media-'));
  const framePath = path.join(dir, 'frame.jpg');
  fs.writeFileSync(framePath, Buffer.from(contents));
  return { dir, framePath };
}

describe('resolveCloudFrameProvider', () => {
  beforeEach(() => {
    mockRouter.frameConsent = true;
    mockRouter.provider = { id: 'anthropic', analyze: jest.fn() };
    mockRouter.choose.mockClear();
  });

  test('returns the cloud analyze provider when consent covers video frames', async () => {
    await expect(resolveCloudFrameProvider('folder-1')).resolves.toBe(mockRouter.provider);
    expect(mockRouter.choose).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'analyze', smartFolderId: 'folder-1' })
    );
  });

  test('returns null when the stored consent predates video frames', async () => {
    mockRouter.frameConsent = false;
    await expect(resolveCloudFrameProvider(null)).resolves.toBeNull();
    expect(mockRouter.choose).not.toHaveBeenCalled();
  });

  test('returns null for the local provider', async () => {
    mockRouter.provider = { id: 'local', analyze: jest.fn() };
    await expect(resolveCloudFrameProvider(null)).resolves.toBeNull();
  });
});

describe('analyzeVideoWithCloud', () => {
  test('sends the transcript and jpeg frames to the provider and parses the JSON', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-media-'));
    const framePath = path.join(dir, 'frame.jpg');
    fs.writeFileSync(framePath, Buffer.from('jpeg-bytes'));
    const analyze = jest.fn(async (_prompt, options) => {
      expect(options.images).toEqual([
        { mediaType: 'image/jpeg', data: Buffer.from('jpeg-bytes').toString('base64') }
      ]);
      expect(_prompt).toContain('budget meeting');
      return { text: '{"category":"Work","summary":"A budget meeting","confidence":80}' };
    });

    const parsed = await analyzeVideoWithCloud({
      provider: { id: 'anthropic', _model: 'claude-sonnet-5-5', analyze },
      fileName: 'standup.mp4',
      transcript: '[00:00 → 00:04] budget meeting',
      frames: [{ framePath }, { framePath: path.join(dir, 'missing.jpg') }],
      smartFolders: [{ name: 'Work', description: 'Job files' }]
    });

    expect(parsed.category).toBe('Work');
    expect(parsed.provider).toBe('anthropic');
    expect(parsed.model).toBe('claude-sonnet-5-5');
    expect(analyze).toHaveBeenCalledTimes(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('returns null when every frame is unreadable so the transcript route can run', async () => {
    const analyze = jest.fn();
    const parsed = await analyzeVideoWithCloud({
      provider: { id: 'anthropic', analyze },
      fileName: 'silent.mp4',
      transcript: '',
      frames: [{ framePath: path.join(os.tmpdir(), 'does-not-exist-frame.jpg') }]
    });
    expect(parsed).toBeNull();
    expect(analyze).not.toHaveBeenCalled();
  });
});

describe('analyzeVideoWithCloud applies the transcript route checks', () => {
  test('folder match, name cleanup and field allowlist apply to the cloud reply', async () => {
    const { dir, framePath } = writeFrame('frames-allowlist');
    const analyze = jest.fn(async () => ({
      text: JSON.stringify({
        category: 'Cooking Videos',
        suggestedName: 'lecture.part1',
        confidence: 88,
        keywords: ['lecture'],
        isFallback: true,
        embeddingPolicy: 'skip',
        _embeddingForPersistence: { wasEnqueued: true, chunksEmbedded: true }
      })
    }));

    const result = await analyzeVideoWithCloud({
      provider: { id: 'anthropic', _model: 'claude-test', analyze },
      fileName: 'lecture-allowlist.mp4',
      transcript: 'today we cover derivatives',
      frames: [{ framePath }],
      smartFolders: [
        { name: 'School', description: 'Class notes and lectures' },
        { name: 'Uncategorized', description: 'Anything else' }
      ]
    });

    // Not one of the user's folders: lands in Uncategorized, offered as a new folder.
    expect(result.category).toBe('Uncategorized');
    expect(result.suggestedNewFolder).toBe('Cooking Videos');
    // The video keeps its own extension; ".part1" is not one.
    expect(result.suggestedName).toBe('lecture.mp4');
    expect(result).not.toHaveProperty('isFallback');
    expect(result).not.toHaveProperty('embeddingPolicy');
    expect(result).not.toHaveProperty('_embeddingForPersistence');
    expect(result.provider).toBe('anthropic');
    expect(result.model).toBe('claude-test');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('the prompt lets the model answer Uncategorized', () => {
    const prompt = buildVideoPrompt({
      fileName: 'a.mp4',
      transcript: '',
      smartFolders: [{ name: 'Work' }]
    });
    expect(prompt).toMatch(/Uncategorized/);
  });

  test('the same frames, transcript, model and folders are not uploaded twice unless bypassed', async () => {
    const { dir, framePath } = writeFrame('frames-cache');
    const analyze = jest.fn(async () => ({ text: '{"category":"Work","confidence":80}' }));
    const args = {
      provider: { id: 'anthropic', _model: 'claude-test', analyze },
      fileName: 'cache-check.mp4',
      transcript: 'weekly sync',
      frames: [{ framePath }],
      smartFolders: [{ name: 'Work' }]
    };

    const first = await analyzeVideoWithCloud(args);
    const second = await analyzeVideoWithCloud(args);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(second.category).toBe(first.category);

    await analyzeVideoWithCloud({ ...args, bypassCache: true });
    expect(analyze).toHaveBeenCalledTimes(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('analyzeVideoWithCloud and cancel', () => {
  test('a cancel before the upload sends nothing and stops the analysis', async () => {
    const { dir, framePath } = writeFrame('frames-cancel-before');
    const analyze = jest.fn();
    const controller = new AbortController();
    controller.abort();

    await expect(
      analyzeVideoWithCloud({
        provider: { id: 'anthropic', analyze },
        fileName: 'cancel-before.mp4',
        transcript: 'x',
        frames: [{ framePath }],
        signal: controller.signal
      })
    ).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' });
    expect(analyze).not.toHaveBeenCalled();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a cancel during the request stops the analysis instead of falling back', async () => {
    const { dir, framePath } = writeFrame('frames-cancel-during');
    const controller = new AbortController();
    // The provider turns an aborted fetch into a NETWORK_ERROR.
    const analyze = jest.fn(async () => {
      controller.abort();
      throw Object.assign(new Error('Failed to reach Anthropic: aborted'), {
        code: 'NETWORK_ERROR'
      });
    });

    await expect(
      analyzeVideoWithCloud({
        provider: { id: 'anthropic', analyze },
        fileName: 'cancel-during.mp4',
        transcript: 'x',
        frames: [{ framePath }],
        signal: controller.signal,
        bypassCache: true
      })
    ).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

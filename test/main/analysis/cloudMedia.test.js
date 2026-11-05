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
  resolveCloudFrameProvider
} = require('../../../src/main/analysis/cloudMedia');

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

/**
 * Regression: Tier 0 must exclude files newer than minAgeMs when mtimeMs is present
 * (scanner previously omitted mtimeMs, so minAgeHours was effectively ignored).
 */

jest.mock('../../../../src/shared/logger', () => {
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  };
  return { logger, createLogger: jest.fn(() => logger) };
});

const {
  FastTriageClassifier,
  BUCKET,
  SIGNAL
} = require('../../../../src/main/services/triage/FastTriageClassifier');

describe('FastTriageClassifier minAgeHours (too-recent)', () => {
  test('file modified within minAgeMs is excluded with too-recent', async () => {
    const classifier = new FastTriageClassifier({});
    const now = 1_700_000_000_000;
    const minAgeMs = 24 * 60 * 60 * 1000;
    const mtimeMs = now - 2 * 60 * 60 * 1000; // 2h ago — inside 24h window

    const result = await classifier.classifyFile(
      {
        filePath: '/home/user/Downloads/recent-download.zip',
        fileName: 'recent-download.zip',
        size: 1024,
        mtimeMs
      },
      {
        smartFolders: [],
        smartFolderPaths: [],
        exclusionGlobs: [],
        minAgeMs,
        nowMs: now
      }
    );

    expect(result.bucket).toBe(BUCKET.EXCLUDED);
    expect(result.signal).toBe(SIGNAL.TOO_RECENT);
    expect(result.why).toMatch(/Too recent/);
  });

  test('file older than minAgeMs is not excluded for recency alone', async () => {
    const classifier = new FastTriageClassifier({});
    const now = 1_700_000_000_000;
    const minAgeMs = 24 * 60 * 60 * 1000;
    const mtimeMs = now - 48 * 60 * 60 * 1000; // 48h ago

    const result = await classifier.classifyFile(
      {
        filePath: '/home/user/Downloads/old-file.txt',
        fileName: 'old-file.txt',
        size: 10,
        mtimeMs
      },
      {
        smartFolders: [],
        smartFolderPaths: [],
        exclusionGlobs: [],
        minAgeMs,
        nowMs: now
      }
    );

    expect(result.signal).not.toBe(SIGNAL.TOO_RECENT);
    expect(result.bucket).not.toBe(BUCKET.EXCLUDED);
  });
});

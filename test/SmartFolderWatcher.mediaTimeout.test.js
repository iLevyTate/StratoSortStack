/**
 * @jest-environment node
 *
 * The watcher gave every file ten minutes. A recording is transcribed in one
 * piece, and on the CPU while the text model has the GPU, so an hour of audio
 * takes longer than that: it was aborted, started again from the beginning on
 * each retry, and given up on. A Discover run allows a recording three hours.
 */
jest.mock('chokidar', () => ({
  watch: jest.fn(() => ({
    on: jest.fn().mockReturnThis(),
    once: jest.fn(),
    close: jest.fn().mockResolvedValue()
  }))
}));
jest.mock('../src/shared/logger', () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    setContext: jest.fn()
  };
  return { logger, createLogger: () => logger };
});

const SmartFolderWatcher = require('../src/main/services/SmartFolderWatcher');
const { TIMEOUTS } = require('../src/shared/performanceConstants');

const MINUTE = 60 * 1000;

function makeWatcher({ analyzeMediaFile = jest.fn() } = {}) {
  const watcher = new SmartFolderWatcher({
    getSmartFolders: () => [],
    analysisHistoryService: {},
    settingsService: { load: jest.fn().mockResolvedValue({}) },
    analyzeDocumentFile: jest.fn(),
    analyzeImageFile: jest.fn(),
    analyzeMediaFile
  });
  // An analysis that never ends, as a long transcription looks to the timer.
  watcher._analyzeFile = jest.fn(() => new Promise(() => {}));
  return watcher;
}

/** Runs the item and reports whether it was timed out after `ms`. */
async function timedOutAfter(watcher, filePath, ms) {
  let outcome = 'running';
  watcher._analyzeWithTimeout({ filePath }).catch(() => {
    outcome = 'timed out';
  });
  await jest.advanceTimersByTimeAsync(ms);
  return outcome;
}

describe('how long the watcher lets one file take', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test.each(['C:\\Watched\\meeting.mp3', 'C:\\Watched\\lecture.mp4', 'C:\\Watched\\memo.WAV'])(
    'a recording (%s) is still running after two hours',
    async (filePath) => {
      expect(await timedOutAfter(makeWatcher(), filePath, 120 * MINUTE)).toBe('running');
    }
  );

  test('a recording is stopped once the three hours are over', async () => {
    const watcher = makeWatcher();

    expect(await timedOutAfter(watcher, 'C:\\Watched\\meeting.mp3', 181 * MINUTE)).toBe(
      'timed out'
    );
    // The signal the analysis was given is aborted, as for any timeout.
    expect(watcher._analyzeFile.mock.calls[0][1].aborted).toBe(true);
  });

  test.each(['C:\\Watched\\invoice.pdf', 'C:\\Watched\\scan.png'])(
    'a document or an image (%s) keeps its ten minutes',
    async (filePath) => {
      const watcher = makeWatcher();

      expect(await timedOutAfter(watcher, filePath, 9 * MINUTE)).toBe('running');
      await jest.advanceTimersByTimeAsync(2 * MINUTE);
      expect(watcher._analyzeFile.mock.calls[0][1].aborted).toBe(true);
    }
  );

  test('without a media analyzer a recording keeps the document limit', async () => {
    const watcher = makeWatcher({ analyzeMediaFile: null });

    expect(await timedOutAfter(watcher, 'C:\\Watched\\meeting.mp3', 11 * MINUTE)).toBe('timed out');
  });

  test('the limits are the shared ones', () => {
    const watcher = makeWatcher();

    expect(watcher._analysisTimeoutMs('C:\\Watched\\meeting.mp3')).toBe(
      TIMEOUTS.BATCH_MEDIA_QUIET_MAX
    );
    expect(watcher._analysisTimeoutMs('C:\\Watched\\invoice.pdf')).toBe(TIMEOUTS.GLOBAL_ANALYSIS);
    expect(watcher._analysisTimeoutMs(undefined)).toBe(TIMEOUTS.GLOBAL_ANALYSIS);
  });
});

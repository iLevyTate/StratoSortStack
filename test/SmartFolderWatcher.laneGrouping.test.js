/**
 * @jest-environment node
 *
 * The watcher's one-at-a-time queue ran documents and audio/video in arrival
 * order, so an audio file between two documents swapped Whisper and the text
 * model twice. It now keeps taking the kind of file it just ran while one is
 * waiting, up to a streak limit, then returns to queue order.
 */
jest.mock('fs', () => jest.requireActual('fs'));
jest.mock('fs/promises', () => jest.requireActual('fs/promises'));
jest.mock('os', () => jest.requireActual('os'));
jest.mock('chokidar', () => ({
  watch: jest.fn(() => ({
    on: jest.fn().mockReturnThis(),
    once: jest.fn(),
    close: jest.fn().mockResolvedValue()
  }))
}));
jest.mock('../src/shared/logger', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { logger, createLogger: () => logger };
});

const path = require('path');
const SmartFolderWatcher = require('../src/main/services/SmartFolderWatcher');

const root = path.join(require('os').tmpdir(), 'sfw-lanes');

function makeWatcher(names) {
  const watcher = new SmartFolderWatcher({
    getSmartFolders: () => [{ id: 'f1', name: 'Inbox', path: root }],
    analysisHistoryService: { recordAnalysis: jest.fn(), getAnalysisByPath: jest.fn() },
    settingsService: { load: jest.fn().mockResolvedValue({}) },
    analyzeDocumentFile: jest.fn(),
    analyzeImageFile: jest.fn()
  });
  watcher.isRunning = true;
  watcher.maxConcurrentAnalysis = 1;
  const order = [];
  watcher._analyzeFile = jest.fn(async (item) => {
    order.push(path.basename(item.filePath));
  });
  for (const name of names) {
    watcher.analysisQueue.push({ filePath: path.join(root, name), mtime: 1, eventType: 'add' });
  }
  return { watcher, order };
}

async function drain(watcher, times) {
  for (let i = 0; i < times; i += 1) {
    await watcher._processQueue();
  }
}

test('documents and audio/video each run together', async () => {
  const { watcher, order } = makeWatcher(['a.pdf', 'talk.mp3', 'b.docx', 'clip.mp4', 'c.txt']);
  await drain(watcher, 5);
  expect(order).toEqual(['a.pdf', 'b.docx', 'c.txt', 'talk.mp3', 'clip.mp4']);
});

test('after the streak limit the queue order wins again', async () => {
  const docs = Array.from({ length: 30 }, (_, i) => `d${i}.pdf`);
  const { watcher, order } = makeWatcher(['d-first.pdf', 'song.mp3', ...docs]);
  await drain(watcher, 27);
  // 25 documents in a row, then the waiting audio file gets its turn.
  expect(order.slice(0, 25).every((name) => name.endsWith('.pdf'))).toBe(true);
  expect(order[25]).toBe('song.mp3');
});

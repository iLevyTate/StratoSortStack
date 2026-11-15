/**
 * Cancelling a model download after its last byte has arrived:
 * - during the SHA-256 check the model must not be renamed into place;
 * - while a vision model's projector (mmproj) downloads, cancelling the
 *   model must reach the projector download;
 * - while the file is being renamed the cancel is refused, since the rename
 *   cannot be undone.
 */
const { EventEmitter } = require('events');
const path = require('path');

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => require('path').join('C:', 'fake-user-data'))
  }
}));

const mockFs = {
  mkdir: jest.fn().mockResolvedValue(),
  readdir: jest.fn(),
  stat: jest.fn(),
  statfs: jest.fn(),
  unlink: jest.fn().mockResolvedValue(),
  rename: jest.fn().mockResolvedValue(),
  access: jest.fn()
};

jest.mock('fs', () => ({
  promises: mockFs,
  createWriteStream: jest.fn(),
  createReadStream: jest.fn()
}));

jest.mock('https', () => ({
  get: jest.fn()
}));

jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })
}));

// sha256 of empty input: the mocked read stream yields no bytes.
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

jest.mock('../src/shared/modelRegistry', () => {
  const sha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const catalog = {
    'alpha.gguf': {
      displayName: 'Alpha',
      type: 'text',
      size: 1000,
      url: 'https://huggingface.co/models/alpha.gguf',
      checksum: sha
    },
    'seer.gguf': {
      displayName: 'Seer',
      type: 'vision',
      size: 1000,
      url: 'https://huggingface.co/models/seer.gguf',
      checksum: sha,
      clipModel: {
        name: 'seer-mmproj.gguf',
        url: 'https://huggingface.co/models/seer-mmproj.gguf',
        size: 200,
        checksum: sha
      }
    }
  };
  return {
    MODEL_CATALOG: catalog,
    getModel: (name) => catalog[name] || null
  };
});

const https = require('https');
const fsModule = require('fs');
const { ModelDownloadManager } = require('../src/main/services/ModelDownloadManager');

const MODELS_DIR = path.join('C:', 'fake-user-data', 'models');

function makeRequest() {
  const request = new EventEmitter();
  request.setTimeout = jest.fn();
  request.destroy = jest.fn();
  return request;
}

/** A 200 response whose body "arrives" in full unless `hang` is set. */
function makeResponse(contentLength, { hang = false } = {}) {
  const response = new EventEmitter();
  response.statusCode = 200;
  response.statusMessage = 'OK';
  response.headers = { 'content-length': String(contentLength) };
  response.resume = jest.fn();
  response.unpipe = jest.fn();
  response.pipe = (ws) => {
    if (!hang) {
      setTimeout(() => {
        response.complete = true;
        ws.emit('finish');
      }, 0);
    }
    return ws;
  };
  return response;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('ModelDownloadManager cancel after the body has arrived', () => {
  /** @type {Set<string>} */
  let written;
  /** @type {Array<{ stream: EventEmitter }>} */
  let readStreams;

  beforeEach(() => {
    jest.clearAllMocks();
    written = new Set();
    readStreams = [];
    mockFs.statfs.mockResolvedValue({ bavail: 1024 * 1024 * 1024, bsize: 4096 });
    mockFs.unlink.mockResolvedValue(undefined);
    mockFs.rename.mockResolvedValue(undefined);
    mockFs.access.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    // A partial exists only once its write stream was opened; its size is the
    // catalog size so the size check passes.
    mockFs.stat.mockImplementation(async (filePath) => {
      if (!written.has(filePath)) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      return { size: filePath.includes('mmproj') ? 200 : 1000 };
    });
    fsModule.createWriteStream.mockImplementation((filePath) => {
      written.add(filePath);
      const ws = new EventEmitter();
      ws.destroy = jest.fn();
      ws.closed = true;
      return ws;
    });
  });

  /** Read streams that finish hashing only when the test says so. */
  function useSlowChecksum() {
    fsModule.createReadStream.mockImplementation(() => {
      const stream = new EventEmitter();
      stream.destroy = jest.fn();
      readStreams.push({ stream });
      return stream;
    });
  }

  function useFastChecksum() {
    fsModule.createReadStream.mockImplementation(() => {
      const stream = new EventEmitter();
      stream.destroy = jest.fn();
      setTimeout(() => stream.emit('end'), 0);
      return stream;
    });
  }

  test('a cancel during the checksum stops the install and drops the partial', async () => {
    useSlowChecksum();
    https.get.mockImplementation((_options, onResponse) => {
      setTimeout(() => onResponse(makeResponse(1000)), 0);
      return makeRequest();
    });
    const manager = new ModelDownloadManager();
    const download = manager.downloadModel('alpha.gguf');
    const outcome = download.then(
      (value) => ({ value }),
      (error) => ({ error })
    );

    // Wait until the body is written and the checksum read has started.
    for (let i = 0; i < 50 && readStreams.length === 0; i += 1) await flush();
    expect(readStreams).toHaveLength(1);

    expect(manager.cancelDownload('alpha.gguf')).toBe(true);
    // Even if the hash finishes afterwards, the result must stay cancelled.
    readStreams[0].stream.emit('end');

    const result = await outcome;
    expect(result.error?.message).toBe('Download cancelled');
    expect(readStreams[0].stream.destroy).toHaveBeenCalled();
    expect(mockFs.rename).not.toHaveBeenCalled();
    expect(mockFs.unlink).toHaveBeenCalledWith(path.join(MODELS_DIR, 'alpha.gguf.partial'));
    expect(manager.isDownloading('alpha.gguf')).toBe(false);
    expect(manager.getStatus().active).toBe(0);
  });

  test('cancelling a vision model while its projector downloads stops the projector', async () => {
    useFastChecksum();
    /** @type {Array<{ options: any, request: any }>} */
    const requests = [];
    https.get.mockImplementation((options, onResponse) => {
      const request = makeRequest();
      requests.push({ options, request });
      const isProjector = options.path.includes('mmproj');
      setTimeout(
        () => onResponse(makeResponse(isProjector ? 200 : 1000, { hang: isProjector })),
        0
      );
      return request;
    });
    const manager = new ModelDownloadManager();
    const outcome = manager.downloadModel('seer.gguf').then(
      (value) => ({ value }),
      (error) => ({ error })
    );

    for (let i = 0; i < 50 && requests.length < 2; i += 1) await flush();
    expect(requests).toHaveLength(2);
    await flush();
    // The model stays "in progress" while its projector is still coming.
    expect(manager.isDownloading('seer.gguf')).toBe(true);
    expect(manager.isDownloading('seer-mmproj.gguf')).toBe(true);

    expect(manager.cancelDownload('seer.gguf')).toBe(true);

    const result = await outcome;
    expect(result.error?.message).toBe('Download cancelled');
    expect(requests[1].request.destroy).toHaveBeenCalled();
    expect(manager.isDownloading('seer.gguf')).toBe(false);
    expect(manager.isDownloading('seer-mmproj.gguf')).toBe(false);
    expect(manager.getStatus().active).toBe(0);
  });

  test('a vision model with its projector still resolves and leaves no entry behind', async () => {
    useFastChecksum();
    https.get.mockImplementation((options, onResponse) => {
      const isProjector = options.path.includes('mmproj');
      setTimeout(() => onResponse(makeResponse(isProjector ? 200 : 1000)), 0);
      return makeRequest();
    });
    const manager = new ModelDownloadManager();
    const result = await manager.downloadModel('seer.gguf');
    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        degraded: false,
        downloadedBytes: 1200,
        totalBytes: 1200
      })
    );
    expect(mockFs.rename).toHaveBeenCalledTimes(2);
    expect(manager.getStatus().active).toBe(0);
  });

  test('a cancel while the file is renamed into place is refused', async () => {
    useFastChecksum();
    https.get.mockImplementation((_options, onResponse) => {
      setTimeout(() => onResponse(makeResponse(1000)), 0);
      return makeRequest();
    });
    /** @type {() => void} */
    let finishRename = () => {};
    mockFs.rename.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishRename = () => resolve(undefined);
        })
    );
    const manager = new ModelDownloadManager();
    const download = manager.downloadModel('alpha.gguf');

    for (let i = 0; i < 50 && mockFs.rename.mock.calls.length === 0; i += 1) await flush();
    expect(mockFs.rename).toHaveBeenCalledTimes(1);
    expect(manager.cancelDownload('alpha.gguf')).toBe(false);
    // A second start of the same file is still blocked during the rename.
    await expect(manager.downloadModel('alpha.gguf')).rejects.toThrow('already in progress');

    finishRename();
    await expect(download).resolves.toEqual(expect.objectContaining({ success: true }));
    expect(manager.getStatus().active).toBe(0);
  });

  test('the checksum helper still resolves without a signal', async () => {
    useFastChecksum();
    const manager = new ModelDownloadManager();
    await expect(manager._verifyChecksum('x', EMPTY_SHA)).resolves.toBe(true);
  });
});

/**
 * Resuming a model download from a saved `.partial`:
 * - a server that refuses the resume (HTTP 416, e.g. the partial already
 *   holds the whole file) must not wedge Setup forever: the partial goes and
 *   the download starts again from byte 0;
 * - the free-space check asks only for the bytes still to come.
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
  access: jest.fn().mockResolvedValue()
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

jest.mock('../src/shared/modelRegistry', () => {
  const catalog = {
    'alpha.gguf': {
      displayName: 'Alpha',
      type: 'text',
      size: 1000,
      url: 'https://huggingface.co/models/alpha.gguf',
      // sha256 of empty input: the mocked read stream yields no bytes.
      checksum: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
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

const PARTIAL = path.join('C:', 'fake-user-data', 'models', 'alpha.gguf.partial');

function makeRequest() {
  const request = new EventEmitter();
  request.setTimeout = jest.fn();
  request.destroy = jest.fn();
  return request;
}

function makeResponse(statusCode, statusMessage, headers = {}) {
  const response = new EventEmitter();
  response.statusCode = statusCode;
  response.statusMessage = statusMessage;
  response.headers = headers;
  response.resume = jest.fn();
  response.pipe = (ws) => {
    setTimeout(() => {
      response.complete = true;
      ws.emit('finish');
    }, 0);
    return ws;
  };
  return response;
}

describe('ModelDownloadManager resume', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFs.statfs.mockResolvedValue({ bavail: 1024 * 1024 * 1024, bsize: 4096 });
    mockFs.unlink.mockResolvedValue(undefined);
    mockFs.rename.mockResolvedValue(undefined);
    fsModule.createWriteStream.mockImplementation(() => {
      const ws = new EventEmitter();
      ws.destroy = jest.fn();
      return ws;
    });
    fsModule.createReadStream.mockImplementation(() => {
      const stream = new EventEmitter();
      setTimeout(() => stream.emit('end'), 0);
      return stream;
    });
  });

  test('HTTP 416 on a resume deletes the partial and starts again from byte 0', async () => {
    const manager = new ModelDownloadManager();
    // Attempt 1: a 100-byte partial. Attempt 2: none. Then the finished size.
    mockFs.stat
      .mockResolvedValueOnce({ size: 100 })
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'ENOENT' }))
      .mockResolvedValueOnce({ size: 1000 });

    const requestsSeen = [];
    https.get.mockImplementation((requestOptions, onResponse) => {
      requestsSeen.push(requestOptions);
      const response =
        requestsSeen.length === 1
          ? makeResponse(416, 'Range Not Satisfiable', { 'content-range': 'bytes */1000' })
          : makeResponse(200, 'OK', { 'content-length': '1000' });
      setTimeout(() => onResponse(response), 0);
      return makeRequest();
    });

    await expect(manager.downloadModel('alpha.gguf')).resolves.toEqual(
      expect.objectContaining({ success: true })
    );
    expect(requestsSeen).toHaveLength(2);
    expect(requestsSeen[0].headers.Range).toBe('bytes=100-');
    expect(requestsSeen[1].headers.Range).toBeUndefined();
    expect(mockFs.unlink).toHaveBeenCalledWith(PARTIAL);
    expect(fsModule.createWriteStream).toHaveBeenLastCalledWith(PARTIAL, { flags: 'w' });
  });

  test('HTTP 416 without a partial is still a plain error, with no second request', async () => {
    const manager = new ModelDownloadManager();
    mockFs.stat.mockRejectedValue(Object.assign(new Error('none'), { code: 'ENOENT' }));
    https.get.mockImplementation((_options, onResponse) => {
      setTimeout(() => onResponse(makeResponse(416, 'Range Not Satisfiable')), 0);
      return makeRequest();
    });

    await expect(manager.downloadModel('alpha.gguf')).rejects.toThrow('HTTP 416');
    expect(https.get).toHaveBeenCalledTimes(1);
  });

  test('the free-space check on a resume asks only for the bytes still to come', async () => {
    const manager = new ModelDownloadManager();
    const checkSpy = jest
      .spyOn(manager, 'checkDiskSpace')
      .mockImplementation(async (bytes) => ({ available: 550, sufficient: bytes <= 500 }));
    mockFs.stat.mockResolvedValueOnce({ size: 900 }).mockResolvedValueOnce({ size: 1000 });

    const requestsSeen = [];
    https.get.mockImplementation((requestOptions, onResponse) => {
      requestsSeen.push(requestOptions);
      setTimeout(
        () => onResponse(makeResponse(206, 'Partial Content', { 'content-length': '100' })),
        0
      );
      return makeRequest();
    });

    await expect(manager.downloadModel('alpha.gguf')).resolves.toEqual(
      expect.objectContaining({ success: true })
    );
    expect(checkSpy).toHaveBeenCalledWith(100);
    expect(requestsSeen[0].headers.Range).toBe('bytes=900-');
  });

  test('a fresh download still needs room for the whole file', async () => {
    const manager = new ModelDownloadManager();
    jest
      .spyOn(manager, 'checkDiskSpace')
      .mockImplementation(async (bytes) => ({ available: 0, sufficient: bytes <= 500 }));
    mockFs.stat.mockRejectedValue(Object.assign(new Error('none'), { code: 'ENOENT' }));

    await expect(manager.downloadModel('alpha.gguf')).rejects.toThrow('Insufficient disk space');
    expect(https.get).not.toHaveBeenCalled();
  });
});

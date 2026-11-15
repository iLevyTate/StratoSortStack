/**
 * Two near-simultaneous requests for the same model must not both start.
 *
 * The in-progress guard ran before the partial-file and disk-space awaits,
 * and the slot was only claimed after them, so both requests passed the
 * guard and streamed into the same `.partial`. The slot is now claimed right
 * after the guard and released on every exit before the request opens.
 */
const { EventEmitter } = require('events');

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

jest.mock('../src/shared/modelRegistry', () => {
  const sha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const catalog = {
    'alpha.gguf': {
      displayName: 'Alpha',
      type: 'text',
      size: 1000,
      url: 'https://huggingface.co/models/alpha.gguf',
      checksum: sha
    }
  };
  return {
    MODEL_CATALOG: catalog,
    getModel: (name) => catalog[name] || null
  };
});

const https = require('https');
const { ModelDownloadManager } = require('../src/main/services/ModelDownloadManager');

function makeRequest() {
  const request = new EventEmitter();
  request.setTimeout = jest.fn();
  request.destroy = jest.fn();
  return request;
}

describe('ModelDownloadManager claims the download slot before its first await', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFs.statfs.mockResolvedValue({ bavail: 1024 * 1024 * 1024, bsize: 4096 });
    mockFs.stat.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    // The request never answers: the first download stays in flight.
    https.get.mockImplementation(() => makeRequest());
  });

  test('a second request started in the same tick is refused and opens no stream', async () => {
    const manager = new ModelDownloadManager();
    const first = manager.downloadModel('alpha.gguf');
    first.catch(() => {});
    const second = manager.downloadModel('alpha.gguf');

    await expect(second).rejects.toThrow('Download already in progress: alpha.gguf');
    // Let the first request get past its partial and disk checks.
    for (let i = 0; i < 20 && https.get.mock.calls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(https.get).toHaveBeenCalledTimes(1);
    expect(manager.isDownloading('alpha.gguf')).toBe(true);

    manager.cancelDownload('alpha.gguf');
    await expect(first).rejects.toThrow();
  });

  test('a start that fails its disk-space check releases the slot', async () => {
    mockFs.statfs.mockResolvedValue({ bavail: 0, bsize: 4096 });
    const manager = new ModelDownloadManager();

    await expect(manager.downloadModel('alpha.gguf')).rejects.toThrow(/disk space/i);
    expect(manager.isDownloading('alpha.gguf')).toBe(false);
    expect(manager.getStatus().active).toBe(0);
    expect(https.get).not.toHaveBeenCalled();
  });
});

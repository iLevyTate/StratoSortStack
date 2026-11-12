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

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
};

jest.mock('../src/shared/logger', () => ({
  createLogger: () => mockLogger
}));

jest.mock('../src/shared/modelRegistry', () => {
  const catalog = {
    'alpha.gguf': {
      displayName: 'Alpha',
      type: 'text',
      size: 2048,
      url: 'https://huggingface.co/models/alpha.gguf',
      checksum: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    }
  };
  return {
    MODEL_CATALOG: catalog,
    getModel: (name) => {
      if (!name) return null;
      if (catalog[name]) return catalog[name];
      const lower = name.toLowerCase();
      for (const [key, value] of Object.entries(catalog)) {
        if (key.toLowerCase() === lower) return value;
      }
      return null;
    }
  };
});

const https = require('https');
const fsModule = require('fs');
const { MODEL_CATALOG } = require('../src/shared/modelRegistry');
const { ModelDownloadManager } = require('../src/main/services/ModelDownloadManager');
const BASE_MODEL = { ...MODEL_CATALOG['alpha.gguf'] };

describe('ModelDownloadManager', () => {
  beforeEach(() => {
    mockFs.readdir.mockReset();
    mockFs.stat.mockReset();
    mockFs.unlink.mockReset();
    mockFs.rename.mockReset();
    mockFs.access.mockReset();
    mockFs.statfs.mockReset();
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();
    mockLogger.debug.mockReset();
    // Default: plenty of free space (~4 TB). checkDiskSpace now fails closed
    // on an errored probe, so tests that aren't about disk space need a
    // healthy default rather than an undefined resolution.
    mockFs.statfs.mockResolvedValue({ bavail: 1024 * 1024 * 1024, bsize: 4096 });
    https.get.mockReset();
    fsModule.createWriteStream.mockReset();
    fsModule.createReadStream.mockReset();
    fsModule.createReadStream.mockImplementation(() => {
      const stream = new EventEmitter();
      setTimeout(() => stream.emit('end'), 0);
      return stream;
    });
    MODEL_CATALOG['alpha.gguf'] = { ...BASE_MODEL };
  });

  test('downloadModel rejects non-HTTPS URLs', async () => {
    const manager = new ModelDownloadManager();
    MODEL_CATALOG['alpha.gguf'] = {
      ...BASE_MODEL,
      url: 'http://huggingface.co/models/alpha.gguf'
    };

    await expect(manager.downloadModel('alpha.gguf')).rejects.toThrow(
      'Blocked non-HTTPS model download'
    );
    expect(https.get).not.toHaveBeenCalled();
  });

  test('downloadModel rejects untrusted hosts', async () => {
    const manager = new ModelDownloadManager();
    MODEL_CATALOG['alpha.gguf'] = {
      ...BASE_MODEL,
      url: 'https://example.com/models/alpha.gguf'
    };

    await expect(manager.downloadModel('alpha.gguf')).rejects.toThrow(
      'Blocked download from untrusted host'
    );
    expect(https.get).not.toHaveBeenCalled();
  });

  test('downloadModel rejects models without a valid checksum', async () => {
    const manager = new ModelDownloadManager();
    MODEL_CATALOG['alpha.gguf'] = {
      ...BASE_MODEL,
      checksum: ''
    };

    await expect(manager.downloadModel('alpha.gguf')).rejects.toThrow(
      'Model checksum missing or invalid'
    );
    expect(https.get).not.toHaveBeenCalled();
  });

  test('getDownloadedModels returns empty on error', async () => {
    mockFs.readdir.mockRejectedValueOnce(new Error('fail'));
    const manager = new ModelDownloadManager();
    const result = await manager.getDownloadedModels();
    expect(result).toEqual([]);
  });

  test('getDownloadedModels logs a warning for a real read fault (non-ENOENT)', async () => {
    // Persistent reject: resolveModelsPath also probes the dir via fs.readdir
    // (swallowed to []), so a one-time rejection would be consumed before
    // getDownloadedModels makes its own read.
    const eacces = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    mockFs.readdir.mockRejectedValue(eacces);
    const manager = new ModelDownloadManager();
    const result = await manager.getDownloadedModels();
    expect(result).toEqual([]);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to read models directory'),
      expect.objectContaining({ code: 'EACCES' })
    );
  });

  test('getDownloadedModels does not warn when the models dir is absent (ENOENT)', async () => {
    const enoent = Object.assign(new Error('no such dir'), { code: 'ENOENT' });
    mockFs.readdir.mockRejectedValue(enoent);
    const manager = new ModelDownloadManager();
    const result = await manager.getDownloadedModels();
    expect(result).toEqual([]);
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('Failed to read models directory'),
      expect.anything()
    );
  });

  test('getDownloadedModels maps gguf files with registry info', async () => {
    mockFs.readdir.mockResolvedValue(['alpha.gguf', 'note.txt']);
    mockFs.stat.mockResolvedValueOnce({ size: 1024 * 1024 * 2 });

    const manager = new ModelDownloadManager();
    const result = await manager.getDownloadedModels();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      filename: 'alpha.gguf',
      sizeMB: 2,
      type: 'text',
      displayName: 'Alpha',
      isComplete: true
    });
  });

  test('getDownloadedModels keeps healthy models when one file stat rejects (F-051)', async () => {
    // Two gguf files; one stat faults with a real read error (EBUSY). The
    // healthy file must still be reported (no fail-fast collapse to []), and the
    // faulting file gets a per-file warning so the partial list is not silent.
    mockFs.readdir.mockResolvedValue(['alpha.gguf', 'beta.gguf']);
    mockFs.stat.mockImplementation(async (p) => {
      if (String(p).endsWith('alpha.gguf')) return { size: 1024 * 1024 * 3 };
      throw Object.assign(new Error('locked'), { code: 'EBUSY' });
    });

    const manager = new ModelDownloadManager();
    const result = await manager.getDownloadedModels();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ filename: 'alpha.gguf', sizeMB: 3 });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to stat a model file'),
      expect.objectContaining({ filename: 'beta.gguf', code: 'EBUSY' })
    );
  });

  test('getDownloadedModels skips a per-file ENOENT silently (rename race)', async () => {
    // A .partial → final rename between readdir and stat surfaces as a per-file
    // ENOENT — expected churn, so skip it without warning, keep the rest.
    mockFs.readdir.mockResolvedValue(['alpha.gguf', 'beta.gguf']);
    mockFs.stat.mockImplementation(async (p) => {
      if (String(p).endsWith('alpha.gguf')) return { size: 1024 * 1024 * 2 };
      throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    });

    const manager = new ModelDownloadManager();
    const result = await manager.getDownloadedModels();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ filename: 'alpha.gguf', sizeMB: 2 });
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('Failed to stat a model file'),
      expect.anything()
    );
  });

  test('checkDiskSpace returns available and sufficient via fs.statfs', async () => {
    // bavail * bsize = 2GB user-available space
    mockFs.statfs.mockResolvedValueOnce({ bavail: 524288, bsize: 4096 });
    const manager = new ModelDownloadManager();
    const result = await manager.checkDiskSpace(1024);
    expect(result.available).toBe(524288 * 4096);
    expect(result.sufficient).toBe(true);
  });

  test('checkDiskSpace returns insufficient when space is tight', async () => {
    // bavail * bsize = 100 bytes (less than requiredBytes * 1.1)
    mockFs.statfs.mockResolvedValueOnce({ bavail: 25, bsize: 4 });
    const manager = new ModelDownloadManager();
    const result = await manager.checkDiskSpace(1024);
    expect(result.available).toBe(100);
    expect(result.sufficient).toBe(false);
  });

  test('checkDiskSpace fails closed on statfs failure', async () => {
    mockFs.statfs.mockRejectedValueOnce(new Error('fail'));
    const manager = new ModelDownloadManager();
    const result = await manager.checkDiskSpace(1024);
    expect(result.sufficient).toBe(false);
    expect(result.checkFailed).toBe(true);
    expect(result.error).toBe('fail');
  });

  test('isDownloading returns true for active downloads and false otherwise', () => {
    const manager = new ModelDownloadManager();
    expect(manager.isDownloading('alpha.gguf')).toBe(false);

    // Simulate an active download entry
    manager._downloads.set('alpha.gguf', { status: 'downloading' });
    expect(manager.isDownloading('alpha.gguf')).toBe(true);

    // Redirecting counts as active
    manager._downloads.set('alpha.gguf', { status: 'redirecting' });
    expect(manager.isDownloading('alpha.gguf')).toBe(true);

    // Completed does not count
    manager._downloads.set('alpha.gguf', { status: 'complete' });
    expect(manager.isDownloading('alpha.gguf')).toBe(false);

    manager._downloads.delete('alpha.gguf');
    expect(manager.isDownloading('alpha.gguf')).toBe(false);
  });

  test('onProgress registers and unregisters callbacks', () => {
    const manager = new ModelDownloadManager();
    const cb = jest.fn();
    const unsubscribe = manager.onProgress(cb);

    manager._notifyProgress({ percent: 5 });
    expect(cb).toHaveBeenCalledTimes(1);

    unsubscribe();
    manager._notifyProgress({ percent: 10 });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  // Speed is the rate over the last ten seconds, measured from the first
  // byte. An average since the request was created counted the time spent
  // connecting, so the first seconds produced estimates of days.
  describe('download speed and time left', () => {
    const T0 = 1_000_000;
    /** Feed `bytesPerSecond` for `seconds`, one chunk every 250 ms. */
    const feed = (manager, state, from, seconds, bytesPerSecond) => {
      const steps = seconds * 4;
      for (let i = 1; i <= steps; i += 1) {
        state.downloadedBytes += bytesPerSecond / 4;
        manager._recordSpeedSample(state, from + i * 250);
      }
      return from + seconds * 1000;
    };
    const newState = (downloadedBytes = 0, totalBytes = 10_000_000) => ({
      downloadedBytes,
      totalBytes,
      speedSamples: []
    });

    test('reports nothing before the first byte', () => {
      const manager = new ModelDownloadManager();
      const state = newState();

      expect(manager._calculateSpeed(state, T0)).toBe(0);
      expect(manager._calculateETA(state, T0)).toBe(Infinity);
    });

    test('waits for three seconds of data before giving a figure', () => {
      const manager = new ModelDownloadManager();
      const state = newState();
      manager._recordSpeedSample(state, T0);

      const at2s = feed(manager, state, T0, 2, 1000);
      expect(manager._calculateSpeed(state, at2s)).toBe(0);
      expect(manager._calculateETA(state, at2s)).toBe(Infinity);

      const at3s = feed(manager, state, at2s, 1, 1000);
      expect(manager._calculateSpeed(state, at3s)).toBe(1000);
      expect(manager._calculateETA(state, at3s)).toBe((10_000_000 - 3000) / 1000);
    });

    test('follows the current rate, not the average since the start', () => {
      const manager = new ModelDownloadManager();
      const state = newState();
      manager._recordSpeedSample(state, T0);

      const slowEnd = feed(manager, state, T0, 20, 1000);
      expect(manager._calculateSpeed(state, slowEnd)).toBe(1000);

      const fastEnd = feed(manager, state, slowEnd, 10, 100_000);
      expect(manager._calculateSpeed(state, fastEnd)).toBe(100_000);
    });

    test('a resumed download does not count the bytes already on disk', () => {
      const manager = new ModelDownloadManager();
      const state = newState(5_000_000);
      state.downloadedBytes += 250;
      manager._recordSpeedSample(state, T0);

      const at4s = feed(manager, state, T0, 4, 1000);
      expect(manager._calculateSpeed(state, at4s)).toBe(1000);
    });

    test('keeps only the samples the window needs', () => {
      const manager = new ModelDownloadManager();
      const state = newState();
      manager._recordSpeedSample(state, T0);
      const end = feed(manager, state, T0, 60, 1000);

      expect(state.speedSamples.length).toBeLessThanOrEqual(42);
      expect(end - state.speedSamples[0].time).toBe(10_000);
    });

    test('chunks that arrive within a quarter second share one sample', () => {
      const manager = new ModelDownloadManager();
      const state = newState();
      manager._recordSpeedSample(state, T0);
      manager._recordSpeedSample(state, T0 + 10);
      manager._recordSpeedSample(state, T0 + 249);

      expect(state.speedSamples).toHaveLength(1);
    });
  });

  test('deleteModel removes files', async () => {
    const manager = new ModelDownloadManager();
    const result = await manager.deleteModel('alpha.gguf');
    expect(result.success).toBe(true);
    expect(mockFs.unlink).toHaveBeenCalledTimes(2);
  });

  test('_cleanupPartialFile swallows unlink errors', async () => {
    const manager = new ModelDownloadManager();
    mockFs.unlink.mockRejectedValueOnce(new Error('missing'));

    await expect(
      manager._cleanupPartialFile(
        require('path').join('C:', 'fake-user-data', 'models', 'alpha.gguf.partial')
      )
    ).resolves.toBeUndefined();
  });

  test('downloadModel cleans partial file on size mismatch', async () => {
    const manager = new ModelDownloadManager();
    const partialPath = require('path').join(
      'C:',
      'fake-user-data',
      'models',
      'alpha.gguf.partial'
    );

    // No partial at start, then mismatched size at finish check.
    mockFs.stat.mockRejectedValueOnce(new Error('no partial'));
    mockFs.stat.mockResolvedValueOnce({ size: 1234 });
    mockFs.unlink.mockResolvedValue(undefined);

    const writeStream = new EventEmitter();
    writeStream.destroy = jest.fn();
    fsModule.createWriteStream.mockReturnValue(writeStream);

    https.get.mockImplementation((_options, onResponse) => {
      const request = new EventEmitter();
      request.setTimeout = jest.fn();
      request.destroy = jest.fn();

      const response = new EventEmitter();
      response.statusCode = 200;
      response.statusMessage = 'OK';
      response.headers = {};
      response.resume = jest.fn();
      response.pipe = () => {
        setTimeout(() => writeStream.emit('finish'), 0);
        return writeStream;
      };

      setTimeout(() => onResponse(response), 0);
      return request;
    });

    await expect(manager.downloadModel('alpha.gguf', { _maxRetries: 0 })).rejects.toThrow(
      'Download incomplete - file size mismatch'
    );
    expect(mockFs.unlink).toHaveBeenCalledWith(partialPath);
  });

  test('downloadModel retries after size mismatch and succeeds', async () => {
    const manager = new ModelDownloadManager();
    fsModule.createWriteStream.mockImplementation(() => {
      const ws = new EventEmitter();
      ws.destroy = jest.fn();
      return ws;
    });

    // Attempt 1: no partial + mismatch. Attempt 2: no partial + correct size.
    mockFs.stat
      .mockRejectedValueOnce(new Error('no partial'))
      .mockResolvedValueOnce({ size: 1234 })
      .mockRejectedValueOnce(new Error('no partial'))
      .mockResolvedValueOnce({ size: 2048 });
    mockFs.unlink.mockResolvedValue(undefined);

    https.get.mockImplementation((_options, onResponse) => {
      const request = new EventEmitter();
      request.setTimeout = jest.fn();
      request.destroy = jest.fn();

      const response = new EventEmitter();
      response.statusCode = 200;
      response.statusMessage = 'OK';
      response.headers = {};
      response.resume = jest.fn();
      response.pipe = (ws) => {
        setTimeout(() => ws.emit('finish'), 0);
        return ws;
      };

      setTimeout(() => onResponse(response), 0);
      return request;
    });

    await expect(manager.downloadModel('alpha.gguf')).resolves.toEqual(
      expect.objectContaining({ success: true })
    );
    expect(https.get).toHaveBeenCalledTimes(2);
    expect(mockFs.unlink).toHaveBeenCalledWith(
      require('path').join('C:', 'fake-user-data', 'models', 'alpha.gguf.partial')
    );
  });

  test('downloadModel resolves relative redirect locations', async () => {
    const manager = new ModelDownloadManager();
    const writeStream = new EventEmitter();
    writeStream.destroy = jest.fn();
    fsModule.createWriteStream.mockReturnValue(writeStream);

    mockFs.stat.mockRejectedValueOnce(new Error('no partial'));
    mockFs.stat.mockRejectedValueOnce(new Error('no partial after redirect'));
    mockFs.stat.mockResolvedValueOnce({ size: 2048 });

    const requestOptionsSeen = [];
    let callCount = 0;
    https.get.mockImplementation((requestOptions, onResponse) => {
      callCount++;
      requestOptionsSeen.push(requestOptions);

      const request = new EventEmitter();
      request.setTimeout = jest.fn();
      request.destroy = jest.fn();

      const response = new EventEmitter();
      response.headers = {};
      response.resume = jest.fn();

      if (callCount === 1) {
        response.statusCode = 302;
        response.statusMessage = 'Found';
        response.headers.location = '/models/alpha.gguf?download=1';
        setTimeout(() => onResponse(response), 0);
        return request;
      }

      response.statusCode = 200;
      response.statusMessage = 'OK';
      response.pipe = () => {
        setTimeout(() => writeStream.emit('finish'), 0);
        return writeStream;
      };
      setTimeout(() => onResponse(response), 0);
      return request;
    });

    await expect(manager.downloadModel('alpha.gguf')).resolves.toEqual(
      expect.objectContaining({ success: true })
    );
    expect(requestOptionsSeen).toHaveLength(2);
    expect(requestOptionsSeen[1].path).toContain('/models/alpha.gguf?download=1');
    expect(mockFs.rename).toHaveBeenCalledTimes(1);
  });

  test('downloadModel honors pre-aborted external signals', async () => {
    const manager = new ModelDownloadManager();
    const controller = new AbortController();
    controller.abort();

    mockFs.stat.mockRejectedValueOnce(new Error('no partial'));

    await expect(
      manager.downloadModel('alpha.gguf', {
        signal: controller.signal
      })
    ).rejects.toThrow('Download cancelled');
    expect(https.get).not.toHaveBeenCalled();
  });

  test('downloadModel preserves partial file on timeout for resume', async () => {
    const manager = new ModelDownloadManager();

    mockFs.stat.mockRejectedValueOnce(new Error('no partial'));

    https.get.mockImplementation((_requestOptions, _onResponse) => {
      const request = new EventEmitter();
      request.destroy = jest.fn();
      request.setTimeout = jest.fn((_ms, cb) => setTimeout(cb, 0));
      return request;
    });

    await expect(manager.downloadModel('alpha.gguf', { _maxRetries: 0 })).rejects.toThrow(
      'Download timeout'
    );
    expect(mockFs.unlink).not.toHaveBeenCalled();
  });

  test('downloadModel discards stale oversized partial before starting', async () => {
    const manager = new ModelDownloadManager();
    const writeStream = new EventEmitter();
    writeStream.destroy = jest.fn();
    fsModule.createWriteStream.mockReturnValue(writeStream);

    mockFs.stat.mockResolvedValueOnce({ size: 4096 });
    mockFs.unlink.mockResolvedValueOnce(undefined);
    mockFs.stat.mockResolvedValueOnce({ size: 2048 });

    const requestOptionsSeen = [];
    https.get.mockImplementation((requestOptions, onResponse) => {
      requestOptionsSeen.push(requestOptions);
      const request = new EventEmitter();
      request.setTimeout = jest.fn();
      request.destroy = jest.fn();

      const response = new EventEmitter();
      response.statusCode = 200;
      response.statusMessage = 'OK';
      response.headers = {};
      response.resume = jest.fn();
      response.pipe = () => {
        setTimeout(() => writeStream.emit('finish'), 0);
        return writeStream;
      };
      setTimeout(() => onResponse(response), 0);
      return request;
    });

    await expect(manager.downloadModel('alpha.gguf')).resolves.toEqual(
      expect.objectContaining({ success: true })
    );
    expect(mockFs.unlink).toHaveBeenCalledWith(
      require('path').join('C:', 'fake-user-data', 'models', 'alpha.gguf.partial')
    );
    expect(requestOptionsSeen[0].headers.Range).toBeUndefined();
  });

  test('downloadModel clears _downloads when redirect URL fails validation (no stuck state)', async () => {
    // Regression: a malicious or misconfigured 302 to file:// (or any other
    // non-allowed scheme) previously mutated downloadState.status to
    // 'redirecting' BEFORE validation, and the validation throw escaped
    // without going through finalizeFailure. The entry stayed in
    // this._downloads forever and blocked legitimate retries.
    const manager = new ModelDownloadManager();
    mockFs.stat.mockRejectedValueOnce(new Error('no partial'));

    https.get.mockImplementation((_requestOptions, onResponse) => {
      const request = new EventEmitter();
      request.setTimeout = jest.fn();
      request.destroy = jest.fn();

      const response = new EventEmitter();
      response.statusCode = 302;
      response.statusMessage = 'Found';
      response.headers = { location: 'file:///etc/passwd' }; // disallowed scheme
      response.resume = jest.fn();
      setTimeout(() => onResponse(response), 0);
      return request;
    });

    await expect(manager.downloadModel('alpha.gguf', { _maxRetries: 0 })).rejects.toThrow(
      /Blocked|untrusted|non-HTTPS/i
    );

    // _downloads entry MUST be cleared so a retry can proceed
    expect(manager._downloads.has('alpha.gguf')).toBe(false);
    expect(manager.isDownloading('alpha.gguf')).toBe(false);
  });

  describe('connection closed before the body is complete', () => {
    // A clean early close (FIN before Content-Length is satisfied) makes Node
    // emit 'aborted' and 'close' on the response, with no 'end' and no error
    // on the request, so the piped write stream never finishes.
    const makeWriteStream = () => {
      const ws = new EventEmitter();
      ws.destroy = jest.fn(() => {
        ws.destroyed = true;
        setTimeout(() => ws.emit('close'), 0);
      });
      return ws;
    };
    const makeRequest = () => {
      const request = new EventEmitter();
      request.setTimeout = jest.fn();
      request.destroy = jest.fn();
      return request;
    };
    const makeTruncatedResponse = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.statusMessage = 'OK';
      response.headers = { 'content-length': '2048' };
      response.complete = false;
      response.resume = jest.fn();
      response.unpipe = jest.fn();
      response.pipe = (ws) => {
        setTimeout(() => {
          response.emit('data', Buffer.alloc(1000));
          response.emit('aborted');
          response.emit('close');
        }, 0);
        return ws;
      };
      return response;
    };

    afterEach(() => {
      jest.useRealTimers();
    });

    test('downloadModel fails instead of hanging and keeps the partial for resume', async () => {
      jest.useFakeTimers();
      const manager = new ModelDownloadManager();
      const writeStream = makeWriteStream();
      fsModule.createWriteStream.mockReturnValue(writeStream);
      mockFs.stat.mockRejectedValueOnce(new Error('no partial'));

      https.get.mockImplementation((_options, onResponse) => {
        setTimeout(() => onResponse(makeTruncatedResponse()), 0);
        return makeRequest();
      });

      /** @type {any} */
      let outcome = null;
      manager.downloadModel('alpha.gguf', { _maxRetries: 0 }).then(
        (value) => {
          outcome = { resolved: value };
        },
        (error) => {
          outcome = { rejected: error };
        }
      );
      await jest.advanceTimersByTimeAsync(100);

      expect(outcome?.rejected?.code).toBe('ECONNRESET');
      expect(writeStream.destroy).toHaveBeenCalled();
      expect(manager.isDownloading('alpha.gguf')).toBe(false);
      expect(manager._downloads.has('alpha.gguf')).toBe(false);
      expect(mockFs.unlink).not.toHaveBeenCalled();
    });

    test('downloadModel retries with a Range request from the partial', async () => {
      jest.useFakeTimers();
      const manager = new ModelDownloadManager();
      fsModule.createWriteStream.mockImplementation(makeWriteStream);

      // Attempt 1: no partial. Attempt 2: 1000 bytes on disk, then full size.
      mockFs.stat
        .mockRejectedValueOnce(new Error('no partial'))
        .mockResolvedValueOnce({ size: 1000 })
        .mockResolvedValueOnce({ size: 2048 });

      const requestOptionsSeen = [];
      https.get.mockImplementation((requestOptions, onResponse) => {
        requestOptionsSeen.push(requestOptions);
        if (requestOptionsSeen.length === 1) {
          setTimeout(() => onResponse(makeTruncatedResponse()), 0);
          return makeRequest();
        }
        const response = new EventEmitter();
        response.statusCode = 206;
        response.statusMessage = 'Partial Content';
        response.headers = { 'content-length': '1048' };
        response.resume = jest.fn();
        response.pipe = (ws) => {
          setTimeout(() => {
            response.complete = true;
            ws.emit('finish');
            response.emit('close');
          }, 0);
          return ws;
        };
        setTimeout(() => onResponse(response), 0);
        return makeRequest();
      });

      /** @type {any} */
      let outcome = null;
      manager.downloadModel('alpha.gguf').then(
        (value) => {
          outcome = { resolved: value };
        },
        (error) => {
          outcome = { rejected: error };
        }
      );
      await jest.advanceTimersByTimeAsync(5000);

      expect(outcome?.resolved).toEqual(expect.objectContaining({ success: true }));
      expect(requestOptionsSeen).toHaveLength(2);
      expect(requestOptionsSeen[0].headers.Range).toBeUndefined();
      expect(requestOptionsSeen[1].headers.Range).toBe('bytes=1000-');
      expect(fsModule.createWriteStream).toHaveBeenLastCalledWith(
        expect.stringContaining('alpha.gguf.partial'),
        { flags: 'a' }
      );
      expect(mockFs.unlink).not.toHaveBeenCalled();
      expect(mockFs.rename).toHaveBeenCalledTimes(1);
      expect(manager.isDownloading('alpha.gguf')).toBe(false);
    });
  });

  describe('_wrapWriteStreamError', () => {
    test('maps ENOSPC to "Disk full" message and preserves code + cause', () => {
      const manager = new ModelDownloadManager();
      const raw = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      const wrapped = manager._wrapWriteStreamError(raw, 'alpha.gguf');
      expect(wrapped.message).toMatch(/Disk full/);
      expect(wrapped.message).toContain('alpha.gguf');
      expect(wrapped.code).toBe('ENOSPC');
      expect(wrapped.cause).toBe(raw);
    });

    test('maps EACCES and EPERM to permission-denied messages', () => {
      const manager = new ModelDownloadManager();
      for (const code of ['EACCES', 'EPERM']) {
        const raw = Object.assign(new Error(`${code}: permission denied`), { code });
        const wrapped = manager._wrapWriteStreamError(raw, 'alpha.gguf');
        expect(wrapped.message).toMatch(/Permission denied/i);
        expect(wrapped.code).toBe(code);
      }
    });

    test('maps ENOENT to missing-directory message', () => {
      const manager = new ModelDownloadManager();
      const raw = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      const wrapped = manager._wrapWriteStreamError(raw, 'alpha.gguf');
      expect(wrapped.message).toMatch(/directory missing/i);
    });

    test('maps EROFS to read-only-filesystem message', () => {
      const manager = new ModelDownloadManager();
      const raw = Object.assign(new Error('EROFS'), { code: 'EROFS' });
      const wrapped = manager._wrapWriteStreamError(raw, 'alpha.gguf');
      expect(wrapped.message).toMatch(/read-only/i);
    });

    test('maps EIO to filesystem-failing message', () => {
      const manager = new ModelDownloadManager();
      const raw = Object.assign(new Error('EIO'), { code: 'EIO' });
      const wrapped = manager._wrapWriteStreamError(raw, 'alpha.gguf');
      expect(wrapped.message).toMatch(/I\/O/i);
    });

    test('returns the original error unchanged when code is unrecognized', () => {
      const manager = new ModelDownloadManager();
      const raw = Object.assign(new Error('some unknown thing'), { code: 'EWHATEVER' });
      const wrapped = manager._wrapWriteStreamError(raw, 'alpha.gguf');
      expect(wrapped).toBe(raw);
    });

    test('returns the original error when no code is present', () => {
      const manager = new ModelDownloadManager();
      const raw = new Error('generic stream failure');
      const wrapped = manager._wrapWriteStreamError(raw, 'alpha.gguf');
      expect(wrapped).toBe(raw);
    });
  });
});

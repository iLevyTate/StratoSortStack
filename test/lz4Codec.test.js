/**
 * Tests for shared LZ4 codec wrapper.
 * Ensures native binding failures do not crash startup paths.
 */

describe('shared/lz4Codec', () => {
  afterEach(() => {
    jest.resetModules();
    jest.unmock('lz4-napi');
  });

  test('falls back to passthrough buffers when lz4 binding cannot load', async () => {
    const bindingError = new Error('Failed to load native binding');
    jest.doMock('lz4-napi', () => {
      throw bindingError;
    });

    const codec = require('../src/shared/lz4Codec');
    const input = Buffer.from('payload');

    expect(codec.isLz4BindingAvailable).toBe(false);
    expect(codec.lz4BindingError).toBe(bindingError);
    expect(codec.compressSync(input)).toEqual(input);
    expect(codec.uncompressSync(input)).toEqual(input);
    await expect(codec.compress(input)).resolves.toEqual(input);
    await expect(codec.uncompress(input)).resolves.toEqual(input);
  });

  test('delegates to lz4-native APIs when binding is available', async () => {
    const mockBinding = {
      compressSync: jest.fn((buf) => Buffer.from(`sync:${buf.toString('utf8')}`, 'utf8')),
      uncompressSync: jest.fn((buf) =>
        Buffer.from(buf.toString('utf8').replace(/^sync:/, ''), 'utf8')
      ),
      compress: jest.fn(async (buf) => Buffer.from(`async:${buf.toString('utf8')}`, 'utf8')),
      uncompress: jest.fn(async (buf) =>
        Buffer.from(buf.toString('utf8').replace(/^async:/, ''), 'utf8')
      )
    };
    jest.doMock('lz4-napi', () => mockBinding);

    const codec = require('../src/shared/lz4Codec');
    const input = Buffer.from('payload', 'utf8');

    expect(codec.isLz4BindingAvailable).toBe(true);
    expect(codec.compressSync(input).toString('utf8')).toBe('sync:payload');
    expect(codec.uncompressSync(Buffer.from('sync:payload', 'utf8')).toString('utf8')).toBe(
      'payload'
    );
    // The async wrappers call the sync binding: lz4-napi's async compress()
    // and uncompress() leak their native buffers (about 100 MB per call on a
    // 60 MB search index), which grew the app by ~35 MB per analyzed file.
    await expect(codec.compress(input)).resolves.toEqual(Buffer.from('sync:payload', 'utf8'));
    await expect(codec.uncompress(Buffer.from('sync:payload', 'utf8'))).resolves.toEqual(
      Buffer.from('payload', 'utf8')
    );
    expect(mockBinding.compressSync).toHaveBeenCalledTimes(2);
    expect(mockBinding.uncompressSync).toHaveBeenCalledTimes(2);
    expect(mockBinding.compress).not.toHaveBeenCalled();
    expect(mockBinding.uncompress).not.toHaveBeenCalled();
  });

  test('uses the async binding only when the sync one is missing', async () => {
    const mockBinding = {
      compress: jest.fn(async (buf) => Buffer.from(`async:${buf.toString('utf8')}`, 'utf8')),
      uncompress: jest.fn(async (buf) =>
        Buffer.from(buf.toString('utf8').replace(/^async:/, ''), 'utf8')
      )
    };
    jest.doMock('lz4-napi', () => mockBinding);

    const codec = require('../src/shared/lz4Codec');
    await expect(codec.compress(Buffer.from('payload'))).resolves.toEqual(
      Buffer.from('async:payload', 'utf8')
    );
    await expect(codec.uncompress(Buffer.from('async:payload'))).resolves.toEqual(
      Buffer.from('payload', 'utf8')
    );
  });
});

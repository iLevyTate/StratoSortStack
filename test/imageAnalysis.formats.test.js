/**
 * @jest-environment node
 *
 * Image formats the vision path could not decode (audit row MI-02): .ico is
 * decoded through decode-ico before preprocessing; HEIC has no decoder in
 * this build and is organized by filename with an honest reason instead of
 * sending raw bytes to the vision model.
 */

const mockDecodeIco = jest.fn();
jest.mock('decode-ico', () => ({
  __esModule: true,
  default: (...args) => mockDecodeIco(...args)
}));

const mockSharpInstance = {
  png: jest.fn().mockReturnThis(),
  toBuffer: jest.fn().mockResolvedValue(Buffer.from('png-from-rgba'))
};
const mockSharp = jest.fn(() => mockSharpInstance);
jest.mock('sharp', () => mockSharp);

jest.mock('../src/shared/logger', () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    setContext: jest.fn()
  };
  return { createLogger: jest.fn(() => logger) };
});

const {
  decodeIcoToPng,
  UNDECODABLE_IMAGE_EXTENSIONS
} = require('../src/main/analysis/imageAnalysis');

describe('decodeIcoToPng', () => {
  beforeEach(() => {
    mockDecodeIco.mockReset();
    mockSharp.mockClear();
    mockSharpInstance.png.mockClear();
    mockSharpInstance.toBuffer.mockClear();
  });

  test('returns the PNG bytes of the largest PNG-typed frame without touching sharp', async () => {
    const small = new Uint8Array([1, 2, 3]);
    const big = new Uint8Array([9, 8, 7, 6]);
    mockDecodeIco.mockReturnValue([
      { width: 16, height: 16, type: 'png', data: small },
      { width: 48, height: 48, type: 'png', data: big }
    ]);

    const out = await decodeIcoToPng(Buffer.from('ico'));

    expect(Buffer.isBuffer(out)).toBe(true);
    expect([...out]).toEqual([9, 8, 7, 6]);
    expect(mockSharp).not.toHaveBeenCalled();
  });

  test('encodes a BMP-typed frame (RGBA pixels) to PNG through sharp raw input', async () => {
    const rgba = new Uint8Array(2 * 2 * 4).fill(255);
    mockDecodeIco.mockReturnValue([{ width: 2, height: 2, type: 'bmp', data: rgba }]);

    const out = await decodeIcoToPng(Buffer.from('ico'));

    expect(mockSharp).toHaveBeenCalledWith(expect.any(Buffer), {
      raw: { width: 2, height: 2, channels: 4 }
    });
    expect(mockSharpInstance.png).toHaveBeenCalled();
    expect(out.toString()).toBe('png-from-rgba');
  });

  test('throws when the icon holds no frames', async () => {
    mockDecodeIco.mockReturnValue([]);
    await expect(decodeIcoToPng(Buffer.from('ico'))).rejects.toThrow(/no decodable frames/);
  });
});

describe('UNDECODABLE_IMAGE_EXTENSIONS', () => {
  test('lists HEIC/HEIF and nothing the pipeline can decode', () => {
    expect([...UNDECODABLE_IMAGE_EXTENSIONS].sort()).toEqual(['.heic', '.heif']);
  });
});

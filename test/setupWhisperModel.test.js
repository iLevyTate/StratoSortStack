/**
 * Tests for scripts/setup-whisper-model.js helpers.
 *
 * Network-touching paths are not exercised here — those are integration
 * concerns. We focus on the LFS pointer parser and URL/host validation,
 * which are the supply-chain critical pieces.
 */

const {
  parseLfsPointer,
  validateUrl,
  isAllowedHost,
  parseArgs,
  SUPPORTED_MODEL_PATTERN,
  DEFAULT_MODEL,
  DEFAULT_VAD_MODEL
} = require('../scripts/setup-whisper-model');

describe('parseLfsPointer', () => {
  test('extracts sha256 and size from a well-formed pointer', () => {
    const text = `version https://git-lfs.github.com/spec/v1
oid sha256:a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002
size 147951465
`;
    expect(parseLfsPointer(text, 'ggml-base.en.bin')).toEqual({
      sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002',
      size: 147951465
    });
  });

  test('rejects pointers without sha256', () => {
    expect(() =>
      parseLfsPointer(`version https://git-lfs.github.com/spec/v1\nsize 12345\n`, 'x.bin')
    ).toThrow(/sha256/);
  });

  test('rejects pointers without size', () => {
    expect(() =>
      parseLfsPointer(
        `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\n`,
        'x.bin'
      )
    ).toThrow(/size/);
  });

  test('rejects pointers with malformed sha256', () => {
    expect(() => parseLfsPointer(`oid sha256:not-a-real-hash\nsize 100\n`, 'x.bin')).toThrow();
  });
});

describe('isAllowedHost', () => {
  test('accepts huggingface.co and subdomains', () => {
    expect(isAllowedHost('huggingface.co')).toBe(true);
    expect(isAllowedHost('cdn-lfs.huggingface.co')).toBe(true);
    expect(isAllowedHost('hf.co')).toBe(true);
  });

  test('rejects everything else', () => {
    expect(isAllowedHost('evil.com')).toBe(false);
    expect(isAllowedHost('huggingface.co.evil.com')).toBe(false);
    expect(isAllowedHost('')).toBe(false);
    expect(isAllowedHost(undefined)).toBe(false);
  });
});

describe('validateUrl', () => {
  test('accepts an https HF URL', () => {
    const u = validateUrl('https://huggingface.co/foo/bar', 'test');
    expect(u.hostname).toBe('huggingface.co');
  });

  test('rejects http URLs', () => {
    expect(() => validateUrl('http://huggingface.co/x', 'test')).toThrow(/HTTPS/i);
  });

  test('rejects credentialed URLs', () => {
    expect(() => validateUrl('https://user:pass@huggingface.co/x', 'test')).toThrow(
      /credentialed/i
    );
  });

  test('rejects untrusted hosts', () => {
    expect(() => validateUrl('https://example.com/x', 'test')).toThrow(/untrusted/i);
  });

  test('rejects malformed URLs', () => {
    expect(() => validateUrl('not-a-url', 'test')).toThrow(/Invalid URL/);
  });
});

describe('parseArgs', () => {
  test('defaults to base.en model, no flags', () => {
    const args = parseArgs(['node', 'script']);
    // Asserting individual fields keeps the test stable as new optional
    // flags are added (e.g. --vad/--vad-model added later).
    expect(args.check).toBe(false);
    expect(args.auto).toBe(false);
    expect(args.model).toBe(DEFAULT_MODEL);
  });

  test('parses --check', () => {
    expect(parseArgs(['node', 'script', '--check']).check).toBe(true);
  });

  test('parses --auto and --download as synonyms', () => {
    expect(parseArgs(['node', 'script', '--auto']).auto).toBe(true);
    expect(parseArgs(['node', 'script', '--download']).auto).toBe(true);
  });

  test('parses --model=<filename>', () => {
    expect(parseArgs(['node', 'script', '--model=ggml-small.en-q5_1.bin']).model).toBe(
      'ggml-small.en-q5_1.bin'
    );
  });

  test('--vad enables VAD setup with the default Silero model', () => {
    const args = parseArgs(['node', 'script', '--vad']);
    expect(args.vad).toBe(true);
    expect(args.vadModel).toBe(DEFAULT_VAD_MODEL);
  });

  test('--vad-model=<filename> implies --vad and overrides the model', () => {
    const args = parseArgs(['node', 'script', '--vad-model=ggml-silero-v6.0.0.bin']);
    expect(args.vad).toBe(true);
    expect(args.vadModel).toBe('ggml-silero-v6.0.0.bin');
  });

  test('default state leaves VAD off', () => {
    const args = parseArgs(['node', 'script']);
    expect(args.vad).toBe(false);
    expect(args.vadModel).toBe(DEFAULT_VAD_MODEL);
  });
});

describe('SUPPORTED_MODEL_PATTERN', () => {
  test('matches valid whisper model filenames', () => {
    expect(SUPPORTED_MODEL_PATTERN.test('ggml-base.en.bin')).toBe(true);
    expect(SUPPORTED_MODEL_PATTERN.test('ggml-small.en-q5_1.bin')).toBe(true);
    expect(SUPPORTED_MODEL_PATTERN.test('ggml-medium.bin')).toBe(true);
  });

  test('matches the Silero VAD companion (multi-dot version suffix)', () => {
    expect(SUPPORTED_MODEL_PATTERN.test('ggml-silero-v5.1.2.bin')).toBe(true);
    expect(SUPPORTED_MODEL_PATTERN.test('ggml-silero-v6.0.0.bin')).toBe(true);
    expect(SUPPORTED_MODEL_PATTERN.test(DEFAULT_VAD_MODEL)).toBe(true);
  });

  test('rejects path traversal and other suspicious shapes', () => {
    expect(SUPPORTED_MODEL_PATTERN.test('../etc/passwd')).toBe(false);
    expect(SUPPORTED_MODEL_PATTERN.test('ggml-base.en.bin/../evil')).toBe(false);
    expect(SUPPORTED_MODEL_PATTERN.test('not-a-whisper-model.gguf')).toBe(false);
    expect(SUPPORTED_MODEL_PATTERN.test('')).toBe(false);
    expect(SUPPORTED_MODEL_PATTERN.test('ggml-../escape.bin')).toBe(false);
  });
});

const {
  SUPPORT_EMAIL,
  describeWhisperStack,
  buildSupportMailtoUrl,
  buildVersionString
} = require('../src/shared/supportInfo');

describe('supportInfo', () => {
  test('describeWhisperStack reports ready when model is installed but not loaded', () => {
    expect(
      describeWhisperStack({
        whisper: {
          loaded: false,
          modelPresent: true,
          modelFilename: 'ggml-base.en.bin',
          backend: 'unknown',
          resolvedVariant: null
        }
      })
    ).toBe('Ready · ggml-base.en.bin');
  });

  test('describeWhisperStack reports not installed when model file is missing', () => {
    expect(
      describeWhisperStack({
        whisper: {
          loaded: false,
          modelPresent: false,
          backend: 'unknown'
        }
      })
    ).toBe('Not installed');
  });

  test('describeWhisperStack reports loaded variant and backend', () => {
    expect(
      describeWhisperStack({
        whisper: {
          loaded: true,
          backend: 'nvidia',
          resolvedVariant: 'cuda',
          modelFilename: 'ggml-base.en.bin'
        }
      })
    ).toBe('cuda on nvidia · ggml-base.en.bin');
  });

  test('describeWhisperStack handles missing whisper service', () => {
    expect(describeWhisperStack({ reason: 'whisper-service-not-registered' })).toBe(
      'Not initialized yet'
    );
    expect(describeWhisperStack({})).toBe('Unavailable');
  });

  test('buildSupportMailtoUrl targets support email with runtime details', () => {
    const url = buildSupportMailtoUrl({
      appName: 'StratoSort Stack',
      appVersion: '3.1.1',
      platform: 'win32',
      arch: 'x64',
      osRelease: '10.0.26200',
      electronVersion: '41.6.1',
      mediaStack: {
        whisper: {
          loaded: false,
          modelPresent: true,
          modelFilename: 'ggml-base.en.bin',
          backend: 'unknown'
        }
      }
    });

    expect(url.startsWith(`mailto:${SUPPORT_EMAIL}?`)).toBe(true);
    expect(url).toContain('subject=');
    expect(decodeURIComponent(url)).toContain('Whisper: Ready · ggml-base.en.bin');
  });

  test('buildVersionString includes whisper idle status', () => {
    const text = buildVersionString({
      appName: 'StratoSort Stack',
      appVersion: '3.1.1',
      platform: 'win32',
      arch: 'x64',
      mediaStack: {
        whisper: {
          loaded: false,
          modelPresent: true,
          modelFilename: 'ggml-base.en.bin',
          backend: 'unknown'
        }
      }
    });

    expect(text).toContain('Whisper: Ready · ggml-base.en.bin');
  });

  test('buildCommercialInquiryMailtoUrl targets sales with a pre-filled subject and seat prompt', () => {
    const { buildCommercialInquiryMailtoUrl, SALES_EMAIL } = require('../src/shared/supportInfo');
    const url = buildCommercialInquiryMailtoUrl({ appVersion: '4.2.0' });
    expect(url.startsWith(`mailto:${SALES_EMAIL}?`)).toBe(true);
    const params = new URLSearchParams(url.slice(url.indexOf('?') + 1));
    expect(params.get('subject')).toMatch(/commercial license/i);
    expect(params.get('subject')).toContain('v4.2.0');
    expect(params.get('body')).toMatch(/seats/i);
    expect(params.get('body')).toMatch(/organization/i);
  });
});

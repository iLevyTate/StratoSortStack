/**
 * scripts/setup-vc-redist.js stages Microsoft's Visual C++ Redistributable
 * for Windows packages. It must download only over HTTPS from Microsoft hosts,
 * keep a file only when its Authenticode signature is Valid and from
 * O=Microsoft Corporation (fail closed: delete + non-zero exit), record the
 * version in a manifest, and skip the download when a verified copy is staged.
 *
 * https and the PowerShell signature check are mocked; files go to a real
 * temp directory (the default memfs stand-in has no stream semantics we trust
 * for this).
 */

jest.mock('fs', () => jest.requireActual('fs'));
jest.mock('fs/promises', () => jest.requireActual('fs/promises'));

const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

jest.mock('https', () => ({ get: jest.fn() }));
jest.mock('../src/main/utils/authenticode', () => ({
  verifyMicrosoftSignatureSync: jest.fn()
}));

const fs = require('fs');
const path = require('path');
const https = require('https');
const authenticode = require('../src/main/utils/authenticode');
const {
  DOWNLOAD_URLS,
  MIN_BYTES,
  SKIP_VERIFY_ENV,
  isAllowedHost,
  main,
  parseArgs,
  validateUrl
} = require('../scripts/setup-vc-redist');

const realOs = jest.requireActual('os');
const FINAL_URL = 'https://download.visualstudio.microsoft.com/download/pr/abc/VC_redist.x64.exe';
const PAYLOAD = Buffer.alloc(MIN_BYTES + 1024, 7);
const MS_SUBJECT =
  'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US';

function validVerdict() {
  return {
    ok: true,
    reason: 'valid',
    info: {
      status: 'Valid',
      statusMessage: 'Signature verified.',
      subject: MS_SUBJECT,
      productVersion: '14.51.36247.0',
      fileVersion: '14.51.36247.0'
    }
  };
}

/**
 * Route https.get by URL: each entry is either a redirect target string or a
 * Buffer body served with 200.
 * @param {Record<string, string | Buffer>} routes
 */
function serve(routes) {
  https.get.mockImplementation((url, _options, callback) => {
    const req = new EventEmitter();
    req.setTimeout = jest.fn();
    req.destroy = jest.fn((err) => err && req.emit('error', err));
    setImmediate(() => {
      const route = routes[url];
      const res = new PassThrough();
      res.headers = {};
      if (route === undefined) {
        res.statusCode = 404;
        callback(res);
        res.end();
      } else if (typeof route === 'string') {
        res.statusCode = 301;
        res.headers.location = route;
        callback(res);
        res.end();
      } else {
        res.statusCode = 200;
        res.headers['content-length'] = String(route.length);
        callback(res);
        res.end(route);
      }
    });
    return req;
  });
}

let dir;
let errorSpy;
let logSpy;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(realOs.tmpdir(), 'vc-redist-test-'));
  https.get.mockReset();
  authenticode.verifyMicrosoftSignatureSync.mockReset();
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  errorSpy.mockRestore();
  logSpy.mockRestore();
});

const WIN = { platform: 'win32', env: {} };

describe('host allowlist and URL validation', () => {
  test('accepts aka.ms and Microsoft hosts only', () => {
    expect(isAllowedHost('aka.ms')).toBe(true);
    expect(isAllowedHost('download.visualstudio.microsoft.com')).toBe(true);
    expect(isAllowedHost('microsoft.com')).toBe(true);
    expect(isAllowedHost('microsoft.com.evil.example')).toBe(false);
    expect(isAllowedHost('evilmicrosoft.com')).toBe(false);
    expect(isAllowedHost('aka.ms.evil.example')).toBe(false);
    expect(isAllowedHost('github.com')).toBe(false);
    expect(isAllowedHost(undefined)).toBe(false);
  });

  test('rejects http and credentialed URLs', () => {
    expect(() => validateUrl('http://aka.ms/vc14/vc_redist.x64.exe')).toThrow(/non-HTTPS/);
    expect(() => validateUrl('https://u:p@aka.ms/x')).toThrow(/credentialed/);
  });

  test('the default sources are the permanent v14 aka.ms links', () => {
    expect(DOWNLOAD_URLS).toEqual({
      x64: 'https://aka.ms/vc14/vc_redist.x64.exe',
      arm64: 'https://aka.ms/vc14/vc_redist.arm64.exe'
    });
  });

  test('parseArgs reads --arch, --check and --refresh', () => {
    expect(parseArgs(['--arch=arm64', '--check'])).toMatchObject({
      arch: 'arm64',
      check: true,
      refresh: false
    });
    expect(parseArgs(['--refresh'])).toMatchObject({ refresh: true });
  });
});

describe('download + verify', () => {
  test('valid Microsoft signature: file kept and manifest written', async () => {
    serve({ [DOWNLOAD_URLS.x64]: FINAL_URL, [FINAL_URL]: PAYLOAD });
    authenticode.verifyMicrosoftSignatureSync.mockReturnValue(validVerdict());

    const code = await main(['--arch=x64'], { dir, ...WIN });

    expect(code).toBe(0);
    const exe = path.join(dir, 'vc_redist.x64.exe');
    expect(fs.readFileSync(exe).length).toBe(PAYLOAD.length);
    expect(fs.existsSync(`${exe}.partial`)).toBe(false);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'vc_redist.x64.json'), 'utf8'));
    expect(manifest).toMatchObject({
      file: 'vc_redist.x64.exe',
      arch: 'x64',
      productVersion: '14.51.36247.0',
      verified: true,
      signatureStatus: 'Valid',
      signer: MS_SUBJECT,
      sourceUrl: DOWNLOAD_URLS.x64,
      resolvedUrl: FINAL_URL,
      size: PAYLOAD.length
    });
    expect(manifest.sha256).toMatch(/^[a-f0-9]{64}$/);
    // The signature was checked on the downloaded bytes before they were kept.
    expect(authenticode.verifyMicrosoftSignatureSync).toHaveBeenCalledWith(
      `${exe}.partial`,
      expect.anything()
    );

    // --check accepts what setup staged.
    expect(await main(['--check', '--arch=x64'], { dir, ...WIN })).toBe(0);
  });

  test('arm64 fetches the arm64 link and stages vc_redist.arm64.exe', async () => {
    const armFinal =
      'https://download.visualstudio.microsoft.com/download/pr/x/VC_redist.arm64.exe';
    serve({ [DOWNLOAD_URLS.arm64]: armFinal, [armFinal]: PAYLOAD });
    authenticode.verifyMicrosoftSignatureSync.mockReturnValue(validVerdict());

    expect(await main(['--arch=arm64'], { dir, ...WIN })).toBe(0);
    expect(fs.existsSync(path.join(dir, 'vc_redist.arm64.exe'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'vc_redist.x64.exe'))).toBe(false);
  });

  test('invalid signer: file deleted, no manifest, non-zero exit', async () => {
    serve({ [DOWNLOAD_URLS.x64]: FINAL_URL, [FINAL_URL]: PAYLOAD });
    authenticode.verifyMicrosoftSignatureSync.mockReturnValue({
      ok: false,
      reason: 'not-microsoft',
      info: { ...validVerdict().info, subject: 'CN=Contoso, O=Contoso Ltd' }
    });

    const code = await main(['--arch=x64'], { dir, ...WIN });

    expect(code).not.toBe(0);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(errorSpy.mock.calls.join(' ')).toMatch(/O=Microsoft Corporation/);
  });

  test('a signature that is not Valid is refused the same way', async () => {
    serve({ [DOWNLOAD_URLS.x64]: FINAL_URL, [FINAL_URL]: PAYLOAD });
    authenticode.verifyMicrosoftSignatureSync.mockReturnValue({
      ok: false,
      reason: 'not-valid',
      info: { ...validVerdict().info, status: 'HashMismatch' }
    });

    expect(await main(['--arch=x64'], { dir, ...WIN })).not.toBe(0);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test('a redirect to a non-Microsoft host is refused before it is requested', async () => {
    const evil = 'https://downloads.evil.example/VC_redist.x64.exe';
    serve({ [DOWNLOAD_URLS.x64]: evil, [evil]: PAYLOAD });

    const code = await main(['--arch=x64'], { dir, ...WIN });

    expect(code).not.toBe(0);
    expect(https.get.mock.calls.map(([url]) => url)).toEqual([DOWNLOAD_URLS.x64]);
    expect(authenticode.verifyMicrosoftSignatureSync).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(errorSpy.mock.calls.join(' ')).toMatch(/non-Microsoft host: downloads\.evil\.example/);
  });

  test('a redirect to plain http is refused', async () => {
    serve({ [DOWNLOAD_URLS.x64]: 'http://download.visualstudio.microsoft.com/x.exe' });
    expect(await main(['--arch=x64'], { dir, ...WIN })).not.toBe(0);
    expect(https.get).toHaveBeenCalledTimes(1);
  });

  test('a body below the size floor (an error page) is refused', async () => {
    serve({ [DOWNLOAD_URLS.x64]: FINAL_URL, [FINAL_URL]: Buffer.from('<html>oops</html>') });
    expect(await main(['--arch=x64'], { dir, ...WIN })).not.toBe(0);
    expect(authenticode.verifyMicrosoftSignatureSync).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test('an existing verified file is not downloaded again', async () => {
    serve({ [DOWNLOAD_URLS.x64]: FINAL_URL, [FINAL_URL]: PAYLOAD });
    authenticode.verifyMicrosoftSignatureSync.mockReturnValue(validVerdict());
    expect(await main(['--arch=x64'], { dir, ...WIN })).toBe(0);
    expect(https.get).toHaveBeenCalledTimes(2);

    https.get.mockClear();
    expect(await main(['--arch=x64'], { dir, ...WIN })).toBe(0);
    expect(https.get).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.join(' ')).toMatch(/already staged and verified/);

    // --refresh downloads anyway.
    expect(await main(['--arch=x64', '--refresh'], { dir, ...WIN })).toBe(0);
    expect(https.get).toHaveBeenCalledTimes(2);
  });

  test('an existing file whose bytes no longer match the manifest is replaced', async () => {
    serve({ [DOWNLOAD_URLS.x64]: FINAL_URL, [FINAL_URL]: PAYLOAD });
    authenticode.verifyMicrosoftSignatureSync.mockReturnValue(validVerdict());
    expect(await main(['--arch=x64'], { dir, ...WIN })).toBe(0);
    fs.writeFileSync(path.join(dir, 'vc_redist.x64.exe'), 'tampered');

    expect(await main(['--check', '--arch=x64'], { dir, ...WIN })).not.toBe(0);

    https.get.mockClear();
    expect(await main(['--arch=x64'], { dir, ...WIN })).toBe(0);
    expect(https.get).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(path.join(dir, 'vc_redist.x64.exe')).length).toBe(PAYLOAD.length);
  });
});

describe('--check', () => {
  test('fails when nothing is staged', async () => {
    expect(await main(['--check', '--arch=x64'], { dir, ...WIN })).not.toBe(0);
  });

  test('fails when the staged file no longer verifies', async () => {
    serve({ [DOWNLOAD_URLS.x64]: FINAL_URL, [FINAL_URL]: PAYLOAD });
    authenticode.verifyMicrosoftSignatureSync.mockReturnValue(validVerdict());
    expect(await main(['--arch=x64'], { dir, ...WIN })).toBe(0);

    authenticode.verifyMicrosoftSignatureSync.mockReturnValue({
      ok: false,
      reason: 'not-valid',
      info: null
    });
    expect(await main(['--check', '--arch=x64'], { dir, ...WIN })).not.toBe(0);
  });

  test('fails when the manifest is for the other arch', async () => {
    serve({ [DOWNLOAD_URLS.x64]: FINAL_URL, [FINAL_URL]: PAYLOAD });
    authenticode.verifyMicrosoftSignatureSync.mockReturnValue(validVerdict());
    expect(await main(['--arch=x64'], { dir, ...WIN })).toBe(0);
    const manifestPath = path.join(dir, 'vc_redist.x64.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, arch: 'arm64' }));
    expect(await main(['--check', '--arch=x64'], { dir, ...WIN })).not.toBe(0);
  });
});

describe('non-Windows hosts', () => {
  test('fail with a clear message before downloading', async () => {
    const code = await main(['--arch=x64'], { dir, platform: 'linux', env: {} });
    expect(code).not.toBe(0);
    expect(https.get).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.join(' ')).toMatch(
      new RegExp(`needs a Windows host.*${SKIP_VERIFY_ENV}=1`)
    );
  });

  test(`${SKIP_VERIFY_ENV}=1 stages without verification and says so in the manifest`, async () => {
    serve({ [DOWNLOAD_URLS.x64]: FINAL_URL, [FINAL_URL]: PAYLOAD });
    const host = { platform: 'darwin', env: { [SKIP_VERIFY_ENV]: '1' } };

    expect(await main(['--arch=x64'], { dir, ...host })).toBe(0);
    expect(authenticode.verifyMicrosoftSignatureSync).not.toHaveBeenCalled();
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'vc_redist.x64.json'), 'utf8'));
    expect(manifest).toMatchObject({ verified: false, productVersion: null });
    expect(await main(['--check', '--arch=x64'], { dir, ...host })).toBe(0);
  });
});

test('--windows-host-only is a no-op off Windows and the normal path on Windows', async () => {
  expect(await main(['--windows-host-only'], { dir, platform: 'linux', env: {} })).toBe(0);
  expect(await main(['--check', '--windows-host-only'], { dir, platform: 'darwin', env: {} })).toBe(
    0
  );
  expect(https.get).not.toHaveBeenCalled();
  // On Windows it still requires a staged, verified file.
  expect(await main(['--check', '--windows-host-only'], { dir, ...WIN })).not.toBe(0);
});

test('rejects an unsupported --arch', async () => {
  expect(await main(['--arch=ia32'], { dir, ...WIN })).not.toBe(0);
  expect(https.get).not.toHaveBeenCalled();
});

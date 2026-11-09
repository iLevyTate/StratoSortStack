/**
 * src/main/utils/authenticode.js — the one rule shared by the redistributable
 * staging script, the packaged-artifact verifier and the in-app installer:
 * Valid Authenticode status and a signer whose subject has O=Microsoft
 * Corporation. The file path only ever travels in the child environment.
 */

const {
  TARGET_ENV_VAR,
  evaluateMicrosoftSignature,
  parseAuthenticodeOutput,
  readAuthenticode,
  readAuthenticodeSync,
  subjectHasOrganization
} = require('../src/main/utils/authenticode');

const MS_SUBJECT =
  'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US';
const JSON_LINE = JSON.stringify({
  Status: 'Valid',
  StatusMessage: 'Signature verified.',
  Subject: MS_SUBJECT,
  ProductVersion: '14.51.36247.0',
  FileVersion: '14.51.36247.0'
});

describe('subjectHasOrganization', () => {
  test.each([
    [MS_SUBJECT, true],
    ['CN=Microsoft Windows, O="Microsoft Corporation", C=US', true],
    ['CN=Microsoft Corporation, O=Microsoft Corporation Ltd, C=US', false],
    ['CN=O=Microsoft Corporation, O=Contoso', false],
    ['CN=Contoso, OU=Microsoft Corporation', false],
    ['', false],
    [null, false]
  ])('%p -> %p', (subject, expected) => {
    expect(subjectHasOrganization(subject)).toBe(expected);
  });
});

describe('parse + evaluate', () => {
  test('parses the JSON line PowerShell prints, ignoring noise', () => {
    expect(parseAuthenticodeOutput(`WARNING: something\r\n${JSON_LINE}\r\n`)).toEqual({
      status: 'Valid',
      statusMessage: 'Signature verified.',
      subject: MS_SUBJECT,
      productVersion: '14.51.36247.0',
      fileVersion: '14.51.36247.0'
    });
    expect(parseAuthenticodeOutput('')).toBeNull();
    expect(parseAuthenticodeOutput('{not json')).toBeNull();
  });

  test('requires Valid and a Microsoft signer', () => {
    const info = parseAuthenticodeOutput(JSON_LINE);
    expect(evaluateMicrosoftSignature(info)).toMatchObject({ ok: true, reason: 'valid' });
    expect(evaluateMicrosoftSignature({ ...info, status: 'NotSigned' })).toMatchObject({
      ok: false,
      reason: 'not-valid'
    });
    expect(evaluateMicrosoftSignature({ ...info, subject: 'CN=Evil, O=Evil' })).toMatchObject({
      ok: false,
      reason: 'not-microsoft'
    });
    expect(evaluateMicrosoftSignature(null)).toMatchObject({ ok: false, reason: 'unreadable' });
  });
});

describe('PowerShell invocation', () => {
  const tricky = "C:\\Program Files\\O'Brien\\$(calc)\\vc_redist.x64.exe";

  test('async: absolute powershell.exe, encoded fixed script, path only in env', async () => {
    const spawnImpl = jest.fn(async () => ({ status: 0, stdout: JSON_LINE }));
    const info = await readAuthenticode(tricky, { env: { SystemRoot: 'C:\\Windows' }, spawnImpl });
    expect(info.status).toBe('Valid');
    const [command, args, options] = spawnImpl.mock.calls[0];
    expect(command).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(args).toContain('-EncodedCommand');
    const script = Buffer.from(args[args.length - 1], 'base64').toString('utf16le');
    expect(script).toContain(`Get-AuthenticodeSignature -LiteralPath $target`);
    expect(script).toContain(`$env:${TARGET_ENV_VAR}`);
    expect(args.join(' ')).not.toContain('Brien');
    expect(options.env[TARGET_ENV_VAR]).toBe(tricky);
  });

  test('a failing PowerShell resolves to null rather than throwing', async () => {
    await expect(
      readAuthenticode('x', { env: {}, spawnImpl: jest.fn(async () => ({ status: 1 })) })
    ).resolves.toBeNull();
    await expect(
      readAuthenticode('x', {
        env: {},
        spawnImpl: jest.fn(async () => {
          throw new Error('spawn failed');
        })
      })
    ).resolves.toBeNull();
    expect(
      readAuthenticodeSync('x', {
        env: {},
        spawnSyncImpl: jest.fn(() => ({ status: 0, stdout: '' }))
      })
    ).toBeNull();
  });
});

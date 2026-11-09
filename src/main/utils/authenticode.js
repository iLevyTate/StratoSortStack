// @ts-check
/**
 * Authenticode signature checks (Windows) via PowerShell's
 * Get-AuthenticodeSignature.
 *
 * Shared by the build-time redistributable staging script
 * (scripts/setup-vc-redist.js), the packaged-artifact verifier and the in-app
 * Visual C++ Redistributable installer (vcRuntimeInstaller.js), so all three
 * apply one rule: the file must carry a Valid Authenticode signature whose
 * signer certificate names `O=Microsoft Corporation`.
 *
 * The PowerShell script is a fixed string sent with -EncodedCommand. The file
 * path never becomes part of a command line: it reaches PowerShell through an
 * environment variable and is read with -LiteralPath, so quotes, `$` or other
 * metacharacters in a path cannot change what runs.
 *
 * The script must also run under PowerShell ConstrainedLanguage mode (managed
 * PCs with WDAC/AppLocker policies): no [pscustomobject] or other non-core
 * type conversions and no .NET method calls, only cmdlets, property reads and
 * a plain hashtable for ConvertTo-Json. A PowerShell that cannot run or
 * answer at all (missing, blocked, timed out, unparseable output) yields the
 * verdict `unreadable`, which callers keep apart from a signature that was
 * read and is wrong.
 *
 * @module utils/authenticode
 */

const path = require('path');
const { spawnSync } = require('child_process');
const { asyncSpawn } = require('./asyncSpawnUtils');

/** Environment variable that carries the target path into PowerShell. */
const TARGET_ENV_VAR = 'SS_AUTHENTICODE_TARGET';
const DEFAULT_TIMEOUT_MS = 60000;
const MICROSOFT_ORGANIZATION = 'Microsoft Corporation';

const SIGNATURE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  `$target = $env:${TARGET_ENV_VAR}`,
  '$sig = Get-AuthenticodeSignature -LiteralPath $target',
  '$ver = (Get-Item -LiteralPath $target).VersionInfo',
  '$subject = $null',
  'if ($sig.SignerCertificate) { $subject = $sig.SignerCertificate.Subject }',
  // A plain hashtable: [pscustomobject] fails in ConstrainedLanguage mode
  // (ConversionSupportedOnlyToCoreTypes).
  '@{',
  '  Status = [string]$sig.Status',
  '  StatusMessage = [string]$sig.StatusMessage',
  '  Subject = $subject',
  '  ProductVersion = [string]$ver.ProductVersion',
  '  FileVersion = [string]$ver.FileVersion',
  '} | ConvertTo-Json -Compress'
].join('\n');

/**
 * Absolute path to Windows PowerShell 5.1, so a `powershell.exe` planted on
 * PATH or in the working directory is never picked up.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function powershellPath(env = process.env) {
  const systemRoot = env.SystemRoot || env.windir || 'C:\\Windows';
  return path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * Arguments that run a fixed script without profile or prompts.
 * @param {string} script
 * @returns {string[]}
 */
function encodedCommandArgs(script) {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')
  ];
}

/**
 * @typedef {Object} AuthenticodeInfo
 * @property {string} status          Get-AuthenticodeSignature Status ('Valid', 'NotSigned', 'HashMismatch', ...)
 * @property {string} statusMessage
 * @property {string | null} subject  signer certificate subject DN
 * @property {string | null} productVersion
 * @property {string | null} fileVersion
 */

/**
 * Parse the JSON line the signature script prints.
 * @param {unknown} stdout
 * @returns {AuthenticodeInfo | null}
 */
function parseAuthenticodeOutput(stdout) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'));
  if (lines.length === 0) return null;
  try {
    const raw = JSON.parse(lines[lines.length - 1]);
    if (!raw || typeof raw !== 'object') return null;
    const text = (/** @type {unknown} */ value) =>
      typeof value === 'string' && value.trim() ? value.trim() : null;
    return {
      status: text(raw.Status) || 'Unknown',
      statusMessage: text(raw.StatusMessage) || '',
      subject: text(raw.Subject),
      productVersion: text(raw.ProductVersion),
      fileVersion: text(raw.FileVersion)
    };
  } catch {
    return null;
  }
}

/**
 * Whether a certificate subject DN has exactly `O=<organization>` as one of
 * its components (so `O=Microsoft Corporation Ltd`, or a CN that merely
 * mentions Microsoft, does not count).
 * @param {string | null | undefined} subject
 * @param {string} [organization]
 * @returns {boolean}
 */
function subjectHasOrganization(subject, organization = MICROSOFT_ORGANIZATION) {
  if (typeof subject !== 'string' || !subject) return false;
  return subject
    .split(/,(?=\s*[A-Za-z][A-Za-z0-9.]*=)/)
    .map((part) => part.trim())
    .some((part) => {
      const eq = part.indexOf('=');
      if (eq <= 0) return false;
      const key = part.slice(0, eq).trim().toUpperCase();
      const value = part
        .slice(eq + 1)
        .trim()
        .replace(/^"(.*)"$/, '$1');
      return key === 'O' && value === organization;
    });
}

/**
 * @typedef {Object} SignatureVerdict
 * @property {boolean} ok
 * @property {'valid' | 'unreadable' | 'not-valid' | 'not-microsoft'} reason
 *   'unreadable': PowerShell could not report a signature at all (missing,
 *   blocked, timed out, unparseable output); the others describe a signature
 *   that was read.
 * @property {AuthenticodeInfo | null} info
 */

/**
 * The single rule: Status Valid and a Microsoft Corporation signer.
 * @param {AuthenticodeInfo | null} info
 * @returns {SignatureVerdict}
 */
function evaluateMicrosoftSignature(info) {
  if (!info) return { ok: false, reason: 'unreadable', info: null };
  if (info.status !== 'Valid') return { ok: false, reason: 'not-valid', info };
  if (!subjectHasOrganization(info.subject)) return { ok: false, reason: 'not-microsoft', info };
  return { ok: true, reason: 'valid', info };
}

/**
 * The environment for a Windows PowerShell 5.1 child: the parent's, minus
 * PSModulePath. A parent running in PowerShell 7 (GitHub's Windows runners run
 * every step in pwsh) exports a PSModulePath that lists PowerShell 7's module
 * folders first; Windows PowerShell then loads PowerShell 7's
 * Microsoft.PowerShell.Security, which fails, so Get-AuthenticodeSignature is
 * not available. Without the variable, 5.1 builds its own default path.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {Record<string, string>} [extra]
 * @returns {NodeJS.ProcessEnv}
 */
function windowsPowerShellEnv(env, extra = {}) {
  /** @type {NodeJS.ProcessEnv} */
  const out = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (key.toLowerCase() === 'psmodulepath') continue;
    out[key] = value;
  }
  return { ...out, ...extra };
}

/**
 * Record why a signature read failed, for the caller's error message.
 * @param {{ exitCode?: number | null, stderr?: string, error?: string } | undefined} diagnostics
 * @param {any} result
 * @param {unknown} [error]
 */
function recordDiagnostics(diagnostics, result, error) {
  if (!diagnostics) return;
  diagnostics.exitCode = result && typeof result.status === 'number' ? result.status : null;
  diagnostics.stderr = String((result && result.stderr) || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
  const message =
    error instanceof Error ? error.message : result && result.error && result.error.message;
  if (message) diagnostics.error = String(message);
}

/**
 * @param {string} filePath
 * @param {NodeJS.ProcessEnv} env
 */
function buildInvocation(filePath, env) {
  return {
    command: powershellPath(env),
    args: encodedCommandArgs(SIGNATURE_SCRIPT),
    env: windowsPowerShellEnv(env, { [TARGET_ENV_VAR]: filePath })
  };
}

/**
 * Read a file's Authenticode signature (async; for the main process).
 * Never rejects: a PowerShell failure resolves to null.
 *
 * @param {string} filePath
 * @param {{ env?: NodeJS.ProcessEnv, spawnImpl?: typeof asyncSpawn, timeoutMs?: number, diagnostics?: { exitCode?: number | null, stderr?: string, error?: string } }} [options]
 * @returns {Promise<AuthenticodeInfo | null>}
 */
async function readAuthenticode(
  filePath,
  { env = process.env, spawnImpl = asyncSpawn, timeoutMs = DEFAULT_TIMEOUT_MS, diagnostics } = {}
) {
  const { command, args, env: childEnv } = buildInvocation(filePath, env);
  try {
    const result = await spawnImpl(command, args, {
      env: childEnv,
      timeout: timeoutMs,
      windowsHide: true
    });
    const info = result && result.status === 0 ? parseAuthenticodeOutput(result.stdout) : null;
    if (!info) recordDiagnostics(diagnostics, result);
    return info;
  } catch (error) {
    recordDiagnostics(diagnostics, null, error);
    return null;
  }
}

/**
 * Synchronous variant for build scripts and verifiers.
 *
 * @param {string} filePath
 * @param {{ env?: NodeJS.ProcessEnv, spawnSyncImpl?: typeof spawnSync, timeoutMs?: number, diagnostics?: { exitCode?: number | null, stderr?: string, error?: string } }} [options]
 * @returns {AuthenticodeInfo | null}
 */
function readAuthenticodeSync(
  filePath,
  { env = process.env, spawnSyncImpl = spawnSync, timeoutMs = DEFAULT_TIMEOUT_MS, diagnostics } = {}
) {
  const { command, args, env: childEnv } = buildInvocation(filePath, env);
  try {
    const result = spawnSyncImpl(command, args, {
      env: childEnv,
      timeout: timeoutMs,
      windowsHide: true,
      encoding: 'utf8'
    });
    const info = result && result.status === 0 ? parseAuthenticodeOutput(result.stdout) : null;
    if (!info) recordDiagnostics(diagnostics, result);
    return info;
  } catch (error) {
    recordDiagnostics(diagnostics, null, error);
    return null;
  }
}

/**
 * @param {string} filePath
 * @param {Parameters<typeof readAuthenticode>[1]} [options]
 * @returns {Promise<SignatureVerdict>}
 */
async function verifyMicrosoftSignature(filePath, options) {
  return evaluateMicrosoftSignature(await readAuthenticode(filePath, options));
}

/**
 * @param {string} filePath
 * @param {Parameters<typeof readAuthenticodeSync>[1]} [options]
 * @returns {SignatureVerdict}
 */
function verifyMicrosoftSignatureSync(filePath, options) {
  return evaluateMicrosoftSignature(readAuthenticodeSync(filePath, options));
}

module.exports = {
  MICROSOFT_ORGANIZATION,
  TARGET_ENV_VAR,
  SIGNATURE_SCRIPT,
  powershellPath,
  windowsPowerShellEnv,
  encodedCommandArgs,
  parseAuthenticodeOutput,
  subjectHasOrganization,
  evaluateMicrosoftSignature,
  readAuthenticode,
  readAuthenticodeSync,
  verifyMicrosoftSignature,
  verifyMicrosoftSignatureSync
};

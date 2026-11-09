/**
 * Secrets embedded in free-form strings (an error message carrying an
 * Authorization header, a URL query, a config dump) must not reach the log
 * file, the Live Activity feed, or an export. Key-name redaction only covers
 * object fields, so the string pass handles: Anthropic keys (sk-ant-api03-…,
 * whose hyphens defeated the old sk-[A-Za-z0-9]{10,} shape), generic sk-
 * keys, Bearer tokens, and key=value / key: value forms. Ordinary words that
 * merely contain "token" (tokens, maxTokens, tokenizer) are left alone.
 * All secrets below are synthetic.
 */

// test-setup.js mocks the logger globally; this suite exercises the real one.
jest.unmock('../src/shared/logger');

const { sanitizeLogData } = require('../src/shared/logger');
const { redactInlineSecrets, deepSanitizeForExport } = require('../src/shared/exportRedaction');

const ANTHROPIC_KEY = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ_abc-0123456789';
const GENERIC_KEY = 'sk-proj_AbCdEf-0123456789-GhIjKlMnOp';

describe.each([
  ['sanitizeLogData', (s) => sanitizeLogData(s)],
  ['redactInlineSecrets', (s) => redactInlineSecrets(s)],
  ['deepSanitizeForExport', (s) => deepSanitizeForExport(s)]
])('%s inline secrets', (_name, redact) => {
  test.each([
    [
      'Bearer token',
      'request failed: Authorization: Bearer sk-abc123def456ghi789jkl',
      'abc123def456'
    ],
    ['api_key=Anthropic key', `api_key=${ANTHROPIC_KEY}`, 'ABCDEFGHIJ'],
    ['bare Anthropic key', `provider rejected ${ANTHROPIC_KEY} (401)`, 'ABCDEFGHIJ'],
    ['generic sk- key with hyphens/underscores', `key ${GENERIC_KEY} invalid`, 'AbCdEf'],
    [
      'apikey query param',
      'GET https://api.example.com/v1?apikey=Zx9Qw8Er7Ty6&q=1',
      'Zx9Qw8Er7Ty6'
    ],
    ['access_token query param', 'callback ?access_token=ya29.a0AfH6SM&state=x', 'ya29.a0AfH6SM'],
    ['secret: value', 'client_secret: s3cr3tValue!', 's3cr3tValue'],
    ['password="value"', 'connect failed password="hunter2pass"', 'hunter2pass'],
    ['JSON-encoded key field', '{"apiKey":"abcd1234efgh5678","model":"m"}', 'abcd1234efgh5678'],
    ['token=value', 'token=abcdef123456', 'abcdef123456']
  ])('redacts %s', (_label, input, leaked) => {
    const out = redact(input);
    expect(out).not.toContain(leaked);
    expect(out).toContain('[REDACTED');
  });

  test.each([
    'generated 512 tokens in 3.2s',
    'maxTokens=4096 contextSize=8192',
    'tokenizer=llama-bpe loaded',
    'tokens: 812, maxTokens: 1024',
    'prompt token: 512',
    'secretary: Jane',
    'password_hint shown',
    'the task-runner-pipeline-stage-four finished',
    'desk-organizer-2026-final-version.pdf'
  ])('leaves ordinary text alone: %s', (input) => {
    expect(redact(input)).toBe(input);
  });
});

describe('sanitizeLogData inline secrets inside structured data', () => {
  test('a secret inside an error message field is redacted', () => {
    const out = sanitizeLogData({
      error: { message: `401 from provider: x-api-key=${ANTHROPIC_KEY}` },
      note: 'generated 12 tokens'
    });
    expect(JSON.stringify(out)).not.toContain('ABCDEFGHIJ');
    expect(out.note).toBe('generated 12 tokens');
  });
});

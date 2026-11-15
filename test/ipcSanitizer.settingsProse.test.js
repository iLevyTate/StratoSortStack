/**
 * @jest-environment node
 */
const { createIpcSanitizer } = require('../src/preload/ipcSanitizer');

// Settings prose and exclusion globs are not paths. The path heuristic used to
// blank them on Windows when they held a `\` plus `?`, `*` or `..`, which
// erased guidance, dropped a custom persona in main, and made every settings
// save fail once a backslash glob was added (schema requires min length 1).
describe('ipcSanitizer - settings prose and exclusion globs', () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { ...realPlatform, value: 'win32' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', realPlatform);
  });

  const make = () => {
    const log = { warn: jest.fn() };
    return { log, ...createIpcSanitizer({ log }) };
  };

  test('keeps guidance text that mentions a Windows path with ? and *', () => {
    const { sanitizeArguments, log } = make();
    const settings = {
      organizationCustomGuidance: 'Put tax PDFs in D:\\Finance\\Taxes. Should W-2s go there too?',
      chatPersonaCustomGuidance: 'Search D:\\Docs first; ignore *.tmp and ..\\old',
      customChatPersonas: [
        {
          id: 'custom:docs',
          label: 'D:\\Docs helper?',
          guidance: 'Search D:\\Docs first; ignore *.tmp',
          description: 'Looks in D:\\Docs?'
        }
      ]
    };

    const [out] = sanitizeArguments([settings]);

    expect(out).toEqual(settings);
    expect(log.warn).not.toHaveBeenCalled();
  });

  test('keeps backslash exclusion globs in settings and triage payloads', () => {
    const { sanitizeArguments } = make();
    const globs = ['*.iso', '**\\archived\\**', 'C:\\Users\\a-user\\Downloads\\*.iso'];

    const [settings] = sanitizeArguments([{ downloadsTriageExclusions: globs }]);
    const [triage] = sanitizeArguments([{ exclusionGlobs: globs }]);

    expect(settings.downloadsTriageExclusions).toEqual(globs);
    expect(triage.exclusionGlobs).toEqual(globs);
  });

  test('other keys keep the path checks', () => {
    const { sanitizeArguments } = make();
    const [out] = sanitizeArguments([
      { defaultSmartFolderLocation: 'D:\\a\\..\\b', lastBrowsedPath: 'D:\\a?\\b' }
    ]);
    expect(out.defaultSmartFolderLocation).toBe('');
    expect(out.lastBrowsedPath).toBe('');
  });

  test('free-text keys still strip script elements and control characters', () => {
    const { sanitizeArguments } = make();
    const [out] = sanitizeArguments([
      { organizationCustomGuidance: 'a\u0007b<script>x</script> D:\\X?' }
    ]);
    expect(out.organizationCustomGuidance).toBe('ab D:\\X?');
  });
});

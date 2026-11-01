/**
 * @jest-environment node
 *
 * update-release-notes.js rewrites the changelog part of a published
 * release's notes from CHANGELOG.md and keeps the rest of the notes.
 *
 * Runs on the real filesystem: it reads the repo's CHANGELOG.md and workflow
 * and runs the CLI on temporary files.
 */

jest.unmock('fs');
jest.unmock('fs/promises');
jest.unmock('os');

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');
const {
  buildReleaseNotes,
  extractChangelogSection,
  replaceChangelogSection
} = require('../scripts/update-release-notes');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'update-release-notes.js');
const CHANGELOG = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');

// The preamble release.yml writes above every release's CHANGELOG section.
const PREAMBLE = [
  '## Release Notes',
  '',
  '- **Vision runtime is included** — no separate download needed.',
  '- Windows artifacts are Authenticode-signed.',
  '- See the [Install Guide](https://stratosort.com/docs/INSTALL_GUIDE.html).',
  ''
];

// Shaped like the v5.1.0 notes as published: CRLF line endings and the
// summary CHANGELOG.md has since corrected.
const PUBLISHED_5_1_0 = [
  ...PREAMBLE,
  '## [5.1.0] - 2026-10-31',
  '',
  'Faster, more predictable Windows startup, a zip instead of the self-extracting portable exe, and',
  'smaller downloads on every platform.',
  '',
  '### Fixed',
  '',
  '- Windows startup.',
  '',
  ''
].join('\r\n');

describe('extractChangelogSection', () => {
  test('returns the corrected 5.1.0 section from CHANGELOG.md', () => {
    const section = extractChangelogSection(CHANGELOG, '5.1.0');
    expect(section.split('\n')[0]).toBe('## [5.1.0] - 2026-10-31');
    expect(section).toContain('### Known issues');
    expect(section).not.toContain('smaller downloads on every platform');
    expect(section).not.toContain('## [5.0.0]');
    expect(section).not.toMatch(/\n\s*$/);
  });

  test('does not take a longer version for a shorter one', () => {
    const changelog = [
      '## [5.1.10] - x',
      '',
      'ten',
      '',
      '## [5.1.1] - y',
      '',
      'one',
      '',
      '## [5.1.0] - z'
    ].join('\n');
    expect(extractChangelogSection(changelog, '5.1.1')).toBe('## [5.1.1] - y\n\none');
  });

  test('returns null for a version CHANGELOG.md does not have', () => {
    expect(extractChangelogSection(CHANGELOG, '0.0.1')).toBeNull();
  });
});

describe('replaceChangelogSection', () => {
  test('swaps in the corrected 5.1.0 section and keeps the preamble', () => {
    const section = extractChangelogSection(CHANGELOG, '5.1.0');
    const { notes, changed } = replaceChangelogSection(PUBLISHED_5_1_0, '5.1.0', section);

    expect(changed).toBe(true);
    expect(notes).toBe(`${[...PREAMBLE, section].join('\n')}\n`);
    expect(notes).not.toContain('\r');
  });

  test('keeps headings that follow the section', () => {
    const body = [
      '## Release Notes',
      '',
      '## [1.2.3]',
      '',
      'old',
      '',
      '## Checksums',
      '',
      'abc'
    ].join('\n');
    const { notes } = replaceChangelogSection(body, '1.2.3', '## [1.2.3]\n\nnew');
    expect(notes).toBe('## Release Notes\n\n## [1.2.3]\n\nnew\n\n## Checksums\n\nabc\n');
  });

  test('replaces the "## vX.Y.Z" heading release.yml writes without a CHANGELOG section', () => {
    const body = [
      '## Release Notes',
      '',
      '## v1.2.3',
      '',
      'Release notes are in CHANGELOG.md.'
    ].join('\n');
    const { notes } = replaceChangelogSection(body, '1.2.3', '## [1.2.3] - date\n\nnew');
    expect(notes).toBe('## Release Notes\n\n## [1.2.3] - date\n\nnew\n');
  });

  test('reports no change when the notes already match', () => {
    const section = extractChangelogSection(CHANGELOG, '5.1.0');
    const first = replaceChangelogSection(PUBLISHED_5_1_0, '5.1.0', section);
    const second = replaceChangelogSection(first.notes, '5.1.0', section);
    expect(second).toEqual({ notes: first.notes, changed: false });
  });

  test('refuses notes without a heading for the version', () => {
    expect(() => replaceChangelogSection('## Release Notes\n\n## [1.2.4]\n', '1.2.3', 'x')).toThrow(
      'no "## [1.2.3]" or "## v1.2.3" heading'
    );
  });
});

describe('buildReleaseNotes', () => {
  test('rejects a tag that is not vX.Y.Z', () => {
    expect(() => buildReleaseNotes({ tag: '5.1.0', body: '', changelog: CHANGELOG })).toThrow(
      'v<major>.<minor>.<patch>'
    );
  });

  test('rejects a version CHANGELOG.md has no section for', () => {
    expect(() =>
      buildReleaseNotes({ tag: 'v0.0.1', body: '## v0.0.1\n', changelog: CHANGELOG })
    ).toThrow('CHANGELOG.md has no "## [0.0.1]" section');
  });
});

describe('update-release-notes CLI', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-'));
    fs.writeFileSync(path.join(dir, 'current.md'), PUBLISHED_5_1_0);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function runCli(tag) {
    return spawnSync(
      process.execPath,
      [
        SCRIPT,
        `--tag=${tag}`,
        `--body=${path.join(dir, 'current.md')}`,
        `--output=${path.join(dir, 'new.md')}`,
        `--changelog=${path.join(ROOT, 'CHANGELOG.md')}`
      ],
      { encoding: 'utf8' }
    );
  }

  test('writes the new notes', () => {
    const result = runCli('v5.1.0');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('v5.1.0: notes updated from CHANGELOG.md');
    const notes = fs.readFileSync(path.join(dir, 'new.md'), 'utf8');
    expect(notes.startsWith(PREAMBLE.join('\n'))).toBe(true);
    expect(notes).toContain('### Known issues');
  });

  test('fails without writing anything for a version CHANGELOG.md lacks', () => {
    const result = runCli('v0.0.1');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CHANGELOG.md has no "## [0.0.1]" section');
    expect(fs.existsSync(path.join(dir, 'new.md'))).toBe(false);
  });
});

describe('update-release-notes workflow', () => {
  const workflow = yaml.load(
    fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'update-release-notes.yml'), 'utf8')
  );
  const steps = workflow.jobs['update-notes'].steps;

  test('defaults to a dry run', () => {
    const { inputs } = workflow.on.workflow_dispatch;
    expect(inputs.tag_name.required).toBe(true);
    expect(inputs.dry_run).toMatchObject({ type: 'boolean', default: true });
    const edit = steps.find((step) => step.name === 'Edit the release');
    expect(edit.if).toBe('${{ !inputs.dry_run }}');
  });

  test('reads CHANGELOG.md and the script from main', () => {
    const checkout = steps[0];
    expect(checkout.with.ref).toBe('main');
    const files = checkout.with['sparse-checkout'].trim().split('\n');
    expect(files).toEqual(
      expect.arrayContaining(['CHANGELOG.md', 'scripts/update-release-notes.js'])
    );
    files.forEach((file) => expect(fs.existsSync(path.join(ROOT, file))).toBe(true));
  });

  test('passes the tag through the environment, not into the script text', () => {
    const build = steps.find((step) => step.name === 'Build the new notes');
    expect(build.env.TAG_NAME).toBe('${{ github.event.inputs.tag_name }}');
    steps.forEach((step) => expect(step.run || '').not.toContain('inputs.tag_name'));
  });
});

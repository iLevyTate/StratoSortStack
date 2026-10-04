const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const { scanDirectory } = require('../../src/main/folderScanner');
const { resolveMtimeMs } = require('../../src/main/services/triage/DownloadsTriageService');

describe('scanDirectory mtimeMs (includeStats)', () => {
  test('every file node has numeric mtimeMs when stats are included', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-mtime-'));
    const filePath = path.join(tmpDir, 'sample.bin');
    await fs.writeFile(filePath, 'x');

    try {
      const items = await scanDirectory(tmpDir, undefined, {
        includeStats: true,
        maxDepth: 1,
        maxFiles: 100
      });

      const files = items.filter((n) => n && n.type === 'file');
      expect(files.length).toBeGreaterThanOrEqual(1);
      for (const node of files) {
        expect(typeof node.mtimeMs).toBe('number');
        expect(Number.isFinite(node.mtimeMs)).toBe(true);
        expect(node.modified).toEqual(expect.any(String));
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('resolveMtimeMs', () => {
  test('prefers mtimeMs, then stats.mtimeMs, then Date.parse(modified)', () => {
    expect(resolveMtimeMs({ mtimeMs: 42 })).toBe(42);
    expect(resolveMtimeMs({ stats: { mtimeMs: 99 } })).toBe(99);
    expect(resolveMtimeMs({ modified: '2020-01-02T03:04:05.000Z' })).toBe(
      Date.parse('2020-01-02T03:04:05.000Z')
    );
    expect(resolveMtimeMs({})).toBe(0);
    expect(resolveMtimeMs(null)).toBe(0);
  });
});

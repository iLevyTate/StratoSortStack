const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  listBundledResourceCandidates,
  readFirstExistingResource,
  findFirstExistingResourcePath,
  getAppRoot
} = require('../src/main/utils/bundledResourcePaths');

describe('bundledResourcePaths', () => {
  test('getAppRoot walks up from src/main, dist, and missing app', () => {
    expect(getAppRoot({ getAppPath: () => path.join('/repo', 'src', 'main') })).toBe(
      path.resolve(path.join('/repo', 'src', 'main'), '../..')
    );
    expect(getAppRoot({ getAppPath: () => path.join('/repo', 'dist') })).toBe(
      path.resolve(path.join('/repo', 'dist'), '..')
    );
    expect(getAppRoot({ getAppPath: () => path.join('/packaged', 'app.asar') })).toBe(
      path.join('/packaged', 'app.asar')
    );
    expect(
      getAppRoot({
        getAppPath: () => {
          throw new Error('no app');
        }
      })
    ).toBe(process.cwd());
    expect(getAppRoot(null)).toBe(process.cwd());
  });

  test('listBundledResourceCandidates includes resourcesPath and app root', () => {
    const originalResourcesPath = process.resourcesPath;
    process.resourcesPath = '/packaged/resources';

    const app = {
      getAppPath: () => '/repo/src/main'
    };

    const candidates = listBundledResourceCandidates('LICENSE', app, {
      devRelativePath: path.join('docs', 'THIRD_PARTY_NOTICES.md')
    });

    const appRoot = path.resolve('/repo/src/main', '../..');

    expect(candidates[0]).toBe(path.join('/packaged/resources', 'LICENSE'));
    expect(candidates[1]).toBe(path.join(appRoot, 'LICENSE'));
    expect(candidates[2]).toBe(path.join(appRoot, 'docs', 'THIRD_PARTY_NOTICES.md'));

    process.resourcesPath = originalResourcesPath;
  });

  test('listBundledResourceCandidates resolves repo root when launched from dist', () => {
    const originalResourcesPath = process.resourcesPath;
    process.resourcesPath = '/packaged/resources';

    const distPath = path.join('/repo', 'dist');
    const repoRoot = path.resolve(distPath, '..');
    const app = {
      getAppPath: () => distPath
    };

    const candidates = listBundledResourceCandidates('THIRD_PARTY_NOTICES.md', app, {
      devRelativePath: path.join('docs', 'THIRD_PARTY_NOTICES.md')
    });

    expect(candidates[1]).toBe(path.join(repoRoot, 'THIRD_PARTY_NOTICES.md'));
    expect(candidates[2]).toBe(path.join(repoRoot, 'docs', 'THIRD_PARTY_NOTICES.md'));

    process.resourcesPath = originalResourcesPath;
  });

  test('findFirstExistingResourcePath returns the first readable candidate', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stratosort-legal-'));
    const licensePath = path.join(tempDir, 'LICENSE');
    fs.writeFileSync(licensePath, 'Proprietary');

    const found = await findFirstExistingResourcePath(
      [path.join(tempDir, 'missing.md'), licensePath],
      fs.promises
    );

    expect(found).toBe(licensePath);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('readFirstExistingResource reads bundled content', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stratosort-notices-'));
    const noticesPath = path.join(tempDir, 'THIRD_PARTY_NOTICES.md');
    fs.writeFileSync(noticesPath, 'Attribution');

    const found = await readFirstExistingResource([noticesPath], fs.promises);

    expect(found).toEqual({ path: noticesPath, content: 'Attribution' });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('readFirstExistingResource continues past non-ENOENT errors', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stratosort-legal-fallback-'));
    const licensePath = path.join(tempDir, 'LICENSE');
    fs.writeFileSync(licensePath, 'Proprietary');

    const blockedPath = path.join(tempDir, 'blocked', 'LICENSE');
    const errors = [];
    const mockFs = {
      readFile: jest.fn(async (candidate) => {
        if (candidate === blockedPath) {
          const err = new Error('permission denied');
          err.code = 'EACCES';
          throw err;
        }
        return fs.promises.readFile(candidate, 'utf8');
      })
    };

    const found = await readFirstExistingResource([blockedPath, licensePath], mockFs, {
      onCandidateError: (candidate, err) => errors.push({ candidate, code: err.code })
    });

    expect(found).toEqual({ path: licensePath, content: 'Proprietary' });
    expect(errors).toEqual([{ candidate: blockedPath, code: 'EACCES' }]);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('findFirstExistingResourcePath continues past non-ENOENT errors', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stratosort-legal-path-'));
    const licensePath = path.join(tempDir, 'LICENSE');
    fs.writeFileSync(licensePath, 'Proprietary');

    const blockedPath = path.join(tempDir, 'blocked', 'LICENSE');
    const errors = [];
    const mockFs = {
      access: jest.fn(async (candidate) => {
        if (candidate === blockedPath) {
          const err = new Error('permission denied');
          err.code = 'EACCES';
          throw err;
        }
        return fs.promises.access(candidate);
      })
    };

    const found = await findFirstExistingResourcePath([blockedPath, licensePath], mockFs, {
      onCandidateError: (candidate, err) => errors.push({ candidate, code: err.code })
    });

    expect(found).toBe(licensePath);
    expect(errors).toEqual([{ candidate: blockedPath, code: 'EACCES' }]);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

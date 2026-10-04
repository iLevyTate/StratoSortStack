'use strict';

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const {
  getAppRootPath,
  getRendererIndexPath,
  getRendererContentType,
  isSubPath,
  resolveRendererAssetPath,
  RENDERER_CONTENT_TYPES
} = require('../../../src/main/core/rendererAssets');

const ROOT = path.resolve('/srv/renderer-root');

describe('rendererAssets', () => {
  describe('getRendererContentType', () => {
    test('maps known extensions case-insensitively', () => {
      expect(getRendererContentType('index.html')).toBe('text/html; charset=utf-8');
      expect(getRendererContentType('bundle.JS')).toBe('text/javascript; charset=utf-8');
      expect(getRendererContentType('logo.png')).toBe('image/png');
      expect(getRendererContentType('font.woff2')).toBe('font/woff2');
    });

    test('falls back to octet-stream for unknown or missing extensions', () => {
      expect(getRendererContentType('archive.xyz')).toBe('application/octet-stream');
      expect(getRendererContentType('Makefile')).toBe('application/octet-stream');
    });

    test('content-type table is frozen (single source of truth)', () => {
      expect(Object.isFrozen(RENDERER_CONTENT_TYPES)).toBe(true);
    });
  });

  describe('isSubPath', () => {
    test('accepts the root itself and descendants', () => {
      expect(isSubPath(ROOT, ROOT)).toBe(true);
      expect(isSubPath(path.join(ROOT, 'assets', 'app.js'), ROOT)).toBe(true);
    });

    test('rejects parents, siblings, and traversal', () => {
      expect(isSubPath(path.resolve(ROOT, '..'), ROOT)).toBe(false);
      expect(isSubPath(path.resolve(ROOT, '..', 'other'), ROOT)).toBe(false);
      expect(isSubPath(path.join(ROOT, '..', 'secret.txt'), ROOT)).toBe(false);
    });
  });

  describe('resolveRendererAssetPath', () => {
    // Assert against path.resolve (what the source uses) rather than path.join: on
    // some Windows runners the two normalize the separator differently for a
    // drive-rooted ROOT, so comparing across the two APIs is brittle. Mirroring the
    // source's resolution call keeps the assertion separator-agnostic.
    test('maps "/" to index.html under the root', () => {
      expect(resolveRendererAssetPath(ROOT, '/')).toBe(path.resolve(ROOT, 'index.html'));
    });

    test('defaults empty / non-string pathname to index.html', () => {
      expect(resolveRendererAssetPath(ROOT, '')).toBe(path.resolve(ROOT, 'index.html'));
      expect(resolveRendererAssetPath(ROOT, undefined)).toBe(path.resolve(ROOT, 'index.html'));
    });

    test('resolves nested asset paths', () => {
      expect(resolveRendererAssetPath(ROOT, '/assets/app.js')).toBe(
        path.resolve(ROOT, 'assets', 'app.js')
      );
    });

    test('blocks plain path traversal (returns null)', () => {
      expect(resolveRendererAssetPath(ROOT, '/../secret.txt')).toBeNull();
    });

    test('blocks percent-encoded path traversal (returns null)', () => {
      expect(resolveRendererAssetPath(ROOT, '/%2e%2e/secret.txt')).toBeNull();
    });
  });

  describe('getAppRootPath', () => {
    // The shared electron mock has no getAppPath; install one per-test and remove it.
    afterEach(() => {
      delete app.getAppPath;
    });

    test('climbs to repo root when app path ends in src/main', () => {
      app.getAppPath = jest.fn(() => path.join('/repo', 'src', 'main'));
      expect(getAppRootPath()).toBe(path.resolve('/repo'));
    });

    test('climbs one level when app path ends in dist', () => {
      app.getAppPath = jest.fn(() => path.join('/repo', 'dist'));
      expect(getAppRootPath()).toBe(path.resolve('/repo'));
    });

    test('returns the app path unchanged for a normal packaged path', () => {
      const packaged = path.resolve('/Applications/StratoSort.app/Contents/Resources/app.asar');
      app.getAppPath = jest.fn(() => packaged);
      expect(getAppRootPath()).toBe(packaged);
    });

    test('falls back to cwd when getAppPath throws', () => {
      app.getAppPath = jest.fn(() => {
        throw new Error('app not ready');
      });
      expect(getAppRootPath()).toBe(process.cwd());
    });
  });

  describe('getRendererIndexPath', () => {
    const originalResourcesPath = process.resourcesPath;
    const originalIsPackaged = app.isPackaged;

    afterEach(() => {
      app.isPackaged = originalIsPackaged;
      if (originalResourcesPath === undefined) {
        delete process.resourcesPath;
      } else {
        process.resourcesPath = originalResourcesPath;
      }
      delete app.getAppPath;
      jest.restoreAllMocks();
    });

    test('packaged prefers asar dist/index.html even when an unpacked copy also exists', () => {
      const asarRoot = path.resolve('/Applications/StratoSort.app/Contents/Resources/app.asar');
      app.isPackaged = true;
      app.getAppPath = jest.fn(() => asarRoot);
      process.resourcesPath = path.resolve('/Applications/StratoSort.app/Contents/Resources');
      const asarIndex = path.join(asarRoot, 'dist', 'index.html');
      const unpackedIndex = path.join(
        process.resourcesPath,
        'app.asar.unpacked',
        'dist',
        'index.html'
      );
      jest.spyOn(fs, 'existsSync').mockImplementation((candidate) => {
        return candidate === asarIndex || candidate === unpackedIndex;
      });
      expect(getRendererIndexPath()).toBe(asarIndex);
    });

    test('packaged falls back to unpacked dist when asar index is missing', () => {
      const asarRoot = path.resolve('/Applications/StratoSort.app/Contents/Resources/app.asar');
      app.isPackaged = true;
      app.getAppPath = jest.fn(() => asarRoot);
      process.resourcesPath = path.resolve('/Applications/StratoSort.app/Contents/Resources');
      const unpackedIndex = path.join(
        process.resourcesPath,
        'app.asar.unpacked',
        'dist',
        'index.html'
      );
      jest.spyOn(fs, 'existsSync').mockImplementation((candidate) => candidate === unpackedIndex);
      expect(getRendererIndexPath()).toBe(unpackedIndex);
    });
  });
});

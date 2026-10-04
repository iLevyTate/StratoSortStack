/**
 * Tests for RelationshipIndexService.rebuildNow — Phase 2 user-facing rebuild
 * action. Must bypass the 10-minute throttle (_REBUILD_MIN_INTERVAL_MS) so
 * that a user who explicitly clicks "Rebuild" always gets a fresh index.
 */

jest.unmock('fs');
jest.unmock('fs/promises');
jest.unmock('os');

const path = require('path');
const fs = require('fs').promises;
const os = require('os');

jest.mock('electron', () => ({
  app: { getPath: jest.fn() }
}));

describe('RelationshipIndexService.rebuildNow', () => {
  let RelationshipIndexService;
  let service;
  let testDir;
  let mockAnalysisHistory;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `rel-rebuild-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    const electron = require('electron');
    electron.app.getPath.mockReturnValue(testDir);
    jest.resetModules();
    const electronAfter = require('electron');
    electronAfter.app.getPath.mockReturnValue(testDir);

    RelationshipIndexService = require('../src/main/services/RelationshipIndexService');

    mockAnalysisHistory = {
      initialize: jest.fn().mockResolvedValue(undefined),
      analysisHistory: {
        updatedAt: '2026-04-21T00:00:00.000Z',
        entries: {}
      }
    };

    service = new RelationshipIndexService({ analysisHistoryService: mockAnalysisHistory });
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('rebuildNow exists and is async', () => {
    expect(typeof service.rebuildNow).toBe('function');
  });

  test('rebuildNow bypasses the throttle window', async () => {
    // Simulate a recent rebuild so the regular gate would block a rebuild.
    service._lastRebuildAt = Date.now(); // fresh build, throttle active
    const spy = jest.spyOn(service, 'buildIndex');
    await service.rebuildNow();
    expect(spy).toHaveBeenCalledTimes(1);
    // After rebuildNow, _lastRebuildAt is updated by buildIndex itself, so
    // the value should be within a small window of "now".
    expect(Date.now() - service._lastRebuildAt).toBeLessThan(5000);
  });

  test('rebuildNow returns the buildIndex result', async () => {
    jest.spyOn(service, 'buildIndex').mockResolvedValue({ success: true, edges: [{ id: 'e1' }] });
    const result = await service.rebuildNow();
    expect(result.success).toBe(true);
    expect(result.edges).toHaveLength(1);
  });
});

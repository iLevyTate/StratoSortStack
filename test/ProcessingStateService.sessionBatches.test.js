/**
 * Startup resume tells a crash-interrupted batch from a live one by asking
 * whether this process created it; a batch loaded from the journal on disk
 * is never a session batch.
 */

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => 'C:\\fake-user-data')
  }
}));

jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

const fs = require('fs').promises;
const ProcessingStateService = require('../src/main/services/ProcessingStateService');

describe('ProcessingStateService.isSessionOrganizeBatch', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(fs, 'readFile').mockResolvedValue(
      JSON.stringify({
        schemaVersion: '1.0.0',
        analysis: { jobs: {}, ready: {}, lastUpdated: '' },
        organize: {
          batches: {
            'from-disk': {
              id: 'from-disk',
              operations: [{ source: '/a', destination: '/b', status: 'pending' }],
              startedAt: '2026-01-01T00:00:00.000Z',
              completedAt: null
            }
          },
          lastUpdated: ''
        }
      })
    );
    jest.spyOn(fs, 'writeFile').mockResolvedValue();
    jest.spyOn(fs, 'rename').mockResolvedValue();
    jest.spyOn(fs, 'mkdir').mockResolvedValue();
    jest.spyOn(fs, 'unlink').mockResolvedValue();
  });

  test('is true only for batches this process created', async () => {
    const service = new ProcessingStateService();
    jest.spyOn(service, 'saveState').mockResolvedValue(undefined);
    await service.initialize();

    await service.createOrLoadOrganizeBatch('live', [{ source: '/c', destination: '/d' }]);
    // Loading an existing entry does not make it a session batch.
    await service.createOrLoadOrganizeBatch('from-disk', []);

    expect(service.isSessionOrganizeBatch('live')).toBe(true);
    expect(service.isSessionOrganizeBatch('from-disk')).toBe(false);
    expect(
      service
        .getIncompleteOrganizeBatches()
        .map((b) => b.id)
        .sort()
    ).toEqual(['from-disk', 'live']);
  });
});

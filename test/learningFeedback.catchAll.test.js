/**
 * A file sitting in the catch-all folder ("Uncategorized", or whatever the
 * user renamed it to) means "fit nowhere", not "belongs here". A tester
 * pointed the catch-all at their input folder; every unsorted file there taught
 * the app to suggest that input folder. Only a user's own move into it is learned.
 */

jest.mock('../src/main/services/ServiceContainer', () => ({
  container: { has: jest.fn().mockReturnValue(false), resolve: jest.fn() },
  ServiceIds: { LEARNING_FEEDBACK: 'learningFeedback' }
}));

const {
  LearningFeedbackService,
  FEEDBACK_SOURCES
} = require('../src/main/services/organization/learningFeedback');

const CATCH_ALL = {
  id: 'default-uncategorized-1',
  name: 'Strato test Data',
  path: '/Users/alex/Strato test Data',
  category: 'uncategorized',
  isDefault: true
};
const PLAIN_UNCATEGORIZED = {
  id: 'u2',
  name: 'Uncategorized',
  path: '/Users/alex/Uncategorized'
};
const GSC = {
  id: 'gsc',
  name: 'GSC',
  path: '/Users/alex/GSC',
  category: 'general'
};
// A seeded default folder that is not the catch-all.
const ARCHIVES = {
  id: 'default-archives-1',
  name: 'Archives',
  path: '/Users/alex/Archives',
  category: 'archives',
  isDefault: true
};

function makeService() {
  const suggestionService = {
    recordFeedback: jest.fn().mockResolvedValue(undefined),
    patternMatcher: { incrementFolderUsage: jest.fn() }
  };
  const service = new LearningFeedbackService({
    suggestionService,
    getSmartFolders: () => [CATCH_ALL, PLAIN_UNCATEGORIZED, GSC, ARCHIVES]
  });
  return { service, suggestionService };
}

const place = (service, smartFolder, source, name = 'a.csv') =>
  service.recordFilePlacement({
    filePath: `${smartFolder.path}/${name}`,
    smartFolder,
    analysis: { category: 'Bing', confidence: 0.9 },
    source
  });

describe('recordFilePlacement and the catch-all folder', () => {
  test.each([
    ['watcher detection', FEEDBACK_SOURCES.WATCHER_DETECTION],
    ['startup scan', FEEDBACK_SOURCES.STARTUP_SCAN]
  ])('a file found there by %s teaches nothing', async (_label, source) => {
    const { service, suggestionService } = makeService();
    await expect(place(service, CATCH_ALL, source)).resolves.toBe(false);
    await expect(place(service, PLAIN_UNCATEGORIZED, source, 'b.csv')).resolves.toBe(false);
    expect(suggestionService.recordFeedback).not.toHaveBeenCalled();
  });

  test('a user moving a file there is still learned', async () => {
    const { service, suggestionService } = makeService();
    await expect(place(service, CATCH_ALL, FEEDBACK_SOURCES.MANUAL_MOVE)).resolves.toBe(true);
    expect(suggestionService.recordFeedback).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['an ordinary folder', GSC],
    ['a seeded default folder', ARCHIVES]
  ])('a file the watcher finds in %s is still learned', async (_label, folder) => {
    const { service, suggestionService } = makeService();
    await expect(place(service, folder, FEEDBACK_SOURCES.WATCHER_DETECTION)).resolves.toBe(true);
    expect(suggestionService.recordFeedback).toHaveBeenCalledTimes(1);
  });
});

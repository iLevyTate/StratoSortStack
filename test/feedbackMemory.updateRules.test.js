/**
 * Editing a memory keeps its origin: a correction note StratoSort wrote stays
 * a note when reworded, and a note the user typed can become a rule.
 */

jest.mock('../src/main/services/LlamaService', () => ({
  getInstance: () => ({ initialize: jest.fn(), getConfig: jest.fn(() => ({})) })
}));

const { vol } = require('memfs');
const OrganizationSuggestionService = require('../src/main/services/organization');

function makeService() {
  return new OrganizationSuggestionService({
    vectorDbService: { upsertFeedbackMemory: jest.fn().mockResolvedValue({ success: true }) },
    folderMatchingService: {
      embedText: jest.fn().mockResolvedValue({ vector: [0.1, 0.2], model: 'm' })
    },
    settingsService: { load: jest.fn().mockResolvedValue({}) }
  });
}

beforeEach(() => {
  vol.reset();
});

test('rewording a correction note does not create a rule', async () => {
  const service = makeService();
  const note = await service.addFeedbackMemory(
    'Files like "a.pdf" do not belong in "Photos"; they belong in "Clients".',
    { source: 'feedback_reject', targetFolder: 'Photos' }
  );
  expect(note.rules).toEqual([]);

  const updated = await service.updateFeedbackMemory(note.id, 'pdf files go to Clients');
  expect(updated.rules).toEqual([]);
  expect(updated.source).toBe('feedback_reject');
});

test('a typed note edited into a rule becomes one', async () => {
  const service = makeService();
  const typed = await service.addFeedbackMemory('Keep exports together');
  const updated = await service.updateFeedbackMemory(typed.id, 'CSV files go to Bing');
  expect(updated.rules).toEqual([expect.objectContaining({ extension: 'csv', folder: 'Bing' })]);
});

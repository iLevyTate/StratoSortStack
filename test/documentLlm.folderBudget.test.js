/**
 * The Smart Folder list in the document prompt is sized to the model's
 * context. On the CPU backend the text context is 2048 tokens; 15 folders
 * with long descriptions used to fill most of it, so the prompt overflowed
 * and every document fell back.
 */

const { analyzeTextWithLlama } = require('../src/main/analysis/documentLlm');

jest.mock('../src/shared/logger', () => {
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  };
  return { logger, createLogger: jest.fn(() => logger) };
});

const mockLlamaService = {
  _initialized: true,
  initialize: jest.fn().mockResolvedValue(undefined),
  getConfig: jest.fn(),
  listModels: jest.fn().mockResolvedValue([{ name: 'test-model.gguf' }]),
  updateConfig: jest.fn().mockResolvedValue(undefined),
  generateText: jest.fn()
};

jest.mock('../src/main/services/LlamaService', () => ({
  getInstance: () => mockLlamaService
}));

const CHARS_PER_TOKEN = 3;

function folderBlock(prompt) {
  const start = prompt.indexOf('AVAILABLE SMART FOLDERS');
  const end = prompt.indexOf('SELECTION RULES');
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return prompt.slice(start, end);
}

function manyFolders(n) {
  return [
    ...Array.from({ length: n }, (_, i) => ({
      name: `Client project ${i + 1}`,
      description: `Contracts, invoices and letters for client project ${i + 1}. `.repeat(5),
      isDefault: false
    })),
    {
      name: 'Uncategorized',
      category: 'uncategorized',
      isDefault: true,
      description: "Default folder for files that don't match any smart folder"
    }
  ];
}

describe('document prompt folder list and context size', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLlamaService.listModels.mockResolvedValue([{ name: 'test-model.gguf' }]);
    mockLlamaService.generateText.mockResolvedValue({
      response: JSON.stringify({ category: 'Uncategorized', confidence: 0.5 })
    });
  });

  test('2048-token context: the folder list stays a bounded share and keeps names and the catch-all', async () => {
    const contextSize = 2048;
    mockLlamaService.getConfig.mockResolvedValue({ textModel: 'test-model.gguf', contextSize });
    const folders = manyFolders(15);

    await analyzeTextWithLlama('Some contract text for budget test A', 'a.txt', folders);

    const prompt = mockLlamaService.generateText.mock.calls[0][0].prompt;
    const block = folderBlock(prompt);
    expect(block.length / CHARS_PER_TOKEN).toBeLessThan(contextSize * 0.3);
    expect(block).toContain('"Uncategorized"');
    // The old ten-folder list: nine of the user's folders plus the catch-all.
    for (let i = 1; i <= 9; i++) expect(block).toContain(`"Client project ${i}"`);
    // Descriptions are shortened, not dropped.
    expect(block).toContain('Contracts, invoices');
    expect(block).not.toContain('no description provided');
  });

  test('a large context still lists every folder with its full description', async () => {
    mockLlamaService.getConfig.mockResolvedValue({
      textModel: 'test-model.gguf',
      contextSize: 32768
    });
    const folders = manyFolders(15);

    await analyzeTextWithLlama('Some contract text for budget test B', 'b.txt', folders);

    const block = folderBlock(mockLlamaService.generateText.mock.calls[0][0].prompt);
    for (let i = 1; i <= 15; i++) expect(block).toContain(`"Client project ${i}"`);
    expect(block).toContain(folders[0].description.trim().slice(0, 300));
  });
});

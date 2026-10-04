/**
 * PromptBuilder unit tests — assembled prompt budget and source fencing.
 */

jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

const {
  buildPrompt,
  MAX_PROMPT_CHARS,
  MAX_HISTORY_CHARS
} = require('../src/main/services/chat/PromptBuilder');

function source(id, overrides = {}) {
  return {
    id,
    name: `doc-${id}.pdf`,
    score: 0.9,
    semanticScore: 0.9,
    extractedText: 'Relevant body text. '.repeat(20),
    ...overrides
  };
}

describe('PromptBuilder', () => {
  test('includes the user question and JSON answer shape', () => {
    const { prompt } = buildPrompt({
      query: 'What is the invoice total?',
      history: '',
      sources: [source('doc-1')]
    });

    expect(prompt).toContain('What is the invoice total?');
    expect(prompt).toContain('"documentAnswer"');
    expect(prompt).toContain('"modelAnswer"');
    expect(prompt).toMatch(/<doc-[0-9a-f]{16}>/);
  });

  test('drops lowest-ranked sources before exceeding MAX_PROMPT_CHARS', () => {
    const bulky = 'x'.repeat(8000);
    const { prompt } = buildPrompt({
      query: 'Summarize these files',
      history: '',
      sources: [
        source('doc-1', { semanticScore: 0.95, extractedText: bulky }),
        source('doc-2', { semanticScore: 0.7, extractedText: bulky }),
        source('doc-3', { semanticScore: 0.5, extractedText: bulky }),
        source('doc-4', { semanticScore: 0.45, extractedText: bulky })
      ],
      responseMode: 'deep'
    });

    expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
    expect(prompt).toContain('Summarize these files');
  });

  test('trims history from the oldest side before dropping the query', () => {
    const history = `User: old turn\nAssistant: old answer\n${'User: filler\nAssistant: filler\n'.repeat(400)}`;
    expect(history.length).toBeGreaterThan(MAX_HISTORY_CHARS);

    const { prompt } = buildPrompt({
      query: 'Keep this question intact',
      history,
      sources: []
    });

    expect(prompt).toContain('Keep this question intact');
    expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
  });

  test('derives a smaller budget from a CPU-sized effective context', () => {
    const bulky = 'x'.repeat(8000);
    const { prompt } = buildPrompt({
      query: 'Keep this question intact',
      history: '',
      sources: [
        source('doc-1', { extractedText: bulky }),
        source('doc-2', { extractedText: bulky })
      ],
      effectiveContext: 2048
    });

    expect(prompt).toContain('Keep this question intact');
    expect(prompt.length).toBeLessThan(MAX_PROMPT_CHARS);
    expect(prompt.length).toBeLessThanOrEqual(Math.floor(2048 * 4 * 0.7));
  });
});

describe('PromptBuilder trim ladder (sources before history)', () => {
  const CPU_CONTEXT = 2048;
  const cpuBudget = Math.floor(CPU_CONTEXT * 4 * 0.7);
  const fiveSources = () =>
    [1, 2, 3, 4, 5].map((n) =>
      source(`doc-${n}`, {
        semanticScore: 0.9 - n * 0.05,
        snippet: `Summary of document ${n}. `.repeat(4),
        extractedText: `Body of document ${n}. `.repeat(60)
      })
    );
  const longHistory = `User: OLDEST-MARKER\nAssistant: ${'earlier answer '.repeat(200)}\nUser: NEWEST-MARKER`;

  test('reports which sources stayed in the prompt', () => {
    const { prompt, keptSourceIds, droppedSourceCount } = buildPrompt({
      query: 'q',
      history: '',
      sources: fiveSources()
    });

    expect(keptSourceIds).toEqual(['doc-1', 'doc-2', 'doc-3', 'doc-4', 'doc-5']);
    expect(droppedSourceCount).toBe(0);
    expect(prompt).toContain('[doc-5]');
  });

  test('on a CPU-sized context with history, every source survives and history gives way first', () => {
    const { prompt, keptSourceIds, historyChars, extractScale } = buildPrompt({
      query: 'q',
      history: longHistory,
      sources: fiveSources(),
      effectiveContext: CPU_CONTEXT
    });

    expect(prompt.length).toBeLessThanOrEqual(cpuBudget);
    // The old order dropped sources until "(no documents found)".
    expect(keptSourceIds).toHaveLength(5);
    expect(prompt).not.toContain('(no documents found)');
    expect(prompt).toContain('NEWEST-MARKER');
    expect(prompt).not.toContain('OLDEST-MARKER');
    expect(historyChars).toBeLessThan(longHistory.length);
    expect(extractScale).toBeLessThan(1);
  });

  test('shortens extracts before dropping a source', () => {
    // Budget sized so full extracts overflow but metadata-only sources fit.
    const { keptSourceIds, extractScale, prompt } = buildPrompt({
      query: 'q',
      history: '',
      sources: fiveSources(),
      responseMode: 'deep',
      effectiveContext: CPU_CONTEXT
    });

    expect(keptSourceIds).toHaveLength(5);
    expect(extractScale).toBeLessThan(1);
    expect(prompt).toContain('Summary of document 5.');
  });

  test('drops whole sources, lowest-ranked first, only after extracts and history are gone', () => {
    const { keptSourceIds, droppedSourceCount, extractScale, historyChars } = buildPrompt({
      query: 'q',
      history: longHistory,
      sources: fiveSources().map((s) => ({ ...s, snippet: 'S. '.repeat(400) })),
      effectiveContext: 1024
    });

    expect(droppedSourceCount).toBeGreaterThan(0);
    expect(extractScale).toBe(0);
    expect(historyChars).toBe(0);
    expect(keptSourceIds[0]).toBe('doc-1');
    expect(keptSourceIds).not.toContain('doc-5');
  });
});

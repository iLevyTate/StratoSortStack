/**
 * Integration Tests - Real File Extraction
 *
 * Validates that document text extraction works correctly with actual
 * test files from test/test-files/. Unlike unit tests that mock fs I/O,
 * these tests read real files and verify meaningful content is extracted.
 *
 * Covers: TXT, CSV, HTML, RTF, EML file types (no external binary deps)
 */

// test-setup.js replaces fs with memfs globally; this suite exists precisely
// to read REAL fixture files, so restore the genuine fs modules. Without this
// every fixture lookup failed and the whole suite passed vacuously.
jest.unmock('fs');
jest.unmock('fs/promises');

const path = require('path');
const fs = require('fs').promises;

// Mock only the dependencies that aren't needed for extraction
jest.mock('unpdf', () => ({
  extractText: jest.fn()
}));
jest.mock('sharp');
jest.mock('../../src/main/utils/tesseractUtils', () => ({
  isTesseractAvailable: jest.fn().mockResolvedValue(false),
  recognizeIfAvailable: jest.fn().mockResolvedValue({ success: false, text: '' })
}));
jest.mock('mammoth');
jest.mock('xlsx-populate');
jest.mock('adm-zip');

const {
  extractPlainTextFromRtf,
  extractPlainTextFromHtml,
  extractTextFromCsv,
  extractTextFromEml
} = require('../../src/main/analysis/documentExtractors');

const FIXTURE_DIR = path.resolve(__dirname, '../test-files');

// Fixtures are committed to the repo; a missing one means a broken checkout or
// fixture rename and must FAIL, not skip — skip-on-missing previously turned
// this entire suite into a silent no-op under the global memfs mock.
const REQUIRED_FIXTURES = [
  'sample.txt',
  'contract.txt',
  'project-report.md',
  'sales_data.csv',
  'webpage_template.html',
  'rich_text_doc.rtf',
  'meeting_invite.eml'
];

beforeAll(async () => {
  const missing = [];
  for (const filename of REQUIRED_FIXTURES) {
    try {
      await fs.access(path.join(FIXTURE_DIR, filename));
    } catch {
      missing.push(filename);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Required test fixtures missing from ${FIXTURE_DIR}: ${missing.join(', ')}. ` +
        'Restore them from git — these tests must not skip silently.'
    );
  }
});

describe('Real File Extraction - Text Files', () => {
  test('extracts meaningful content from sample.txt (invoice)', async () => {
    const filePath = path.join(FIXTURE_DIR, 'sample.txt');
    const content = await fs.readFile(filePath, 'utf8');

    expect(content).toBeDefined();
    expect(content.length).toBeGreaterThan(50);
    // Verify domain-specific content was read
    expect(content).toContain('Invoice');
    expect(content).toContain('Acme Corporation');
    expect(content).toContain('$1,250.00');
    expect(content).toContain('Financial');
  });

  test('extracts meaningful content from contract.txt (legal)', async () => {
    const filePath = path.join(FIXTURE_DIR, 'contract.txt');
    const content = await fs.readFile(filePath, 'utf8');

    expect(content).toBeDefined();
    expect(content.length).toBeGreaterThan(100);
    expect(content).toContain('SERVICE AGREEMENT');
    expect(content).toContain('TERMS AND CONDITIONS');
    expect(content).toContain('$50,000');
    expect(content).toContain('CONFIDENTIALITY');
  });

  test('extracts content from project-report.md (markdown)', async () => {
    const filePath = path.join(FIXTURE_DIR, 'project-report.md');
    const content = await fs.readFile(filePath, 'utf8');

    expect(content).toBeDefined();
    expect(content.length).toBeGreaterThan(50);
    // Markdown files should be readable as plain text
    expect(typeof content).toBe('string');
  });
});

describe('Real File Extraction - CSV', () => {
  test('extracts tabular data from sales_data.csv', async () => {
    const filePath = path.join(FIXTURE_DIR, 'sales_data.csv');
    const result = await extractTextFromCsv(filePath);

    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(20);
    // Verify CSV content was parsed into readable text
    expect(result).toContain('Widget');
    expect(result).toContain('Electronics');
  });
});

describe('Real File Extraction - HTML', () => {
  test('strips HTML tags from webpage_template.html', async () => {
    const raw = await fs.readFile(path.join(FIXTURE_DIR, 'webpage_template.html'), 'utf8');
    const result = await extractPlainTextFromHtml(raw);

    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
    // Should have stripped HTML tags
    expect(result).not.toContain('<html');
    expect(result).not.toContain('<body');
    expect(result).not.toContain('<meta');
    // Should preserve text content
    expect(result).toContain('Welcome to Sample Page');
    expect(result).toContain('About This Page');
    expect(result).toContain('sample HTML file');
  });
});

describe('Real File Extraction - RTF', () => {
  test('strips RTF control words from rich_text_doc.rtf', async () => {
    const raw = await fs.readFile(path.join(FIXTURE_DIR, 'rich_text_doc.rtf'), 'utf8');
    const result = await extractPlainTextFromRtf(raw);

    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
    // Should have stripped RTF control sequences
    expect(result).not.toContain('{\\rtf1');
    expect(result).not.toContain('\\fonttbl');
    expect(result).not.toContain('\\pard');
    // Should preserve readable text
    expect(result).toContain('Sample Rich Text Document');
    expect(result).toContain('rich text');
  });
});

describe('Real File Extraction - EML', () => {
  test('extracts email content from meeting_invite.eml', async () => {
    const filePath = path.join(FIXTURE_DIR, 'meeting_invite.eml');
    const result = await extractTextFromEml(filePath);

    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(20);
    // Should extract email headers and body
    expect(result).toContain('Project Meeting');
    expect(result).toContain('planning');
  });
});

describe('Real File Extraction - Content Quality', () => {
  test('extracted text is suitable for AI analysis (non-trivial length)', async () => {
    const textFiles = [
      { file: 'sample.txt', minLength: 100 },
      { file: 'contract.txt', minLength: 200 }
    ];

    for (const { file, minLength } of textFiles) {
      const content = await fs.readFile(path.join(FIXTURE_DIR, file), 'utf8');
      expect(content.trim().length).toBeGreaterThan(minLength);
      // Content should not be mostly whitespace
      const nonWhitespaceRatio = content.replace(/\s/g, '').length / content.length;
      expect(nonWhitespaceRatio).toBeGreaterThan(0.3);
    }
  });

  test('extracted text contains categorizable keywords', async () => {
    const content = await fs.readFile(path.join(FIXTURE_DIR, 'sample.txt'), 'utf8');
    const lowerContent = content.toLowerCase();

    // Should contain financial domain keywords that AI can use for categorization
    const financialKeywords = ['invoice', 'payment', 'financial', 'amount'];
    const matchedKeywords = financialKeywords.filter((kw) => lowerContent.includes(kw));
    expect(matchedKeywords.length).toBeGreaterThanOrEqual(2);
  });

  test('HTML extraction preserves semantic content, removes markup', async () => {
    const raw = await fs.readFile(path.join(FIXTURE_DIR, 'webpage_template.html'), 'utf8');
    const extracted = await extractPlainTextFromHtml(raw);

    // Raw HTML has tags, extracted should not
    expect(raw).toContain('<h1>');
    expect(extracted).not.toContain('<h1>');

    // But the text content should be preserved
    const rawTextContent = 'Welcome to Sample Page';
    expect(raw).toContain(rawTextContent);
    expect(extracted).toContain(rawTextContent);
  });
});

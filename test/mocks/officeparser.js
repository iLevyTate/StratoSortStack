/**
 * Mock for the `officeparser` package.
 *
 * officeparser v6+ exposes `parseOffice(filePath)` which resolves to an
 * `OfficeParserAST` object (`{ type, metadata, content, attachments, toText() }`).
 * It does NOT expose `parseOfficeAsync` and the AST has no `.text` property —
 * plain text is obtained via `ast.toText()`. The mock mirrors that contract so
 * tests exercise the same code path as production.
 */

const MOCK_TEXT = 'Mock document text content';

const mockOfficeParser = {
  parseOffice: jest.fn().mockResolvedValue({
    type: 'docx',
    metadata: {
      title: 'Mock Document Title',
      author: 'Mock Author',
      pages: 1
    },
    content: [{ type: 'paragraph', text: MOCK_TEXT }],
    attachments: [],
    toText: () => MOCK_TEXT
  }),

  terminateOcr: jest.fn().mockResolvedValue(undefined)
};

module.exports = mockOfficeParser;

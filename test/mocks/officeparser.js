/**
 * Mock for the `officeparser` package.
 *
 * officeparser v8 exposes `parseOffice(filePath)` which resolves to an
 * `OfficeParserAST` object (`{ type, metadata, content, attachments, to() }`).
 * It does NOT expose `parseOfficeAsync` and the AST has no `.text` property —
 * plain text is obtained via `(await ast.to('text')).value` (v6-v7 used a
 * synchronous `ast.toText()` instead). The mock mirrors the v8 contract so
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
    to: async (destination) => ({ value: destination === 'text' ? MOCK_TEXT : '', messages: [] })
  }),

  terminateOcr: jest.fn().mockResolvedValue(undefined)
};

module.exports = mockOfficeParser;

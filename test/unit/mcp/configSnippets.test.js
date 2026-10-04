'use strict';
const { generateSnippet } = require('../../../src/main/transports/mcp/configSnippets');

describe('configSnippets', () => {
  const ctx = { port: 53827, token: 'a'.repeat(64) };

  test('claudeDesktop returns expected JSON shape', () => {
    const s = generateSnippet('claudeDesktop', ctx);
    const parsed = JSON.parse(s);
    expect(parsed.mcpServers.stratosort.url).toBe('http://127.0.0.1:53827/mcp');
    expect(parsed.mcpServers.stratosort.headers.Authorization).toBe(`Bearer ${ctx.token}`);
  });

  test('cursor returns expected shape', () => {
    const s = generateSnippet('cursor', ctx);
    expect(s).toContain('"stratosort"');
    expect(s).toContain('"http://127.0.0.1:53827/mcp"');
  });

  test('zed returns expected shape', () => {
    const s = generateSnippet('zed', ctx);
    expect(s).toContain('context_servers');
    expect(s).toContain('stratosort');
  });

  test('throws on unknown client', () => {
    expect(() => generateSnippet('weird', ctx)).toThrow();
  });
});

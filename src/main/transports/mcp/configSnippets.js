// @ts-check
'use strict';

/**
 * @param {string} client
 * @param {{ port: number, token: string }} params
 */
function generateSnippet(client, { port, token }) {
  const url = `http://127.0.0.1:${port}/mcp`;
  const auth = `Bearer ${token}`;
  switch (client) {
    case 'claudeDesktop':
      return JSON.stringify(
        {
          mcpServers: { stratosort: { url, headers: { Authorization: auth } } }
        },
        null,
        2
      );
    case 'cursor':
      return JSON.stringify(
        {
          mcpServers: { stratosort: { url, headers: { Authorization: auth } } }
        },
        null,
        2
      );
    case 'zed':
      return JSON.stringify(
        {
          context_servers: { stratosort: { source: 'http', url, headers: { Authorization: auth } } }
        },
        null,
        2
      );
    default:
      throw new Error(`Unknown MCP client: ${client}`);
  }
}

module.exports = { generateSnippet };

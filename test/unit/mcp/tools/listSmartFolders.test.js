'use strict';

describe('list_smart_folders tool', () => {
  let captured;
  const fakeMcp = {
    registerTool: (_name, _schema, handler) => {
      captured = handler;
    }
  };
  const services = {
    smartFolders: {
      list: async () => [
        {
          id: 'f1',
          name: 'Tax',
          path: '/tmp/Tax',
          description: 'Tax docs'
        }
      ]
    }
  };

  test('returns folders in MCP content shape', async () => {
    const {
      registerListSmartFolders
    } = require('../../../../src/main/transports/mcp/tools/listSmartFolders');
    registerListSmartFolders(fakeMcp, services);
    const result = await captured({});
    const body = JSON.parse(result.content[0].text);
    expect(body.folders).toHaveLength(1);
    expect(body.folders[0]).toMatchObject({
      id: 'f1',
      name: 'Tax',
      destination_path: '/tmp/Tax',
      description: 'Tax docs',
      // Folder records carry no counts; the directory does not exist here,
      // so both read as unknown rather than zero.
      file_count: null,
      last_organized_at: null
    });
  });

  test('returns SERVICE_UNAVAILABLE when smartFolders.list throws', async () => {
    const {
      registerListSmartFolders
    } = require('../../../../src/main/transports/mcp/tools/listSmartFolders');
    registerListSmartFolders(fakeMcp, {
      smartFolders: {
        list: async () => {
          throw new Error('boom');
        }
      }
    });
    const result = await captured({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('SERVICE_UNAVAILABLE');
  });
});

describe('list_smart_folders reads what the folder holds', () => {
  test('counts the files directly inside the folder and reports when its entries last changed', async () => {
    const { vol } = require('memfs');
    vol.mkdirSync('/smart/Tax/nested', { recursive: true });
    vol.writeFileSync('/smart/Tax/a.pdf', 'a');
    vol.writeFileSync('/smart/Tax/b.pdf', 'b');
    vol.writeFileSync('/smart/Tax/nested/c.pdf', 'c');
    let handler;
    const {
      registerListSmartFolders
    } = require('../../../../src/main/transports/mcp/tools/listSmartFolders');
    registerListSmartFolders(
      { registerTool: (_n, _s, h) => (handler = h) },
      {
        smartFolders: {
          list: async () => [
            { id: 'tax', name: 'Tax', path: '/smart/Tax' },
            { id: 'gone', name: 'Gone', path: '/smart/does-not-exist' }
          ]
        }
      }
    );

    const body = JSON.parse((await handler({})).content[0].text);
    expect(body.folders[0]).toMatchObject({ id: 'tax', file_count: 2 });
    expect(typeof body.folders[0].last_organized_at).toBe('string');
    // Unreadable folders say so instead of claiming zero.
    expect(body.folders[1]).toMatchObject({
      id: 'gone',
      file_count: null,
      last_organized_at: null
    });
  });
});

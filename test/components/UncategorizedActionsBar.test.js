/**
 * The "Create folder for <theme>" offer counts files analyzed in earlier runs
 * too: three invoices from one vendor rarely arrive in the same batch.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';

jest.mock('../../src/shared/logger', () => {
  const logger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { logger, createLogger: jest.fn(() => logger) };
});
jest.mock('../../src/renderer/components/setup', () => ({
  AddSmartFolderModal: () => null
}));
jest.mock('../../src/renderer/services/ipc', () => ({ smartFoldersIpc: { add: jest.fn() } }));

import UncategorizedActionsBar from '../../src/renderer/components/organize/UncategorizedActionsBar';

const file = (name, keywords, dir = '/in') => ({
  path: `${dir}/${name}`,
  name,
  analysis: { category: 'Uncategorized', keywords }
});
const earlier = (name, tags, dir = '/Library/Uncategorized') => ({
  path: `${dir}/${name}`,
  name,
  analysis: { category: 'Uncategorized', tags }
});

function renderBar(unprocessedFiles, earlierItems, findSmartFolderForFile = () => null) {
  window.electronAPI = {
    analysisHistory: { getUncategorized: jest.fn().mockResolvedValue({ items: earlierItems }) }
  };
  return render(
    <UncategorizedActionsBar
      unprocessedFiles={unprocessedFiles}
      findSmartFolderForCategory={() => null}
      findSmartFolderForFile={findSmartFolderForFile}
    />
  );
}

describe('UncategorizedActionsBar', () => {
  test('one file on screen plus two analyzed earlier make a theme', async () => {
    renderBar(
      [file('acme-march.pdf', ['acme', 'invoice'])],
      [earlier('acme-jan.pdf', ['acme']), earlier('acme-feb.pdf', ['acme'])]
    );
    expect(await screen.findByText('Create folder for Acme')).toBeInTheDocument();
    expect(screen.getByText(/2 analyzed earlier/)).toBeInTheDocument();
    expect(screen.getByText('1 file is uncategorized')).toBeInTheDocument();
  });

  test('a file listed both on screen and in history counts once', async () => {
    const { container } = renderBar(
      [file('acme-march.pdf', ['acme']), file('acme-april.pdf', ['acme'])],
      [earlier('ACME-March.pdf', ['acme'], '\\in')]
    );
    await screen.findByText('2 files are uncategorized');
    await Promise.resolve();
    expect(container.textContent).not.toContain('Create folder for');
  });

  test('earlier files that a folder now matches no longer count', async () => {
    const acmeFolder = { name: 'Acme' };
    const { container } = renderBar(
      [file('acme-march.pdf', ['acme'])],
      [earlier('acme-jan.pdf', ['acme']), earlier('acme-feb.pdf', ['acme'])],
      (f) => (f.path.startsWith('/Library') ? acmeFolder : null)
    );
    await screen.findByText('1 file is uncategorized');
    await Promise.resolve();
    expect(container.textContent).not.toContain('Create folder for');
  });

  test('a theme made only of earlier files is not offered', async () => {
    const { container } = renderBar(
      [file('notes.txt', ['notes'])],
      [
        earlier('acme-jan.pdf', ['acme']),
        earlier('acme-feb.pdf', ['acme']),
        earlier('acme-mar.pdf', ['acme'])
      ]
    );
    await screen.findByText('1 file is uncategorized');
    await Promise.resolve();
    expect(container.textContent).not.toContain('Create folder for');
  });

  test('nothing uncategorized on screen, no bar', async () => {
    const { container } = renderBar([], [earlier('acme-jan.pdf', ['acme'])]);
    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
  });
});

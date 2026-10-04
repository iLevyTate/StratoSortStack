/**
 * @jest-environment jsdom
 */
import React from 'react';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverStub;
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { selectRedactPaths } from '../../src/renderer/store/selectors';

jest.mock('react-window', () => ({
  List: ({ rowCount, rowComponent: RowComponent, rowProps, style }) => (
    <div data-testid="virtual-list" style={style}>
      {Array.from({ length: rowCount }).map((_, index) => (
        <RowComponent key={index} index={index} style={{}} {...rowProps} />
      ))}
    </div>
  )
}));

jest.mock('../../src/renderer/store/selectors', () => ({
  selectRedactPaths: jest.fn(() => false)
}));

jest.mock('react-redux', () => ({
  useSelector: jest.fn((selector) => selector({}))
}));

jest.mock('../../src/renderer/hooks/useFileActions', () => ({
  useFileActions: () => ({
    openFile: jest.fn(),
    revealFile: jest.fn()
  })
}));

jest.mock('../../src/renderer/components/ui/FileIcon', () => ({
  __esModule: true,
  default: () => <span data-testid="file-icon" />
}));

jest.mock('../../src/renderer/components/ui/Modal', () => ({
  __esModule: true,
  default: ({ children, footer }) => (
    <div>
      {children}
      {footer}
    </div>
  )
}));

jest.mock('../../src/renderer/components/ui/Button', () => ({
  __esModule: true,
  default: ({ children }) => <button type="button">{children}</button>
}));

jest.mock('../../src/renderer/components/ui/Typography', () => ({
  Heading: ({ children }) => <h4>{children}</h4>,
  Text: ({ children, as: Comp = 'span', ...rest }) => {
    const Tag = Comp;
    return <Tag {...rest}>{children}</Tag>;
  }
}));

import DuplicateResolutionModal from '../../src/renderer/components/organize/DuplicateResolutionModal';

describe('DuplicateResolutionModal', () => {
  // Phase 1 reshaped the modal into three tier sections (exact / near-identical /
  // related). These tests use EXACT tier groups so the section is expanded by
  // default and members render; RELATED would start collapsed.
  const groups = [
    {
      id: 'exact-0',
      tier: 'exact',
      reason: 'sha256',
      averageSimilarity: 1,
      members: [
        {
          id: 'a',
          path: 'C:\\Users\\Alice\\Documents\\secret\\report.pdf',
          name: 'report.pdf',
          size: 1024
        },
        {
          id: 'b',
          path: 'C:\\Users\\Alice\\Downloads\\report.pdf',
          name: 'report.pdf',
          size: 1024
        }
      ]
    }
  ];

  test('shows full paths and names when redaction is off', () => {
    selectRedactPaths.mockReturnValue(false);

    render(
      <DuplicateResolutionModal
        isOpen
        onClose={jest.fn()}
        duplicateGroups={groups}
        onResolve={jest.fn()}
      />
    );

    // formatDisplayPath trims to the trailing 2 segments; the line also
    // appends " · <size>". Match by substring rather than full equality.
    expect(screen.getByText(/secret\\report\.pdf/)).toBeInTheDocument();
    expect(screen.getByText(/Downloads\\report\.pdf/)).toBeInTheDocument();
  });

  test('redacts displayed file names and paths when privacy redaction is enabled', () => {
    selectRedactPaths.mockReturnValue(true);

    render(
      <DuplicateResolutionModal
        isOpen
        onClose={jest.fn()}
        duplicateGroups={groups}
        onResolve={jest.fn()}
      />
    );

    expect(
      screen.queryByText('C:\\Users\\Alice\\Documents\\secret\\report.pdf')
    ).not.toBeInTheDocument();
    expect(screen.queryByText('C:\\Users\\Alice\\Downloads\\report.pdf')).not.toBeInTheDocument();
    expect(screen.queryByText('report.pdf')).not.toBeInTheDocument();
    expect(screen.getAllByText('Hidden file.pdf').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/…\\secret\\report\.pdf/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/…\\Downloads\\report\.pdf/).length).toBeGreaterThanOrEqual(1);
  });

  test('shows unavailable sizes instead of misleading zero-byte values', () => {
    selectRedactPaths.mockReturnValue(false);

    render(
      <DuplicateResolutionModal
        isOpen
        onClose={jest.fn()}
        duplicateGroups={[
          {
            id: 'exact-missing',
            tier: 'exact',
            reason: 'sha256',
            averageSimilarity: 1,
            members: [
              {
                id: 'missing-a',
                path: 'C:\\one.txt',
                name: 'one.txt'
              },
              {
                id: 'missing-b',
                path: 'C:\\two.txt',
                name: 'two.txt'
              }
            ]
          }
        ]}
        onResolve={jest.fn()}
      />
    );

    expect(screen.getByText('2 files • Size unavailable')).toBeInTheDocument();
    // Phase 1 footer copy replaces "Potential savings" with an action-focused
    // line; the "Size unavailable" label now appears both in the group header
    // and the footer savings summary, so allow >=1 occurrence.
    expect(screen.getAllByText(/Size unavailable/).length).toBeGreaterThanOrEqual(1);
  });
});

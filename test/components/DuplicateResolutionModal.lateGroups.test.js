/**
 * @jest-environment jsdom
 */
/**
 * The default keeper is pre-selected when the scan result arrives after the
 * dialog is already open.
 *
 * Every caller opens the dialog and starts the scan in the same handler, so
 * the first open render has no groups. Before the fix the defaults were set
 * only on the closed-to-open transition, so the groups that arrived a moment
 * later never got a keeper, and choices from an earlier session carried over.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverStub;

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
jest.mock('react-redux', () => ({ useSelector: jest.fn((selector) => selector({})) }));
jest.mock('../../src/renderer/hooks/useFileActions', () => ({
  useFileActions: () => ({ openFile: jest.fn(), revealFile: jest.fn() })
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
  default: ({ children, onClick, disabled }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  )
}));
jest.mock('../../src/renderer/components/ui/Typography', () => ({
  Heading: ({ children }) => <h4>{children}</h4>,
  Text: ({ children, as: Comp = 'span', ...rest }) => {
    const Tag = Comp;
    return <Tag {...rest}>{children}</Tag>;
  }
}));

import DuplicateResolutionModal from '../../src/renderer/components/organize/DuplicateResolutionModal';

const member = (p, mtime, size = 100) => ({
  id: p,
  path: p,
  name: p.split('/').pop(),
  size,
  mtime
});

const exactGroups = () => [
  {
    id: 'exact-0',
    tier: 'exact',
    reason: 'sha256',
    averageSimilarity: 1,
    members: [member('/old/one.pdf', 1000), member('/new/one.pdf', 2000)]
  }
];

function Harness({ isOpen, groups }) {
  return (
    <DuplicateResolutionModal
      isOpen={isOpen}
      onClose={jest.fn()}
      duplicateGroups={groups}
      onResolve={jest.fn()}
    />
  );
}

function keepRadios() {
  return screen.getAllByLabelText('Keep one.pdf');
}

describe('DuplicateResolutionModal: default keeper when groups arrive after open', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  test('pre-selects the newest exact copy once the scan result arrives', () => {
    const { rerender } = render(<Harness isOpen groups={[]} />);
    rerender(<Harness isOpen groups={exactGroups()} />);

    const [oldRadio, newRadio] = keepRadios();
    expect(newRadio).toBeChecked();
    expect(oldRadio).not.toBeChecked();
    expect(screen.getByText(/Send 1 to Trash/)).toBeInTheDocument();
  });

  test('a re-render with the same groups keeps the choice the user made', () => {
    const groups = exactGroups();
    const { rerender } = render(<Harness isOpen groups={groups} />);
    fireEvent.click(keepRadios()[0]);
    expect(keepRadios()[0]).toBeChecked();

    rerender(<Harness isOpen groups={groups} />);
    expect(keepRadios()[0]).toBeChecked();
  });

  test('choices from an earlier session do not carry into the next open', () => {
    const groups = exactGroups();
    const { rerender } = render(<Harness isOpen groups={groups} />);
    // The user switches the keeper to the older copy, then closes.
    fireEvent.click(keepRadios()[0]);
    rerender(<Harness isOpen={false} groups={groups} />);

    // Reopen: a rescan first clears the list, then returns the same sets.
    rerender(<Harness isOpen groups={[]} />);
    rerender(<Harness isOpen groups={exactGroups()} />);
    expect(keepRadios()[1]).toBeChecked();
    expect(keepRadios()[0]).not.toBeChecked();
  });

  test('reopening with the same groups and no rescan restores the defaults', () => {
    const groups = exactGroups();
    const { rerender } = render(<Harness isOpen groups={groups} />);
    fireEvent.click(keepRadios()[0]);
    rerender(<Harness isOpen={false} groups={groups} />);
    rerender(<Harness isOpen groups={groups} />);

    expect(keepRadios()[1]).toBeChecked();
    expect(keepRadios()[0]).not.toBeChecked();
  });

  test('closing keeps the footer count while the dialog animates out', () => {
    // The real Modal keeps its children mounted through the exit animation;
    // the mock above renders them regardless of isOpen.
    const groups = exactGroups();
    const { rerender } = render(<Harness isOpen groups={groups} />);
    expect(screen.getByText(/Send 1 to Trash/)).toBeInTheDocument();

    rerender(<Harness isOpen={false} groups={groups} />);
    expect(screen.getByText(/Send 1 to Trash/)).toBeInTheDocument();
  });
});

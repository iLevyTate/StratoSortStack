/**
 * @jest-environment jsdom
 */
/**
 * "Send to Trash" acts only on the sets the user can see, and "Keep all"
 * takes a set out of the list for good.
 *
 * Before: the resolve loop walked every group, so a related set hidden by
 * raising the slider (with a keeper already picked) was still trashed, and an
 * exact or near-identical set could not be skipped at all because each one
 * opens with a keeper pre-selected.
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

const member = (p, size = 100) => ({ id: p, path: p, name: p.split('/').pop(), size });

const exactGroup = {
  id: 'exact-0',
  tier: 'exact',
  reason: 'sha256',
  averageSimilarity: 1,
  members: [member('/a/one.pdf'), member('/b/one.pdf')]
};
const relatedGroup = {
  id: 'related-0',
  tier: 'related',
  averageSimilarity: 0.91,
  members: [member('/a/draft.docx'), member('/b/draft-v2.docx')]
};

function renderModal(groups, onResolve = jest.fn().mockResolvedValue(undefined)) {
  const utils = render(
    <DuplicateResolutionModal
      isOpen
      onClose={jest.fn()}
      duplicateGroups={groups}
      onResolve={onResolve}
    />
  );
  return { ...utils, onResolve };
}

describe('DuplicateResolutionModal: Keep all and visible-only resolve', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  test('Keep all on an exact set removes it from what Send to Trash acts on', async () => {
    const { onResolve } = renderModal([exactGroup]);
    expect(screen.getByText(/Send 1 to Trash/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('Keep all'));

    expect(screen.queryByText('Duplicate set 1')).not.toBeInTheDocument();
    expect(screen.getByText(/Send\s+to Trash/)).toBeDisabled();
    expect(onResolve).not.toHaveBeenCalled();
  });

  test('a kept set stays hidden when the modal opens again, and Restore brings it back', () => {
    const first = renderModal([exactGroup]);
    fireEvent.click(screen.getByText('Keep all'));
    first.unmount();

    renderModal([exactGroup]);
    expect(screen.queryByText('Duplicate set 1')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Show 1 kept'));
    expect(screen.getByText('Duplicate set 1')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Restore'));
    expect(screen.queryByText('Hide kept sets')).not.toBeInTheDocument();
    expect(screen.getByText('Duplicate set 1')).toBeInTheDocument();
    // Restored with no keeper: nothing is armed for Trash until one is picked.
    expect(screen.getByText(/Send\s+to Trash/)).toBeDisabled();
    fireEvent.click(screen.getAllByLabelText('Keep one.pdf')[0]);
    expect(screen.getByText(/Send 1 to Trash/)).toBeInTheDocument();

    // Keeping it again hides it again: the show toggle did not stick.
    fireEvent.click(screen.getByText('Keep all'));
    expect(screen.queryByText('Duplicate set 1')).not.toBeInTheDocument();
  });

  test('a set that gains a new copy is listed again', () => {
    const first = renderModal([exactGroup]);
    fireEvent.click(screen.getByText('Keep all'));
    first.unmount();

    renderModal([{ ...exactGroup, members: [...exactGroup.members, member('/c/one.pdf')] }]);
    expect(screen.getByText('Duplicate set 1')).toBeInTheDocument();
  });

  test('a related set hidden by the slider is not trashed even with a keeper picked', async () => {
    const { onResolve } = renderModal([exactGroup, relatedGroup]);
    // Related starts collapsed when it has groups? It is expanded only if listed.
    const relatedHeader = screen.getByText('Related');
    if (!screen.queryByRole('slider')) fireEvent.click(relatedHeader);

    // Pick a keeper in the related set (no default there).
    fireEvent.click(screen.getByText('draft.docx'));
    expect(screen.getByText(/Send 2 to Trash/)).toBeInTheDocument();

    // Raise the slider above the related set's similarity: it is hidden.
    fireEvent.change(screen.getByRole('slider'), { target: { value: '0.95' } });
    expect(screen.getByText(/Send 1 to Trash/)).toBeInTheDocument();

    fireEvent.click(screen.getByText(/Send 1 to Trash/));
    await Promise.resolve();
    expect(onResolve).toHaveBeenCalledTimes(1);
    const resolutions = onResolve.mock.calls[0][0];
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0].tier).toBe('exact');
  });

  test('a kept set shown through "Show N kept" marks nothing for Trash and cannot be edited', () => {
    const first = renderModal([exactGroup]);
    fireEvent.click(screen.getByText('Keep all'));
    first.unmount();

    renderModal([exactGroup]);
    fireEvent.click(screen.getByText('Show 1 kept'));

    expect(screen.getByText('Duplicate set 1')).toBeInTheDocument();
    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
    expect(screen.queryByText('Keep')).not.toBeInTheDocument();
    for (const radio of screen.getAllByRole('radio')) {
      expect(radio).toBeDisabled();
      expect(radio).not.toBeChecked();
    }
  });
});

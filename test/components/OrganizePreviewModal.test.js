/**
 * @jest-environment jsdom
 *
 * The Organize "Preview" shows where each file will go before anything
 * moves: files grouped by destination folder, the new name when the move
 * renames a file, folders the move will create, name clashes, and files
 * that will be skipped.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('../../src/renderer/components/ui/Modal', () => ({
  __esModule: true,
  default: ({ isOpen, title, description, children, footer }) =>
    isOpen ? (
      <div role="dialog">
        <h2>{title}</h2>
        <p>{description}</p>
        {children}
        {footer}
      </div>
    ) : null
}));

import OrganizePreviewModal from '../../src/renderer/components/organize/OrganizePreviewModal';

const plan = {
  wouldMove: [
    {
      source: 'C:\\Downloads\\Tiller Template (3).xlsx',
      destination: 'C:\\Docs\\Finance\\transaction-log.xlsx',
      collision: false
    },
    {
      source: 'C:\\Downloads\\report.md',
      destination: 'C:\\Docs\\Reports\\report-1.md',
      collision: true
    },
    {
      source: 'C:\\Downloads\\budget.xlsx',
      destination: 'C:\\Docs\\Finance\\budget.xlsx',
      collision: false
    }
  ],
  skipped: [{ source: 'C:\\Downloads\\gone.pdf', reason: 'source-missing' }],
  wouldCreateFolders: ['C:\\Docs\\Reports'],
  conflicts: 1
};

const renderModal = (props = {}) => {
  const onClose = jest.fn();
  const onConfirm = jest.fn();
  render(
    <OrganizePreviewModal
      isOpen
      plan={plan}
      onClose={onClose}
      onConfirm={onConfirm}
      redactPaths={false}
      {...props}
    />
  );
  return { onClose, onConfirm };
};

describe('OrganizePreviewModal', () => {
  test('groups files under the folder they will land in', () => {
    renderModal();

    expect(screen.getByText('3 files into 2 folders. Nothing has moved yet.')).toBeInTheDocument();
    const finance = screen.getByRole('region', { name: 'Destination C:\\Docs\\Finance' });
    expect(finance).toHaveTextContent('2 files');
    expect(finance).toHaveTextContent('budget.xlsx');
    expect(screen.getByRole('region', { name: 'Destination C:\\Docs\\Reports' })).toHaveTextContent(
      '1 file'
    );
  });

  test('shows the new name when the move renames a file', () => {
    renderModal();

    expect(screen.getByText('Tiller Template (3).xlsx')).toBeInTheDocument();
    expect(screen.getByText('transaction-log.xlsx')).toBeInTheDocument();
  });

  test('flags a new folder, a name clash and a skipped file', () => {
    renderModal();

    expect(screen.getByText('New folder')).toBeInTheDocument();
    expect(screen.getByText(/Name taken/)).toBeInTheDocument();
    expect(screen.getByText('1 file will not move')).toBeInTheDocument();
    expect(screen.getByText('File is no longer at its original location')).toBeInTheDocument();
  });

  describe('a file that is already in its destination folder', () => {
    const stayPlan = (destination, collision = false) => ({
      wouldMove: [{ source: 'C:\\Docs\\Finance\\budget.xlsx', destination, collision }],
      skipped: [],
      wouldCreateFolders: [],
      conflicts: collision ? 1 : 0
    });

    test('is marked as staying, with its new name', () => {
      renderModal({ plan: stayPlan('c:/docs/finance/Budget 2025.xlsx') });

      expect(screen.getByText('Already in this folder')).toBeInTheDocument();
      expect(screen.getByText('Budget 2025.xlsx')).toBeInTheDocument();
      expect(screen.queryByText(/Name taken/)).not.toBeInTheDocument();
    });

    test('is marked as unchanged when its name stays too', () => {
      renderModal({ plan: stayPlan('C:\\Docs\\Finance\\budget.xlsx') });

      expect(screen.getByText('Already here — no change')).toBeInTheDocument();
      expect(screen.queryByText('Already in this folder')).not.toBeInTheDocument();
    });

    test('keeps the name-taken mark when its new name belongs to another file', () => {
      renderModal({ plan: stayPlan('C:\\Docs\\Finance\\report_1.xlsx', true) });

      expect(screen.getByText('Already in this folder')).toBeInTheDocument();
      expect(screen.getByText(/Name taken/)).toBeInTheDocument();
    });

    test('a file arriving from another folder is not marked', () => {
      renderModal();

      expect(screen.queryByText(/^Already/)).not.toBeInTheDocument();
    });
  });

  test('the move button commits and reports the count', () => {
    const { onConfirm } = renderModal();

    fireEvent.click(screen.getByRole('button', { name: /Move 3 files/ }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  test('hides file names and folders when privacy redaction is on', () => {
    renderModal({ redactPaths: true });

    expect(screen.queryByText('transaction-log.xlsx')).not.toBeInTheDocument();
    expect(screen.queryByText('C:\\Docs\\Finance')).not.toBeInTheDocument();
    expect(screen.getAllByText('Hidden file.xlsx').length).toBeGreaterThan(0);
  });

  test('renders nothing when closed', () => {
    renderModal({ isOpen: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

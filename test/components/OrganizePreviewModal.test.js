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

  // Two files in one batch that end up with the same name in the same folder:
  // the move refuses to start, so the preview says so instead of offering it.
  describe('files this batch sends to one name', () => {
    const clashPlan = {
      wouldMove: [
        {
          source: 'C:\\Downloads\\scan 1.pdf',
          destination: 'C:\\Docs\\Finance\\invoice.pdf',
          collision: false
        },
        {
          source: 'C:\\Downloads\\scan 2.pdf',
          destination: 'C:\\Docs\\Finance\\invoice-1.pdf',
          collision: true
        },
        {
          source: 'C:\\Downloads\\budget.xlsx',
          destination: 'C:\\Docs\\Finance\\budget.xlsx',
          collision: false
        }
      ],
      skipped: [],
      wouldCreateFolders: [],
      conflicts: 1,
      sameDestination: [
        {
          destination: 'C:\\Docs\\Finance\\invoice.pdf',
          files: [
            { fileName: 'invoice.pdf', sourcePath: 'C:\\Downloads\\scan 1.pdf' },
            { fileName: 'invoice.pdf', sourcePath: 'C:\\Downloads\\scan 2.pdf' }
          ]
        }
      ]
    };

    test('are marked, with a notice that the move will not start', () => {
      renderModal({ plan: clashPlan });

      expect(screen.getByRole('alert')).toHaveTextContent(
        '2 files would get the same name in the same folder, so the move will not start.'
      );
      expect(screen.getAllByText('Same name as another file')).toHaveLength(2);
    });

    test('the move button is off until they are renamed', () => {
      const { onConfirm } = renderModal({ plan: clashPlan });

      const move = screen.getByRole('button', { name: /Move 3 files/ });
      expect(move).toBeDisabled();
      fireEvent.click(move);
      expect(onConfirm).not.toHaveBeenCalled();
    });

    test('a plan without any shows no notice', () => {
      renderModal({ plan: { ...clashPlan, sameDestination: [] } });

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.queryByText('Same name as another file')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Move 3 files/ })).toBeEnabled();
    });
  });

  test('says that no file will move when every file is skipped', () => {
    renderModal({
      plan: {
        wouldMove: [],
        skipped: [{ source: 'C:\\Downloads\\gone.pdf', reason: 'source-missing' }],
        wouldCreateFolders: [],
        conflicts: 0
      }
    });

    expect(screen.getByText('None of these files will move.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Move 0 files/ })).toBeDisabled();
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

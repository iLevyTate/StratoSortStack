/**
 * @jest-environment jsdom
 *
 * The notice that says, before a run, which files stay in the folder they
 * are in because that folder is also the smart folder chosen for them.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import InPlaceMoveNotice from '../../src/renderer/components/organize/InPlaceMoveNotice';

const move = (folderName, renamed = false) => ({
  sourcePath: `/in/${folderName}/file.csv`,
  fileName: 'file.csv',
  folderName,
  renamed
});

describe('InPlaceMoveNotice', () => {
  test('renders nothing when every file changes folder', () => {
    const { container, rerender } = render(<InPlaceMoveNotice moves={[]} />);
    expect(container).toBeEmptyDOMElement();

    rerender(<InPlaceMoveNotice moves={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  test('is standing advice, not an interruption', () => {
    render(<InPlaceMoveNotice moves={[move('Strato Input')]} />);

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('one file that keeps its name', () => {
    render(<InPlaceMoveNotice moves={[move('Strato Input')]} />);

    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('1 file is already in the folder chosen for it: Strato Input');
    expect(notice).toHaveTextContent('It will stay as it is.');
    expect(notice).toHaveTextContent('choose a different folder on its card');
  });

  test('one file that gets a new name', () => {
    render(<InPlaceMoveNotice moves={[move('Strato Input', true)]} />);

    expect(screen.getByRole('status')).toHaveTextContent(
      'It will be renamed there, not moved to another folder.'
    );
  });

  test('several files, all renamed', () => {
    render(<InPlaceMoveNotice moves={[move('Strato Input', true), move('Strato Input', true)]} />);

    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent(
      '2 files are already in the folder chosen for them: Strato Input'
    );
    expect(notice).toHaveTextContent('They will be renamed there, not moved to another folder.');
  });

  test('several files, none renamed', () => {
    render(<InPlaceMoveNotice moves={[move('Strato Input'), move('Strato Input')]} />);

    expect(screen.getByRole('status')).toHaveTextContent('They will stay as they are.');
  });

  test('a mix of renamed and unchanged files', () => {
    render(<InPlaceMoveNotice moves={[move('Strato Input', true), move('Strato Input')]} />);

    expect(screen.getByRole('status')).toHaveTextContent(
      'They will stay where they are, and the ones with a new name are renamed there.'
    );
  });

  test('names each folder once, and counts the ones it does not show', () => {
    const { rerender } = render(
      <InPlaceMoveNotice moves={[move('Strato Input'), move('Bing data'), move('Bing data')]} />
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      '3 files are already in the folder chosen for them: Strato Input and Bing data'
    );

    rerender(
      <InPlaceMoveNotice
        moves={[move('Strato Input'), move('Bing data'), move('GSC data'), move('Reports')]}
      />
    );
    expect(screen.getByRole('status')).toHaveTextContent(': Strato Input, Bing data and 2 more');
  });

  test('passes its class to the box', () => {
    render(<InPlaceMoveNotice moves={[move('Strato Input')]} className="mb-4" />);

    expect(screen.getByRole('status')).toHaveClass('mb-4');
  });
});

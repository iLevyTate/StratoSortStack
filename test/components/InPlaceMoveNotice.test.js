/**
 * @jest-environment jsdom
 *
 * The notice that says, before a run, which files stay in the folder they
 * are in because that folder is also the smart folder chosen for them.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
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

describe('InPlaceMoveNotice: the choice before Move', () => {
  const chosen = (folderName, choice, renamed = false) => ({
    ...move(folderName, renamed),
    choice
  });

  test('asks to leave the files there or skip them, and says Move waits for it', () => {
    const onChoose = jest.fn();
    const moves = [chosen('Strato Input', null), chosen('Strato Input', null)];
    render(<InPlaceMoveNotice moves={moves} onChoose={onChoose} />);

    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('Move stays off until you choose.');
    expect(notice).toHaveTextContent('StratoSort keeps your choice for each folder.');

    fireEvent.click(screen.getByRole('button', { name: 'Skip them' }));
    expect(onChoose).toHaveBeenCalledWith('skip', moves);
    fireEvent.click(screen.getByRole('button', { name: 'Leave them there' }));
    expect(onChoose).toHaveBeenCalledWith('leave', moves);
  });

  test('asks only about the files with no choice yet', () => {
    const onChoose = jest.fn();
    const open = chosen('Bing data', null);
    render(
      <InPlaceMoveNotice moves={[chosen('Strato Input', 'skip'), open]} onChoose={onChoose} />
    );

    expect(screen.getByRole('status')).toHaveTextContent(
      '1 file is already in the folder chosen for it: Bing data'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Leave it there' }));
    expect(onChoose).toHaveBeenCalledWith('leave', [open]);
  });

  test('once chosen, says what will happen and offers to change it', () => {
    const onChoose = jest.fn();
    const moves = [chosen('Strato Input', 'skip')];
    render(<InPlaceMoveNotice moves={moves} onChoose={onChoose} />);

    expect(screen.getByRole('status')).toHaveTextContent('It will be skipped and keep its name.');
    expect(screen.queryByRole('button', { name: 'Skip it' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Change this choice' }));
    expect(onChoose).toHaveBeenCalledWith(null, moves);
  });

  test('files left there are described as before, and a mix is counted', () => {
    const { rerender } = render(
      <InPlaceMoveNotice moves={[chosen('Strato Input', 'leave', true)]} onChoose={jest.fn()} />
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'It will be renamed there, not moved to another folder.'
    );

    rerender(
      <InPlaceMoveNotice
        moves={[chosen('Strato Input', 'leave'), chosen('Bing data', 'skip')]}
        onChoose={jest.fn()}
      />
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      '1 will stay where it is, and 1 will be skipped.'
    );
  });
});

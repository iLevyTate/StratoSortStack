/**
 * @jest-environment jsdom
 *
 * The stale-result notice in Organize: files whose folder still comes from
 * Smart Folder definitions that changed, with one click to analyze them
 * again. While the re-rank with the new folders runs, it says so instead.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import StaleSuggestionsNotice from '../../src/renderer/components/organize/StaleSuggestionsNotice';

describe('StaleSuggestionsNotice', () => {
  test('nothing to say with no stale files', () => {
    const { container } = render(<StaleSuggestionsNotice count={0} onRefresh={jest.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  test('names the files and refreshes them in one click', () => {
    const onRefresh = jest.fn();
    render(<StaleSuggestionsNotice count={3} onRefresh={onRefresh} />);
    expect(
      screen.getByText('Your Smart Folders changed after these files were analyzed')
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        '3 files still go where your old Smart Folders sent them. Analyze them again to sort them with the current folders.'
      )
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Analyze 3 again' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  test('while the re-rank runs it says so and offers no button yet', () => {
    render(<StaleSuggestionsNotice count={3} isRanking onRefresh={jest.fn()} />);
    expect(
      screen.getByText('Checking 3 files against your current Smart Folders.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  test('the refresh waits while another analysis runs', () => {
    render(<StaleSuggestionsNotice count={1} isAnalyzing onRefresh={jest.fn()} />);
    expect(screen.getByRole('button', { name: 'Analyze 1 again' })).toBeDisabled();
  });
});

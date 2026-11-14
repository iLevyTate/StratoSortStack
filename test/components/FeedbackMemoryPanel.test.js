import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockElectronAPI = {
  suggestions: {
    getFeedbackMemory: jest.fn(),
    addFeedbackMemory: jest.fn(),
    updateFeedbackMemory: jest.fn(),
    deleteFeedbackMemory: jest.fn()
  }
};

beforeAll(() => {
  Object.defineProperty(window, 'electronAPI', {
    value: mockElectronAPI,
    configurable: true
  });
});

import FeedbackMemoryPanel from '../../src/renderer/components/organize/FeedbackMemoryPanel';

describe('FeedbackMemoryPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockElectronAPI.suggestions.getFeedbackMemory.mockResolvedValue({
      success: true,
      items: [{ id: 'mem-1', text: 'All .stl files go to 3D Prints' }]
    });
    mockElectronAPI.suggestions.updateFeedbackMemory.mockResolvedValue({
      success: true,
      item: { id: 'mem-1', text: 'All .stl files go to CAD' }
    });
  });

  test('shows what a folder description used to say', async () => {
    mockElectronAPI.suggestions.getFeedbackMemory.mockResolvedValue({
      success: true,
      items: [
        {
          id: 'mem-2',
          text: '"Finance" is for: Invoices and bank statements',
          targetFolder: 'Finance',
          history: [{ description: 'Money things', changedAt: '2026-11-01T12:00:00.000Z' }]
        }
      ]
    });
    render(<FeedbackMemoryPanel refreshToken={0} />);
    expect(await screen.findByText(/Money things/)).toBeInTheDocument();
    expect(screen.getByText('Target: Finance')).toBeInTheDocument();
  });

  test('loads and updates a memory entry', async () => {
    render(<FeedbackMemoryPanel refreshToken={0} />);

    await waitFor(() => {
      expect(screen.getByText('All .stl files go to 3D Prints')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Edit'));
    const textarea = screen.getByDisplayValue('All .stl files go to 3D Prints');
    fireEvent.change(textarea, { target: { value: 'All .stl files go to CAD' } });

    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(mockElectronAPI.suggestions.updateFeedbackMemory).toHaveBeenCalledWith(
        'mem-1',
        'All .stl files go to CAD'
      );
    });

    await waitFor(() => {
      expect(screen.getByText('All .stl files go to CAD')).toBeInTheDocument();
    });
  });

  test('says what a rule does without promising more', async () => {
    render(<FeedbackMemoryPanel refreshToken={0} />);
    expect(
      await screen.findByText(
        /moves that folder up for files of that type when it is already one of the folders StratoSort considers for them/
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/applies to every file/)).not.toBeInTheDocument();
    expect(screen.queryByText(/follow these/)).not.toBeInTheDocument();
  });
});

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
});

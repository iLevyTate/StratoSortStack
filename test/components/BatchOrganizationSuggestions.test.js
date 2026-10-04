import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

jest.mock('../../src/renderer/contexts/NotificationContext', () => ({
  useNotification: () => ({
    addNotification: jest.fn()
  })
}));

const mockElectronAPI = {
  suggestions: {
    addFeedbackMemory: jest.fn()
  }
};

beforeAll(() => {
  Object.defineProperty(window, 'electronAPI', {
    value: mockElectronAPI,
    configurable: true
  });
});

import BatchOrganizationSuggestions from '../../src/renderer/components/organize/BatchOrganizationSuggestions';

describe('BatchOrganizationSuggestions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockElectronAPI.suggestions.addFeedbackMemory.mockResolvedValue({ success: true });
  });

  test('saves batch feedback memory', async () => {
    const batchSuggestions = {
      groups: [
        {
          folder: 'Docs',
          files: [{ name: 'test.pdf' }],
          confidence: 0.8
        }
      ]
    };

    render(
      <BatchOrganizationSuggestions
        batchSuggestions={batchSuggestions}
        onAcceptStrategy={jest.fn()}
        onCustomizeGroup={jest.fn()}
        onRejectAll={jest.fn()}
      />
    );

    const textarea = screen.getByPlaceholderText('e.g., "All 3D files go to 3D Prints"');
    fireEvent.change(textarea, { target: { value: 'All .stl files go to 3D Prints' } });

    fireEvent.click(screen.getByText('Save memory'));

    await waitFor(() => {
      expect(mockElectronAPI.suggestions.addFeedbackMemory).toHaveBeenCalledWith(
        'All .stl files go to 3D Prints'
      );
    });
  });

  test('preview overlay is a labeled modal dialog; Escape closes it (U-011)', () => {
    const batchSuggestions = {
      groups: [
        {
          folder: 'Docs',
          files: [{ name: 'test.pdf' }],
          confidence: 0.8
        }
      ]
    };

    render(
      <BatchOrganizationSuggestions
        batchSuggestions={batchSuggestions}
        onAcceptStrategy={jest.fn()}
        onCustomizeGroup={jest.fn()}
        onRejectAll={jest.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /preview changes/i }));

    const dialog = screen.getByRole('dialog', { name: 'Preview organization changes' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

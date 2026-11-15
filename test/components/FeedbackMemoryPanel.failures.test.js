/**
 * @jest-environment jsdom
 */
/**
 * Memory & Rules panel handling of failed IPC calls.
 *
 * The suggestions handlers resolve `{ success: false, error }` instead of
 * throwing (validation failure, service unavailable, store error). Before the
 * fix a failed edit closed the editor and threw the text away, a failed delete
 * still removed the row, and a rejected invoke became an unhandled rejection.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockSuggestions = {
  getFeedbackMemory: jest.fn(),
  addFeedbackMemory: jest.fn(),
  updateFeedbackMemory: jest.fn(),
  deleteFeedbackMemory: jest.fn()
};

beforeAll(() => {
  Object.defineProperty(window, 'electronAPI', {
    value: { suggestions: mockSuggestions },
    configurable: true
  });
});

import FeedbackMemoryPanel from '../../src/renderer/components/organize/FeedbackMemoryPanel';

const ENTRY = { id: 'mem-1', text: 'All .stl files go to 3D Prints' };

async function renderLoaded() {
  render(<FeedbackMemoryPanel refreshToken={0} />);
  await screen.findByText(ENTRY.text);
}

async function editTo(value) {
  fireEvent.click(screen.getByText('Edit'));
  fireEvent.change(screen.getByDisplayValue(ENTRY.text), { target: { value } });
  fireEvent.click(screen.getByText('Save'));
}

describe('FeedbackMemoryPanel failure handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSuggestions.getFeedbackMemory.mockResolvedValue({ success: true, items: [ENTRY] });
  });

  test('a rejected update keeps the editor open with the text and shows the error', async () => {
    mockSuggestions.updateFeedbackMemory.mockResolvedValue({
      success: false,
      error: { code: 'STORE_ERROR', message: 'Disk is full' }
    });
    await renderLoaded();
    await editTo('All .stl files go to CAD');

    expect(await screen.findByRole('alert')).toHaveTextContent('Disk is full');
    expect(screen.getByDisplayValue('All .stl files go to CAD')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  test('a validation failure on the text shows a length hint', async () => {
    // The real reply for a Zod failure, as built by createHandler in
    // ipcWrappers.js through createErrorResponse in errorHandlingUtils.js.
    const { createErrorResponse } = require('../../src/shared/errorHandlingUtils');
    const { z } = require('zod');
    const parsed = z
      .object({ text: z.string().min(2).max(500) })
      .safeParse({ text: 'x'.repeat(501) });
    mockSuggestions.updateFeedbackMemory.mockResolvedValue(
      createErrorResponse(
        { message: 'Invalid input', name: 'ValidationError' },
        { validationErrors: parsed.error.flatten() }
      )
    );
    await renderLoaded();
    await editTo('All .stl files go to CAD');

    expect(await screen.findByRole('alert')).toHaveTextContent('2-500 characters');
    expect(screen.getByDisplayValue('All .stl files go to CAD')).toBeInTheDocument();
  });

  test('a validation failure on another field keeps the plain message', async () => {
    mockSuggestions.updateFeedbackMemory.mockResolvedValue({
      success: false,
      error: {
        code: 'UNKNOWN_ERROR',
        message: 'Invalid input',
        details: {
          errorType: 'ValidationError',
          validationErrors: { formErrors: [], fieldErrors: { id: ['Required'] } }
        }
      }
    });
    await renderLoaded();
    await editTo('All .stl files go to CAD');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Invalid input');
    expect(alert).not.toHaveTextContent('2-500 characters');
  });

  test('an invoke that throws is caught and shown, not left unhandled', async () => {
    mockSuggestions.updateFeedbackMemory.mockRejectedValue(new Error('IPC timed out'));
    await renderLoaded();
    await editTo('All .stl files go to CAD');

    expect(await screen.findByRole('alert')).toHaveTextContent('IPC timed out');
    expect(screen.getByDisplayValue('All .stl files go to CAD')).toBeInTheDocument();
  });

  test('a failed delete leaves the row in place', async () => {
    mockSuggestions.deleteFeedbackMemory.mockResolvedValue({
      success: false,
      error: 'Suggestion service unavailable'
    });
    await renderLoaded();
    fireEvent.click(screen.getByLabelText('Delete memory'));

    expect(await screen.findByRole('alert')).toHaveTextContent('Suggestion service unavailable');
    expect(screen.getByText(ENTRY.text)).toBeInTheDocument();
  });

  test('a successful delete removes the row', async () => {
    mockSuggestions.deleteFeedbackMemory.mockResolvedValue({ success: true, removed: true });
    await renderLoaded();
    fireEvent.click(screen.getByLabelText('Delete memory'));

    await waitFor(() => expect(screen.queryByText(ENTRY.text)).not.toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('a failed add keeps the typed text and shows the error', async () => {
    mockSuggestions.addFeedbackMemory.mockRejectedValue(new Error('IPC timed out'));
    await renderLoaded();
    const input = screen.getByPlaceholderText(/All \.stl files go to 3D Prints/);
    fireEvent.change(input, { target: { value: 'PDFs go to Documents' } });
    fireEvent.click(screen.getByText('Save memory'));

    expect(await screen.findByRole('alert')).toHaveTextContent('IPC timed out');
    expect(input).toHaveValue('PDFs go to Documents');
  });

  test('inputs match the 2-500 character schema', async () => {
    await renderLoaded();
    const input = screen.getByPlaceholderText(/All \.stl files go to 3D Prints/);
    expect(input).toHaveAttribute('maxLength', '500');
    fireEvent.change(input, { target: { value: 'a' } });
    expect(screen.getByRole('button', { name: 'Save memory' })).toBeDisabled();

    fireEvent.click(screen.getByText('Edit'));
    const editor = screen.getByDisplayValue(ENTRY.text);
    expect(editor).toHaveAttribute('maxLength', '500');
    fireEvent.change(editor, { target: { value: 'x' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});

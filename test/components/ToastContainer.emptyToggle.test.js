/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { ToastContainer } from '../../src/renderer/components/Toast';

describe('ToastContainer collapse toggle', () => {
  test('is not drawn when there are no notifications', () => {
    // It floated alone over the top-right corner of every screen.
    render(<ToastContainer toasts={[]} onRemoveToast={jest.fn()} />);
    expect(screen.queryByRole('button', { name: /notification list/i })).toBeNull();
  });

  test('is drawn once a notification is showing', () => {
    render(
      <ToastContainer
        toasts={[{ id: 't1', message: 'Saved', severity: 'success' }]}
        onRemoveToast={jest.fn()}
      />
    );
    expect(screen.getByRole('button', { name: /notification list/i })).toBeInTheDocument();
  });
});

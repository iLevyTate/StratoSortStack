/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ToastContainer } from '../../src/renderer/components/Toast';

describe('ToastContainer positioning', () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  test('keeps top-right notifications below the fixed header controls', () => {
    window.localStorage.setItem('toastPosition', 'top-right');

    render(<ToastContainer toasts={[]} onRemoveToast={jest.fn()} />);

    const notifications = screen.getByLabelText('Notifications');
    expect(notifications).toHaveStyle({
      top: 'var(--toast-top-offset, calc(var(--app-nav-height) + 16px))',
      right: '16px'
    });
  });
});

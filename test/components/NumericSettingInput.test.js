/**
 * @jest-environment jsdom
 *
 * Live numeric validation in settings.
 *
 * These tests pin down the user-visible behaviour contract for
 * `NumericSettingInput`: invalid keystrokes must surface a role="alert"
 * inline message (WCAG 3.3.1) instead of being silently dropped, and valid
 * input must commit upstream without waiting for a save button.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('../../src/renderer/components/ui/Label', () => ({
  __esModule: true,
  default: ({ children }) => <span>{children}</span>
}));

import NumericSettingInput from '../../src/renderer/components/settings/NumericSettingInput';

function Harness({ initial = 5, ...props }) {
  const [value, setValue] = React.useState(initial);
  return (
    <NumericSettingInput
      value={value}
      onCommit={(next) => {
        setValue(next);
        props.onCommit?.(next);
      }}
      {...props}
    />
  );
}

describe('NumericSettingInput', () => {
  test('commits a valid in-range value immediately', () => {
    const onCommit = jest.fn();
    render(<Harness initial={5} min={1} max={10} onCommit={onCommit} />);

    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '7' } });

    expect(onCommit).toHaveBeenCalledWith(7);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('shows an inline role="alert" error when the value exceeds max', () => {
    const onCommit = jest.fn();
    render(<Harness initial={5} min={1} max={10} onCommit={onCommit} />);

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '99' } });

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/at most 10/i);
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole('spinbutton')).toHaveAttribute('aria-invalid', 'true');
  });

  test('shows an inline role="alert" error when the value is below min', () => {
    const onCommit = jest.fn();
    render(<Harness initial={5} min={1} max={10} onCommit={onCommit} />);

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '0' } });

    expect(screen.getByRole('alert')).toHaveTextContent(/at least 1/i);
    expect(onCommit).not.toHaveBeenCalled();
  });

  test('shows an inline error for empty input and does not clobber upstream', () => {
    const onCommit = jest.fn();
    render(<Harness initial={5} min={1} max={10} onCommit={onCommit} />);

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '' } });

    expect(screen.getByRole('alert')).toHaveTextContent(/enter a number/i);
    expect(onCommit).not.toHaveBeenCalled();
  });

  test('shows an inline error for non-integer input when integer=true', () => {
    const onCommit = jest.fn();
    render(<Harness initial={5} min={0} max={10} integer onCommit={onCommit} />);

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '3.5' } });

    expect(screen.getByRole('alert')).toHaveTextContent(/whole number/i);
    expect(onCommit).not.toHaveBeenCalled();
  });

  test('recovers to the last committed value and clears the error on blur', () => {
    const onCommit = jest.fn();
    render(<Harness initial={5} min={1} max={10} onCommit={onCommit} />);

    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '999' } });
    expect(screen.getByRole('alert')).toBeInTheDocument();

    fireEvent.blur(input);

    expect(screen.queryByRole('alert')).toBeNull();
    expect(input).toHaveValue(5);
    expect(input).toHaveAttribute('aria-invalid', 'false');
  });

  test('wires aria-describedby to the error node while invalid', () => {
    render(<Harness initial={5} min={1} max={10} />);

    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '200' } });

    const alert = screen.getByRole('alert');
    expect(input.getAttribute('aria-describedby')).toBe(alert.id);
    expect(alert.id).toBeTruthy();
  });
});

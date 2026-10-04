import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import Input from '../ui/Input';

/**
 * Numeric settings input with live, field-level validation.
 *
 * Purpose
 * -------
 * Other settings sections previously called `parseInt` inline and either
 * dropped invalid input on the floor (e.g. `if (Number.isFinite(next)) ...`)
 * or silently clamped it. Both violate WCAG 3.3.1 (Error Identification) and
 * leave power users wondering whether their value was accepted.
 *
 * This component keeps the visible string while the user types, shows an
 * inline `role="alert"` message for empty / non-numeric / out-of-range /
 * non-integer inputs, and only commits a canonical numeric value upstream
 * when the input parses cleanly. When the field blurs while invalid, it
 * snaps back to the last committed value so the UI never persists junk.
 */
function NumericSettingInput({
  value,
  onCommit,
  min,
  max,
  integer = true,
  className = '',
  ariaLabel,
  id: idProp,
  fallback = null,
  formatValue = (v) => (v === null || v === undefined || Number.isNaN(v) ? '' : String(v)),
  parseValue = (str) => (str.trim() === '' ? NaN : Number(str)),
  ...inputProps
}) {
  const generatedId = useId();
  const id = idProp || `numeric-setting-${generatedId}`;
  const errorId = `${id}-error`;

  // Stable refs for the format/parse callbacks so consumers can inline them
  // (e.g. `formatValue={(v) => ...}`) without our sync effect re-running on
  // every parent render and clobbering the user's in-flight edit.
  const formatRef = useRef(formatValue);
  formatRef.current = formatValue;
  const parseRef = useRef(parseValue);
  parseRef.current = parseValue;

  const [draft, setDraft] = useState(() => formatRef.current(value));
  const [error, setError] = useState('');
  // Track whether the field is focused so we do not overwrite the user's
  // in-flight edit when the parent re-renders (e.g. from an async settings
  // sync). The clamped upstream value would otherwise clobber keystrokes.
  const focusedRef = useRef(false);

  useEffect(() => {
    if (focusedRef.current) return;
    setDraft(formatRef.current(value));
    setError('');
  }, [value]);

  const validate = useCallback(
    (raw) => {
      if (raw.trim() === '') {
        return 'Enter a number.';
      }
      const parsed = parseRef.current(raw);
      if (!Number.isFinite(parsed)) {
        return 'Enter a valid number.';
      }
      if (integer && !Number.isInteger(parsed)) {
        return 'Enter a whole number.';
      }
      if (Number.isFinite(min) && parsed < min) {
        return `Must be at least ${min}.`;
      }
      if (Number.isFinite(max) && parsed > max) {
        return `Must be at most ${max}.`;
      }
      return '';
    },
    [integer, max, min]
  );

  const handleChange = useCallback(
    (event) => {
      const raw = event.target.value;
      setDraft(raw);
      const message = validate(raw);
      setError(message);
      if (!message) {
        onCommit(parseRef.current(raw));
      }
    },
    [onCommit, validate]
  );

  const handleFocus = useCallback(
    (event) => {
      focusedRef.current = true;
      if (inputProps.onFocus) inputProps.onFocus(event);
    },
    [inputProps]
  );

  const handleBlur = useCallback(
    (event) => {
      focusedRef.current = false;
      if (error) {
        const recovery = Number.isFinite(value)
          ? value
          : Number.isFinite(fallback)
            ? fallback
            : null;
        setDraft(formatRef.current(recovery));
        setError('');
      }
      if (inputProps.onBlur) inputProps.onBlur(event);
    },
    [error, fallback, inputProps, value]
  );

  return (
    <div className="flex flex-col gap-1.5">
      <Input
        {...inputProps}
        id={id}
        type="number"
        inputMode={integer ? 'numeric' : 'decimal'}
        min={min}
        max={max}
        step={inputProps.step ?? (integer ? 1 : 'any')}
        value={draft}
        aria-label={ariaLabel}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        className={className}
        onChange={handleChange}
        onFocus={handleFocus}
        onBlur={handleBlur}
      />
      {error && (
        <p id={errorId} role="alert" aria-live="polite" className="text-sm text-stratosort-danger">
          {error}
        </p>
      )}
    </div>
  );
}

NumericSettingInput.propTypes = {
  value: PropTypes.number,
  onCommit: PropTypes.func.isRequired,
  min: PropTypes.number,
  max: PropTypes.number,
  integer: PropTypes.bool,
  className: PropTypes.string,
  ariaLabel: PropTypes.string,
  id: PropTypes.string,
  fallback: PropTypes.number,
  formatValue: PropTypes.func,
  parseValue: PropTypes.func
};

export default NumericSettingInput;

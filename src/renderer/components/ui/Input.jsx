import React, { useId, useMemo, memo, useRef, useCallback } from 'react';
import PropTypes from 'prop-types';
import { ChevronDown, ChevronUp } from 'lucide-react';
import Label from './Label';

function parseStep(step) {
  if (step === undefined || step === 'any') return 1;
  const parsed = Number(step);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function parseBound(value) {
  if (value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const WIDTH_CLASS_PATTERN = /\b(?:w|min-w|max-w)-[^\s]+/g;

function extractWidthClasses(className) {
  const widths = className.match(WIDTH_CLASS_PATTERN);
  return widths ? widths.join(' ') : 'w-full';
}

function stripWidthClasses(className) {
  return className.replace(WIDTH_CLASS_PATTERN, '').trim();
}

function NumberInputField({
  inputRef,
  fieldClasses,
  inputClassName,
  wrapClassName,
  bump,
  rest,
  stepperDisabled
}) {
  return (
    <div className={`number-input-wrap ${wrapClassName}`.trim()}>
      <input
        ref={inputRef}
        className={`${fieldClasses} ${inputClassName} number-input-field`.trim()}
        {...rest}
      />
      <div className="number-input-steppers" aria-hidden="true">
        <button
          type="button"
          tabIndex={-1}
          className="number-input-stepper-btn"
          disabled={stepperDisabled.up}
          onClick={() => bump(1)}
        >
          <ChevronUp className="h-3 w-3" strokeWidth={2.5} />
        </button>
        <button
          type="button"
          tabIndex={-1}
          className="number-input-stepper-btn"
          disabled={stepperDisabled.down}
          onClick={() => bump(-1)}
        >
          <ChevronDown className="h-3 w-3" strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
}

NumberInputField.propTypes = {
  inputRef: PropTypes.oneOfType([PropTypes.func, PropTypes.shape({ current: PropTypes.any })]),
  fieldClasses: PropTypes.string.isRequired,
  inputClassName: PropTypes.string,
  wrapClassName: PropTypes.string.isRequired,
  bump: PropTypes.func.isRequired,
  rest: PropTypes.object.isRequired,
  stepperDisabled: PropTypes.shape({
    up: PropTypes.bool,
    down: PropTypes.bool
  }).isRequired
};

const Input = memo(function Input({
  className = '',
  invalid = false,
  error = '',
  label = '',
  required = false,
  ref,
  ...rest
}) {
  const generatedId = useId();
  const id = rest.id || `input-${generatedId}`;
  const errorId = `${id}-error`;
  const innerRef = useRef(null);
  const isNumber = rest.type === 'number';

  const invalidClass =
    invalid || error ? 'border-stratosort-danger focus:ring-stratosort-danger/20' : '';

  const fieldClasses = useMemo(() => {
    return `form-input-enhanced ${invalidClass}`.trim();
  }, [invalidClass]);

  const classes = useMemo(() => {
    return `${fieldClasses} ${className}`.trim();
  }, [className, fieldClasses]);

  const numberWrapClassName = extractWidthClasses(className);
  const numberInputClassName = stripWidthClasses(className);

  const setInputRef = useCallback(
    (node) => {
      innerRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    },
    [ref]
  );

  const step = parseStep(rest.step);
  const min = parseBound(rest.min);
  const max = parseBound(rest.max);

  const { onChange, disabled, readOnly, value } = rest;

  const stepperDisabled = useMemo(() => {
    if (disabled || readOnly) {
      return { up: true, down: true };
    }
    const current = value === '' || value === undefined ? null : Number(value);
    if (current === null || !Number.isFinite(current)) {
      return { up: false, down: false };
    }
    return {
      up: max !== null && current + step > max,
      down: min !== null && current - step < min
    };
  }, [disabled, max, min, readOnly, step, value]);

  const bump = useCallback(
    (direction) => {
      const el = innerRef.current;
      if (!el || disabled || readOnly) return;

      const raw = el.value;
      const current = raw === '' ? 0 : Number(raw);
      if (!Number.isFinite(current)) return;

      let next = direction > 0 ? current + step : current - step;
      if (min !== null) next = Math.max(min, next);
      if (max !== null) next = Math.min(max, next);

      const usesIntegerStep = Number.isInteger(step) && !String(step).includes('.');
      const nextValue = usesIntegerStep ? String(Math.round(next)) : String(next);

      el.value = nextValue;
      onChange?.({
        target: el,
        currentTarget: el
      });
    },
    [disabled, max, min, onChange, readOnly, step]
  );

  const renderInput = (inputProps) => {
    if (isNumber) {
      return (
        <NumberInputField
          inputRef={setInputRef}
          fieldClasses={fieldClasses}
          inputClassName={numberInputClassName}
          wrapClassName={numberWrapClassName}
          bump={bump}
          rest={inputProps}
          stepperDisabled={stepperDisabled}
        />
      );
    }

    return <input ref={setInputRef} className={classes} {...inputProps} />;
  };

  if (!label && !error) {
    const hasAccessibleName =
      typeof rest['aria-label'] === 'string'
        ? rest['aria-label'].trim().length > 0
        : typeof rest['aria-labelledby'] === 'string' && rest['aria-labelledby'].trim().length > 0;

    if (!hasAccessibleName && process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.warn(
        '[Input] Standalone <Input> rendered without label, aria-label, or aria-labelledby. ' +
          'Screen readers will announce this field as unnamed. ' +
          'Provide one of { label, aria-label, aria-labelledby }.',
        { placeholder: rest.placeholder, name: rest.name, type: rest.type }
      );
    }

    const fallbackAriaLabel = hasAccessibleName
      ? rest['aria-label']
      : rest['aria-label'] ||
        (typeof rest.placeholder === 'string' && rest.placeholder.trim().length > 0
          ? rest.placeholder
          : rest.name || 'Input');

    return renderInput({
      ...rest,
      'aria-invalid':
        invalid || !!error || rest['aria-invalid'] === true || rest['aria-invalid'] === 'true',
      'aria-required': required,
      'aria-label': fallbackAriaLabel
    });
  }

  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <Label htmlFor={id} required={required}>
          {label}
        </Label>
      )}
      {renderInput({
        ...rest,
        id,
        'aria-invalid':
          invalid || !!error || rest['aria-invalid'] === true || rest['aria-invalid'] === 'true',
        'aria-describedby': error ? errorId : undefined,
        'aria-required': required
      })}
      {error && (
        <p id={errorId} className="text-sm text-stratosort-danger mt-0.5" role="alert">
          {error}
        </p>
      )}
    </div>
  );
});

Input.propTypes = {
  className: PropTypes.string,
  invalid: PropTypes.bool,
  error: PropTypes.string,
  label: PropTypes.string,
  required: PropTypes.bool
};

export default Input;

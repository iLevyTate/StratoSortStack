import React, {
  useId,
  useMemo,
  memo,
  useState,
  useEffect,
  useRef,
  useCallback,
  useLayoutEffect
} from 'react';
import PropTypes from 'prop-types';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import Label from './Label';

const Select = memo(function Select({
  className = '',
  invalid = false,
  error = '',
  label = '',
  required = false,
  children,
  ref,
  ...rest
}) {
  // Always call useId unconditionally to follow React hooks rules
  const generatedId = useId();
  const id = rest.id || `select-${generatedId}`;
  const labelId = label ? `${id}-label` : undefined;
  const errorId = `${id}-error`;
  const listboxId = `${id}-listbox`;
  // Per-option IDs are stable across renders because they're derived from the
  // trigger ID plus the option index. This lets us wire aria-activedescendant
  // on the trigger without giving each option its own ref.
  const getOptionId = (index) => `${id}-option-${index}`;

  // Extract options from children once for rendering and keyboard nav.
  // Supports both flat <option> children and nested <optgroup> wrappers.
  const options = useMemo(() => {
    const extracted = [];

    const pushOption = (child, groupLabel = null) => {
      if (!React.isValidElement(child) || child.type !== 'option') return;
      extracted.push({
        value: child.props.value ?? '',
        label: child.props.children ?? '',
        disabled: child.props.disabled,
        group: groupLabel
      });
    };

    React.Children.forEach(children, (child) => {
      if (!React.isValidElement(child)) return;
      if (child.type === 'option') {
        pushOption(child);
        return;
      }
      if (child.type === 'optgroup') {
        const groupLabel = child.props.label ?? '';
        React.Children.forEach(child.props.children, (opt) => pushOption(opt, groupLabel));
      }
    });

    return extracted;
  }, [children]);

  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(() =>
    Math.max(
      0,
      options.findIndex((opt) => opt.value === rest.value || opt.value === rest.defaultValue)
    )
  );
  const containerRef = useRef(null);
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0, width: 0 });

  // Keep highlighted option aligned with current value
  useEffect(() => {
    const currentIndex = options.findIndex((opt) => opt.value === rest.value);
    if (currentIndex >= 0) {
      setHighlightedIndex(currentIndex);
    }
  }, [options, rest.value]);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event) => {
      const { target } = event;
      if (
        containerRef.current &&
        !containerRef.current.contains(target) &&
        menuRef.current &&
        !menuRef.current.contains(target)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside, true);
    return () => document.removeEventListener('mousedown', handleClickOutside, true);
  }, [isOpen]);

  // Position dropdown in a portal to avoid clipping by overflow-hidden containers
  const updateMenuPosition = useCallback(() => {
    if (!buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setMenuPosition({
      top: rect.bottom + 4,
      left: rect.left,
      width: rect.width
    });
  }, []);

  useLayoutEffect(() => {
    if (!isOpen) return;
    updateMenuPosition();
    let rafId = null;
    const schedulePositionUpdate = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        updateMenuPosition();
      });
    };
    window.addEventListener('resize', schedulePositionUpdate);
    window.addEventListener('scroll', schedulePositionUpdate, true);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      window.removeEventListener('resize', schedulePositionUpdate);
      window.removeEventListener('scroll', schedulePositionUpdate, true);
    };
  }, [isOpen, updateMenuPosition]);

  const classes = useMemo(() => {
    const invalidClass =
      invalid || error ? 'border-stratosort-danger focus:ring-stratosort-danger/20' : '';
    return `form-input-enhanced ${invalidClass} ${className}`.trim();
  }, [invalid, error, className]);

  const selectedOption =
    options.length > 0 ? (options.find((opt) => opt.value === rest.value) ?? options[0]) : null;

  const handleSelect = useCallback(
    (option) => {
      if (option.disabled) return;
      // Fire synthetic change event to match native select signature
      rest.onChange?.({
        target: {
          value: option.value,
          name: rest.name
        }
      });
      setIsOpen(false);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rest.* member access; the rule does not statically track props read off a rest-spread, so deps must be listed explicitly
    [rest.onChange, rest.name]
  );

  const handleKeyDown = useCallback(
    (event) => {
      if (!isOpen && (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown')) {
        event.preventDefault();
        setIsOpen(true);
        return;
      }

      if (!isOpen) return;

      if (event.key === 'Escape') {
        setIsOpen(false);
        event.preventDefault();
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlightedIndex((prev) => Math.min(options.length - 1, prev + 1));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlightedIndex((prev) => Math.max(0, prev - 1));
      } else if (event.key === 'Home') {
        event.preventDefault();
        setHighlightedIndex(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        setHighlightedIndex(options.length - 1);
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        const option = options[highlightedIndex];
        if (option) handleSelect(option);
      }
    },
    [highlightedIndex, options, isOpen, handleSelect]
  );

  return (
    <div className="flex flex-col gap-1.5" ref={containerRef}>
      {label && (
        <Label id={labelId} htmlFor={id} required={required}>
          {label}
        </Label>
      )}
      <button
        type="button"
        ref={(node) => {
          buttonRef.current = node;
          if (typeof ref === 'function') ref(node);
          else if (ref) ref.current = node;
        }}
        id={id}
        // W3C select-only combobox: role="combobox" (not the implicit button
        // role) is what makes aria-required/aria-invalid/aria-activedescendant
        // valid on this trigger.
        role="combobox"
        className={`${classes} flex items-center justify-between text-left select-trigger`}
        aria-invalid={invalid || !!error}
        aria-describedby={error ? errorId : undefined}
        aria-required={required}
        aria-labelledby={labelId}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listboxId : undefined}
        aria-activedescendant={
          isOpen && options[highlightedIndex] ? getOptionId(highlightedIndex) : undefined
        }
        onClick={() => {
          setIsOpen((open) => !open);
        }}
        onKeyDown={handleKeyDown}
        disabled={rest.disabled}
      >
        <span className="truncate text-system-gray-900">{selectedOption?.label ?? ''}</span>
        <span
          className={`ml-3 transition-transform duration-150 ${isOpen ? 'rotate-180' : ''}`}
          aria-hidden="true"
        >
          <ChevronDown className="h-4 w-4 text-system-gray-400" />
        </span>
      </button>

      {isOpen &&
        options.length > 0 &&
        createPortal(
          <div
            ref={menuRef}
            id={listboxId}
            className="dropdown-menu fixed animate-dropdown-enter"
            role="listbox"
            aria-labelledby={labelId}
            aria-activedescendant={
              options[highlightedIndex] ? getOptionId(highlightedIndex) : undefined
            }
            style={{
              top: `${menuPosition.top}px`,
              left: `${menuPosition.left}px`,
              width: `${menuPosition.width}px`,
              // Design tokens place --z-modal at 600; this dropdown sits on
              // top of whichever overlay it's hosted in. Using a hardcoded
              // z-[9999] let the menu paint over genuine modals (confirm
              // dialogs, toasts) that render later in the stack and broke
              // the overlay z-order invariant. `calc(var(--z-modal) + 1)`
              // keeps it above its container but below any modal/toast.
              zIndex: 'calc(var(--z-modal) + 1)'
            }}
          >
            <div className="dropdown-menu-scroll">
              {options.map((option, index) => {
                const isSelected = option.value === selectedOption?.value;
                const isHighlighted = index === highlightedIndex;
                const prevGroup = index > 0 ? options[index - 1].group : null;
                const showGroupHeader = option.group && option.group !== prevGroup;
                const itemClass = option.disabled
                  ? 'dropdown-menu-item dropdown-menu-item--disabled'
                  : isHighlighted
                    ? 'dropdown-menu-item dropdown-menu-item--highlighted'
                    : isSelected
                      ? 'dropdown-menu-item dropdown-menu-item--selected'
                      : 'dropdown-menu-item dropdown-menu-item--default';
                return (
                  <React.Fragment key={`${option.group ?? 'flat'}-${option.value}-${index}`}>
                    {showGroupHeader && (
                      <div
                        className="px-3 pt-2 pb-1 text-xs font-semibold uppercase tracking-wide text-system-gray-500"
                        role="presentation"
                      >
                        {option.group}
                      </div>
                    )}
                    {/* aria-activedescendant composite: DOM focus stays on the
                        combobox trigger; options are announced via
                        activedescendant and must NOT be tabbable, so the
                        focus/key-handler rules do not apply here. */}
                    {/* eslint-disable-next-line jsx-a11y/interactive-supports-focus, jsx-a11y/click-events-have-key-events */}
                    <div
                      id={getOptionId(index)}
                      role="option"
                      aria-selected={isSelected}
                      className={itemClass}
                      onMouseEnter={() => setHighlightedIndex(index)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => handleSelect(option)}
                    >
                      {option.label}
                    </div>
                  </React.Fragment>
                );
              })}
            </div>
          </div>,
          document.body
        )}

      {error && (
        <p id={errorId} className="text-sm text-stratosort-danger mt-0.5" role="alert">
          {error}
        </p>
      )}
    </div>
  );
});

Select.propTypes = {
  className: PropTypes.string,
  invalid: PropTypes.bool,
  error: PropTypes.string,
  label: PropTypes.string,
  required: PropTypes.bool,
  children: PropTypes.node
};

export default Select;

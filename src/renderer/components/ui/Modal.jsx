import React, { useEffect, useRef, memo, useState, useCallback, useId } from 'react';
import { createPortal } from 'react-dom';
import PropTypes from 'prop-types';
import { X, AlertTriangle, Info, HelpCircle, FileText } from 'lucide-react';
import IconButton from './IconButton';
import Button from './Button';
import { Heading, Text } from './Typography';
import { logger } from '../../../shared/logger';
import { lockAppScroll, unlockAppScroll } from '../../utils/scrollLock';
import { isTopOverlay, registerOverlay, unregisterOverlay } from '../../utils/overlayStack';
import { getMotionDurationMs, prefersReducedMotion } from '../../utils/motionPreferences';

// Mirror of --motion-duration-fast for the close-out setTimeout when the
// CSS variable can't be read (very early boot, SSR). Real value comes from
// getMotionDurationMs('fast', ...) so token edits propagate without rebuild.
const EXIT_DURATION_FALLBACK_MS = 140;

const SIZES = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
  full: 'max-w-[95vw]'
};

const VARIANTS = {
  default: {
    header: 'border-b border-system-gray-100',
    title: 'text-system-gray-900',
    icon: null
  },
  destructive: {
    header: 'bg-stratosort-danger/10 border-b border-stratosort-danger/20',
    title: 'text-stratosort-danger',
    icon: null
  }
};

const Modal = memo(function Modal({
  isOpen,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  variant = 'default',
  closeOnOverlayClick = true,
  closeOnEsc = true,
  initialFocusRef,
  closeDisabled = false,
  className = '',
  bodyClassName = '',
  overlayId,
  /** Applied to the [role="dialog"] wrapper for stable E2E hooks */
  dataTestId
}) {
  const modalRef = useRef(null);
  const previousFocusRef = useRef(null);
  const focusTimerRef = useRef(null);
  const closingTimerRef = useRef(null);
  const [isVisible, setIsVisible] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const instanceId = useId();
  const resolvedOverlayId = overlayId || `modal-${instanceId}`;
  const titleId = `modal-title-${instanceId}`;
  const descriptionId = `modal-description-${instanceId}`;

  // Handle open/close with animation
  // Timer is stored in a ref to avoid being canceled by effect cleanup
  // when setIsClosing(true) triggers a dependency-driven re-run.
  useEffect(() => {
    if (isOpen && !isVisible && !isClosing) {
      if (closingTimerRef.current) {
        clearTimeout(closingTimerRef.current);
        closingTimerRef.current = null;
      }
      setIsVisible(true);
    } else if (isOpen && isClosing) {
      // Re-opened while closing - cancel close animation
      if (closingTimerRef.current) {
        clearTimeout(closingTimerRef.current);
        closingTimerRef.current = null;
      }
      setIsClosing(false);
    } else if (!isOpen && isVisible && !isClosing) {
      // Start closing animation. When the user has opted into reduced motion
      // the CSS exit animation collapses to ~1 ms; holding the component
      // mounted for the full 140 ms just blocks focus restore and pointer
      // events for no visual reason, so commit the close synchronously.
      if (prefersReducedMotion()) {
        setIsVisible(false);
        return;
      }
      setIsClosing(true);
      closingTimerRef.current = setTimeout(
        () => {
          closingTimerRef.current = null;
          setIsVisible(false);
          setIsClosing(false);
        },
        getMotionDurationMs('fast', EXIT_DURATION_FALLBACK_MS)
      );
    }
  }, [isOpen, isVisible, isClosing]);

  // Clean up closing timer on unmount
  useEffect(() => {
    return () => {
      if (closingTimerRef.current) {
        clearTimeout(closingTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!isVisible) return undefined;

    registerOverlay(resolvedOverlayId);

    return () => {
      unregisterOverlay(resolvedOverlayId);
    };
  }, [isVisible, resolvedOverlayId]);

  // Handle ESC key
  useEffect(() => {
    if (!isVisible || !closeOnEsc || closeDisabled) return;

    const handleKeyDown = (e) => {
      if (e.defaultPrevented) return;
      if (e.key === 'Escape' && isTopOverlay(resolvedOverlayId)) {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isVisible, closeOnEsc, closeDisabled, onClose, resolvedOverlayId]);

  // Keep keyboard focus trapped inside the open modal.
  useEffect(() => {
    if (!isVisible || isClosing) return undefined;

    const handleTabKey = (e) => {
      if (e.key !== 'Tab' || !isTopOverlay(resolvedOverlayId)) return;

      const root = modalRef.current;
      if (!root) return;

      const focusable = Array.from(
        root.querySelectorAll(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]):not([disabled])'
        )
      );

      if (focusable.length === 0) {
        e.preventDefault();
        root.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      const activeInside = root.contains(active);

      if (e.shiftKey) {
        if (!activeInside || active === first || active === root) {
          e.preventDefault();
          last.focus();
        }
      } else if (!activeInside || active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleTabKey);
    return () => {
      document.removeEventListener('keydown', handleTabKey);
    };
  }, [isVisible, isClosing, resolvedOverlayId]);

  // Focus management
  useEffect(() => {
    if (isVisible && !isClosing) {
      previousFocusRef.current = document.activeElement;
      // Small timeout to ensure render is complete - store ref for cleanup
      focusTimerRef.current = setTimeout(() => {
        if (initialFocusRef?.current) {
          initialFocusRef.current.focus();
        } else if (modalRef.current) {
          const focusable = modalRef.current.querySelectorAll(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]):not([disabled])'
          );
          if (focusable.length > 0) {
            focusable[0].focus();
          } else {
            modalRef.current.focus();
          }
        }
      }, 50);
    } else if (!isVisible) {
      // Only restore focus when nothing else claimed it during the close
      // animation. When this modal's focused node unmounts, the browser drops
      // focus to <body> — that's the legitimate restore case. But if another
      // surface already took focus (e.g. the Settings panel opening while
      // this modal animates out in the overlay swap), restoring would yank
      // keyboard focus back OUT of the newly opened dialog.
      const active = document.activeElement;
      const focusUnclaimed =
        !active || active === document.body || active === document.documentElement;
      // Only restore focus if the previously-focused element is still mounted.
      // Without the isConnected guard, a modal closing after the opener was
      // removed (e.g. parent unmounted during an async flow) throws an
      // "Uncaught TypeError: focus is not a function on null" in older paths
      // or silently focuses a detached node in newer ones, which breaks the
      // tab chain and loses focus entirely.
      const previous = previousFocusRef.current;
      if (
        focusUnclaimed &&
        previous &&
        typeof previous.focus === 'function' &&
        previous.isConnected !== false
      ) {
        try {
          previous.focus();
        } catch {
          // Some embeds (iframes in detached state) can throw from focus().
          // Falling back to the document body keeps keyboard nav recoverable.
          document.body?.focus?.();
        }
      }
    }
    return () => {
      if (focusTimerRef.current) {
        clearTimeout(focusTimerRef.current);
        focusTimerRef.current = null;
      }
      // Hard-unmount while still open (e.g. useConfirmDialog flips isOpen and
      // removes ConfirmModal from the tree) never runs the !isVisible branch
      // above — restore focus here so keyboard focus doesn't drop to <body>.
      if (!(isVisible && !isClosing)) return;
      const active = document.activeElement;
      const focusUnclaimed =
        !active || active === document.body || active === document.documentElement;
      const previous = previousFocusRef.current;
      if (
        focusUnclaimed &&
        previous &&
        typeof previous.focus === 'function' &&
        previous.isConnected !== false
      ) {
        try {
          previous.focus();
        } catch {
          document.body?.focus?.();
        }
      }
    };
  }, [isVisible, isClosing, initialFocusRef]);

  // Lock scroll on the actual app scroller (main-content) and body as fallback
  useEffect(() => {
    if (!isVisible) return undefined;

    const lockId = `modal-${instanceId}`;
    lockAppScroll(lockId);

    return () => {
      unlockAppScroll(lockId);
    };
  }, [isVisible, instanceId]);

  if (!isVisible) return null;

  const variantStyles = VARIANTS[variant] || VARIANTS.default;
  const sizeClass = SIZES[size] || SIZES.md;
  const panelMaxHeight =
    size === 'full'
      ? 'max-h-[calc(100vh-var(--app-nav-height)-1rem)]'
      : 'max-h-[calc(100vh-var(--app-nav-height)-2rem)]';
  const overlayPaddingTop = 'calc(var(--app-nav-height) + 1rem)';
  const overlayPaddingBottom = '1.5rem';

  const backdropAnimation = isClosing ? 'animate-modal-backdrop-exit' : 'animate-modal-backdrop';
  const panelAnimation = isClosing ? 'animate-modal-exit' : 'animate-modal-enter';

  const content = (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center p-4 sm:p-6"
      style={{ paddingTop: overlayPaddingTop, paddingBottom: overlayPaddingBottom }}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      {...(dataTestId ? { 'data-testid': dataTestId } : {})}
    >
      {/* Backdrop */}
      <div
        className={`absolute inset-0 pointer-events-auto ${backdropAnimation}`}
        style={{ backgroundColor: 'var(--overlay-scrim)' }}
        onClick={closeOnOverlayClick && !isClosing && !closeDisabled ? onClose : undefined}
        aria-hidden="true"
      />

      {/* Modal Panel */}
      <div
        ref={modalRef}
        className={`
          relative w-full ${sizeClass} ${panelMaxHeight} ${
            size === 'full' ? 'h-[calc(100vh-var(--app-nav-height)-1rem)]' : ''
          } rounded-2xl shadow-2xl flex flex-col overflow-hidden border border-border-soft
          ${className}
          ${panelAnimation}
        `}
        style={{ backgroundColor: 'var(--surface-raised)' }}
        tabIndex={-1}
      >
        {/* Header */}
        <div
          className={`flex items-center justify-between px-6 py-4 ${variantStyles.header} shrink-0`}
        >
          <div>
            {/* h2, not h3: dialogs open over pages whose top heading is an h1,
                so an h3 title skips a level (axe heading-order). variant="h4"
                keeps the visual size unchanged. */}
            <Heading as="h2" variant="h4" id={titleId} className={variantStyles.title}>
              {title}
            </Heading>
            {description && (
              <Text id={descriptionId} variant="small" className="mt-1 text-system-gray-500">
                {description}
              </Text>
            )}
          </div>
          <IconButton
            onClick={onClose}
            variant="ghost"
            size="sm"
            aria-label="Close modal"
            className="text-system-gray-400 hover:text-system-gray-600 -mr-2"
            icon={<X className="w-5 h-5" />}
            disabled={closeDisabled || isClosing}
          />
        </div>

        {/* Body */}
        <div
          className={`p-6 overflow-y-auto custom-scrollbar flex-1 min-h-0 ${bodyClassName}`.trim()}
        >
          {children}
        </div>

        {/* Footer */}
        {footer && (
          <div className="px-6 py-4 border-t border-system-gray-200/80 flex justify-end gap-cozy shrink-0 rounded-b-2xl bg-system-gray-50/70">
            {footer}
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(content, document.body);
});

Modal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  title: PropTypes.node.isRequired,
  description: PropTypes.string,
  children: PropTypes.node.isRequired,
  footer: PropTypes.node,
  size: PropTypes.oneOf(['sm', 'md', 'lg', 'xl', 'full']),
  variant: PropTypes.oneOf(['default', 'destructive']),
  closeOnOverlayClick: PropTypes.bool,
  closeOnEsc: PropTypes.bool,
  initialFocusRef: PropTypes.object,
  closeDisabled: PropTypes.bool,
  className: PropTypes.string,
  bodyClassName: PropTypes.string,
  overlayId: PropTypes.string,
  dataTestId: PropTypes.string
};

export const ConfirmModal = memo(function ConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  title = 'Confirm action',
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  variant = 'default', // default, danger, warning, info
  fileName = null,
  // When set, the user must type this exact string before the Confirm
  // button enables. Used for irreversible actions (delete backup, full
  // embedding rebuild) so accidental clicks can't fire them.
  requireConfirmText = null
}) {
  const [isConfirming, setIsConfirming] = useState(false);
  const [typedConfirmation, setTypedConfirmation] = useState('');
  // Error surfaced from an async onConfirm handler. When set, we keep the
  // modal open and render an inline banner so the user can see why the action
  // failed and retry. Previously we silently swallowed the rejection and
  // closed the modal as if the operation had succeeded, which hid real
  // failures (failed deletes, failed organize operations, etc.).
  const [confirmError, setConfirmError] = useState(null);
  const isConfirmingRef = useRef(false);
  const isMountedRef = useRef(true);
  // Only autofocus the confirm button the FIRST time the modal opens.
  // Subsequent re-opens (or retries after an inline error) should not steal
  // focus from wherever the user is currently interacting. This ref flips
  // on first open and resets when the modal fully closes.
  const autoFocusConsumedRef = useRef(false);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isOpen) {
      setIsConfirming(false);
      setConfirmError(null);
      setTypedConfirmation('');
      isConfirmingRef.current = false;
      autoFocusConsumedRef.current = false;
    }
  }, [isOpen]);

  // First-open autoFocus gate: derived each render, not stateful. Once we
  // decide to autoFocus we flip the ref so re-renders while the modal is
  // open (inline error → retry, etc.) don't re-focus the confirm button.
  const shouldAutoFocusConfirm = isOpen && !autoFocusConsumedRef.current;
  if (shouldAutoFocusConfirm) {
    autoFocusConsumedRef.current = true;
  }

  const handleConfirm = useCallback(async () => {
    // Synchronous ref guard prevents double-execution from rapid clicks
    // (React state updates are async and can't block a second click)
    if (isConfirmingRef.current) return;
    isConfirmingRef.current = true;

    setIsConfirming(true);
    // Clear any previous error so the banner disappears while a retry is in
    // flight; if the retry also fails we'll set it again below.
    setConfirmError(null);
    try {
      await onConfirm();
      if (isMountedRef.current) {
        onClose();
      }
    } catch (error) {
      logger.error('[ConfirmModal] onConfirm failed', { error });
      if (isMountedRef.current) {
        // Keep the modal open so the user can see the failure and decide
        // whether to retry or cancel. Extract a user-facing message with a
        // sane fallback; never surface raw stack traces.
        const message =
          (error && typeof error.message === 'string' && error.message.trim()) ||
          (typeof error === 'string' && error.trim()) ||
          'Something went wrong. Please try again.';
        setConfirmError(message);
      }
    } finally {
      isConfirmingRef.current = false;
      if (isMountedRef.current) {
        setIsConfirming(false);
      }
    }
  }, [onConfirm, onClose]);

  const confirmVariant =
    variant === 'danger'
      ? 'danger'
      : variant === 'warning'
        ? 'warning'
        : variant === 'info'
          ? 'info'
          : 'primary';

  const getIcon = () => {
    switch (variant) {
      case 'danger':
        return (
          <div className="w-12 h-12 bg-stratosort-danger/10 rounded-full flex items-center justify-center shrink-0">
            <AlertTriangle className="w-6 h-6 text-stratosort-danger" />
          </div>
        );
      case 'warning':
        return (
          <div className="w-12 h-12 bg-stratosort-warning/10 rounded-full flex items-center justify-center shrink-0">
            <AlertTriangle className="w-6 h-6 text-stratosort-warning" />
          </div>
        );
      case 'info':
        return (
          <div className="w-12 h-12 bg-stratosort-blue/10 rounded-full flex items-center justify-center shrink-0">
            <Info className="w-6 h-6 text-stratosort-blue" />
          </div>
        );
      default:
        return (
          <div className="w-12 h-12 bg-system-gray-100 rounded-full flex items-center justify-center shrink-0">
            <HelpCircle className="w-6 h-6 text-system-gray-600" />
          </div>
        );
    }
  };

  const typeMatchSatisfied = !requireConfirmText || typedConfirmation.trim() === requireConfirmText;
  const confirmDisabled = isConfirming || !typeMatchSatisfied;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="sm"
      title={title}
      closeOnOverlayClick={false}
      closeDisabled={isConfirming}
      variant={variant === 'danger' ? 'destructive' : 'default'}
      footer={
        <>
          <Button onClick={onClose} variant="secondary" size="sm" disabled={isConfirming}>
            {cancelText}
          </Button>
          {/* eslint-disable jsx-a11y/no-autofocus -- deliberate initial focus per WAI-ARIA dialog pattern */}
          <Button
            onClick={handleConfirm}
            variant={confirmVariant}
            size="sm"
            isLoading={isConfirming}
            disabled={confirmDisabled}
            autoFocus={shouldAutoFocusConfirm && !requireConfirmText}
          >
            {isConfirming ? 'Processing...' : confirmError ? 'Try again' : confirmText}
          </Button>
          {/* eslint-enable jsx-a11y/no-autofocus */}
        </>
      }
    >
      <div className="flex items-start gap-default">
        <div className={variant === 'danger' ? 'animate-confirm-bounce' : ''}>{getIcon()}</div>
        <div className="flex-1 pt-1">
          <div className="text-system-gray-600 leading-relaxed break-words">
            {message}
            {fileName && (
              <div className="mt-3 p-3 bg-system-gray-50 rounded-lg border border-border-soft">
                <div className="flex items-center gap-compact text-sm">
                  <FileText className="w-4 h-4 text-system-gray-400" />
                  <span className="font-medium text-system-gray-700">{fileName}</span>
                </div>
              </div>
            )}
            {requireConfirmText && (
              <div className="mt-4">
                <label className="block text-sm text-system-gray-700 mb-1.5">
                  To confirm, type{' '}
                  <code className="font-mono text-stratosort-danger bg-stratosort-danger/8 px-1 py-0.5 rounded">
                    {requireConfirmText}
                  </code>{' '}
                  below:
                </label>
                {/* eslint-disable jsx-a11y/no-autofocus -- deliberate initial focus per WAI-ARIA dialog pattern */}
                <input
                  type="text"
                  value={typedConfirmation}
                  onChange={(e) => setTypedConfirmation(e.target.value)}
                  className="form-input-enhanced w-full"
                  autoFocus={shouldAutoFocusConfirm}
                  aria-label={`Type ${requireConfirmText} to confirm`}
                  spellCheck={false}
                  autoComplete="off"
                />
                {/* eslint-enable jsx-a11y/no-autofocus */}
              </div>
            )}
            {confirmError && (
              <div
                role="alert"
                aria-live="assertive"
                className="mt-3 p-3 rounded-lg border border-stratosort-danger/30 bg-stratosort-danger/5 text-sm text-stratosort-danger flex items-start gap-compact"
                data-testid="confirm-modal-error"
              >
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                <span className="break-words">{confirmError}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
});

ConfirmModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onConfirm: PropTypes.func.isRequired,
  title: PropTypes.string,
  message: PropTypes.node,
  confirmText: PropTypes.string,
  cancelText: PropTypes.string,
  variant: PropTypes.oneOf(['default', 'danger', 'warning', 'info']),
  fileName: PropTypes.string,
  requireConfirmText: PropTypes.string
};

export default Modal;

import React, { useEffect, useId, useRef, memo, useState } from 'react';
import { createPortal } from 'react-dom';
import PropTypes from 'prop-types';
import { X } from 'lucide-react';
import IconButton from './IconButton';
import { Heading, Text } from './Typography';
import {
  isTopOverlay,
  registerOverlay,
  unregisterOverlay,
  setOverlayBlocking
} from '../../utils/overlayStack';
import { prefersReducedMotion } from '../../utils/motionPreferences';

// Animation durations in ms
const ANIMATION = {
  // Keep in sync with motion tokens used by CSS animation classes.
  ENTER: 220,
  EXIT: 140
};

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]):not([disabled])';

const SidePanel = memo(function SidePanel({
  isOpen,
  onClose,
  title,
  description,
  children,
  footer,
  width = 460,
  position = 'right',
  closeOnEsc = true,
  showOverlay = false,
  closeOnOverlayClick = true,
  closeDisabled = false,
  className = '',
  overlayId
}) {
  const panelRef = useRef(null);
  const previousFocusRef = useRef(null);
  const focusTimerRef = useRef(null);
  const closingTimerRef = useRef(null);
  const titleId = useId();
  const descriptionId = useId();
  const resolvedOverlayId = overlayId || `side-panel-${titleId}`;
  const [isVisible, setIsVisible] = useState(false);
  const [isClosing, setIsClosing] = useState(false);

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
      // Start closing animation. Skip the exit hold when the user has
      // opted into reduced motion so focus-restore and pointer-events
      // unblock immediately (mirrors the CSS animation, which is also
      // collapsed to ~1 ms under `prefers-reduced-motion: reduce`).
      if (prefersReducedMotion()) {
        setIsVisible(false);
        return;
      }
      setIsClosing(true);
      closingTimerRef.current = setTimeout(() => {
        closingTimerRef.current = null;
        setIsVisible(false);
        setIsClosing(false);
      }, ANIMATION.EXIT);
    }
  }, [isOpen, isVisible, isClosing]);

  // Clean up closing timer and focus timer on unmount
  useEffect(() => {
    return () => {
      if (closingTimerRef.current) {
        clearTimeout(closingTimerRef.current);
      }
      if (focusTimerRef.current) {
        clearTimeout(focusTimerRef.current);
        focusTimerRef.current = null;
      }
    };
  }, []);

  // Registration must NOT depend on showOverlay: registerOverlay is
  // remove-then-push, so a mid-session showOverlay flip would hoist this
  // panel above any modal opened after it (wrong Escape target, wrong
  // canHotkeySwapSurface veto). Register once per visibility; flag changes
  // mutate in place below.
  const blockingRef = useRef(showOverlay);
  blockingRef.current = showOverlay;
  useEffect(() => {
    if (!isVisible) return undefined;

    // Drawer mode (no scrim, page still interactive) registers as
    // non-blocking: it keeps Escape precedence but must not veto hotkey
    // surface swaps like Ctrl+, — the settings shortcut going silently dead
    // while a complementary drawer is open reads as a broken hotkey.
    registerOverlay(resolvedOverlayId, { blocking: blockingRef.current });

    return () => {
      unregisterOverlay(resolvedOverlayId);
    };
  }, [isVisible, resolvedOverlayId]);

  useEffect(() => {
    if (!isVisible) return;
    setOverlayBlocking(resolvedOverlayId, showOverlay);
  }, [isVisible, resolvedOverlayId, showOverlay]);

  useEffect(() => {
    if (!isVisible || !closeOnEsc || closeDisabled) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && isTopOverlay(resolvedOverlayId)) {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isVisible, closeOnEsc, closeDisabled, onClose, resolvedOverlayId]);

  // Focus management: save previous focus, move into panel, restore on close
  useEffect(() => {
    if (isVisible && !isClosing) {
      previousFocusRef.current = document.activeElement;
      focusTimerRef.current = setTimeout(() => {
        if (panelRef.current) {
          const focusable = panelRef.current.querySelectorAll(FOCUSABLE_SELECTOR);
          if (focusable.length > 0) {
            focusable[0].focus();
          } else {
            panelRef.current.focus();
          }
        }
      }, 50);
    } else if (!isVisible) {
      const previous = previousFocusRef.current;
      if (previous && typeof previous.focus === 'function' && previous.isConnected !== false) {
        try {
          previous.focus();
        } catch {
          document.body?.focus?.();
        }
      }
    }
    return () => {
      if (focusTimerRef.current) {
        clearTimeout(focusTimerRef.current);
        focusTimerRef.current = null;
      }
    };
  }, [isVisible, isClosing]);

  // Focus trap: keep Tab cycling inside the top-most panel.
  //
  // Previously this was gated on `showOverlay` so drawer-style panels (which
  // render without a scrim) had no trap at all — Tab would leak into the
  // page below the panel, breaking a11y for users on "in-panel" wizards.
  // The trap only needs the panel to be visible and top-most; whether a
  // scrim is drawn is orthogonal to whether the panel owns focus.
  useEffect(() => {
    if (!isVisible || isClosing) return undefined;

    const handleTabKey = (e) => {
      if (e.key !== 'Tab' || !isTopOverlay(resolvedOverlayId)) return;

      const root = panelRef.current;
      if (!root) return;

      const focusable = Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR));
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
    return () => document.removeEventListener('keydown', handleTabKey);
  }, [isVisible, isClosing, resolvedOverlayId]);

  if (!isVisible) return null;

  const panelWidth = typeof width === 'number' ? `${width}px` : width;
  const edgeClass = position === 'left' ? 'left-0' : 'right-0';

  // Determine animation class based on position and closing state
  const getAnimationClass = () => {
    if (position === 'left') {
      return isClosing ? 'animate-sidepanel-exit-left' : 'animate-sidepanel-enter-left';
    }
    return isClosing ? 'animate-sidepanel-exit-right' : 'animate-sidepanel-enter-right';
  };

  const overlayAnimation = isClosing ? 'animate-modal-backdrop-exit' : 'animate-modal-backdrop';

  const content = (
    <div className="fixed inset-0 pointer-events-none" style={{ zIndex: 'var(--z-modal)' }}>
      {showOverlay && (
        <div
          className={`absolute inset-0 pointer-events-auto ${overlayAnimation}`}
          style={{ backgroundColor: 'var(--overlay-scrim-subtle)' }}
          onClick={closeOnOverlayClick && !isClosing && !closeDisabled ? onClose : undefined}
          aria-hidden="true"
        />
      )}
      <aside
        ref={panelRef}
        className={`fixed ${edgeClass} pointer-events-auto shadow-2xl border border-border-soft rounded-2xl flex flex-col overflow-hidden ${getAnimationClass()} ${className}`.trim()}
        style={{
          width: panelWidth,
          top: 'calc(var(--app-nav-height) + 0.75rem)',
          bottom: '0.75rem',
          backgroundColor: 'var(--surface-raised)'
        }}
        // When the panel is rendered with a scrim (`showOverlay`) we are in
        // modal-dialog territory: focus is trapped, background is inert, and
        // the user must explicitly close the panel. That matches the ARIA
        // `role="dialog"` + `aria-modal="true"` semantics; screen readers
        // announce it as a modal and will correctly scope virtual navigation
        // to the dialog. Drawer-style (non-overlay) panels stay
        // `role="complementary"` since they coexist with the page content.
        role={showOverlay ? 'dialog' : 'complementary'}
        aria-modal={showOverlay ? 'true' : undefined}
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-system-gray-200/80 bg-system-gray-50/50">
          <div className="min-w-0">
            <Heading as="h3" variant="h5" id={titleId} className="text-system-gray-900">
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
            aria-label="Close panel"
            className="text-system-gray-400 hover:text-system-gray-600 -mr-2"
            icon={<X className="w-5 h-5" />}
            disabled={closeDisabled || isClosing}
          />
        </div>
        <div className="p-6 overflow-y-auto custom-scrollbar flex-1 min-h-0">{children}</div>
        {footer && (
          <div className="px-6 py-4 bg-system-gray-50/70 border-t border-system-gray-200/80 flex justify-end gap-cozy">
            {footer}
          </div>
        )}
      </aside>
    </div>
  );

  return createPortal(content, document.body);
});

SidePanel.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  title: PropTypes.node.isRequired,
  description: PropTypes.string,
  children: PropTypes.node.isRequired,
  footer: PropTypes.node,
  width: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
  position: PropTypes.oneOf(['left', 'right']),
  closeOnEsc: PropTypes.bool,
  showOverlay: PropTypes.bool,
  closeOnOverlayClick: PropTypes.bool,
  closeDisabled: PropTypes.bool,
  className: PropTypes.string,
  overlayId: PropTypes.string
};

export default SidePanel;

// @ts-check
import { useEffect, useId, useRef } from 'react';
import { isTopOverlay, registerOverlay, unregisterOverlay } from '../utils/overlayStack';

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]):not([disabled])';

/**
 * Dialog a11y behaviors for hand-rolled overlays that (deliberately) do not
 * use the shared <Modal> component: overlay-stack registration, Escape on the
 * top overlay only, a Tab focus trap, initial focus into the dialog, and
 * focus restore to the opener on close. Mirrors Modal.jsx's implementation so
 * stacked dialogs (Settings -> Configure -> Consent) close one layer per
 * Escape press.
 *
 * @param {object} options
 * @param {boolean} options.active - whether the dialog is currently shown
 * @param {React.RefObject<HTMLElement>} options.containerRef - dialog panel root
 * @param {() => void} [options.onEscape] - invoked on Escape while top overlay
 */
export default function useDialogFocusTrap({ active, containerRef, onEscape }) {
  const overlayId = useId();
  const previousFocusRef = useRef(null);
  const focusTimerRef = useRef(null);
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return undefined;

    registerOverlay(overlayId);
    return () => {
      unregisterOverlay(overlayId);
    };
  }, [active, overlayId]);

  useEffect(() => {
    if (!active) return undefined;

    const handleKeyDown = (/** @type {any} */ e) => {
      if (e.defaultPrevented) return;

      if (e.key === 'Escape' && isTopOverlay(overlayId)) {
        if (typeof onEscapeRef.current === 'function') {
          e.preventDefault();
          onEscapeRef.current();
        }
        return;
      }

      if (e.key !== 'Tab' || !isTopOverlay(overlayId)) return;

      const root = containerRef.current;
      if (!root) return;

      const focusable = Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) {
        e.preventDefault();
        root.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeEl = document.activeElement;
      const activeInside = root.contains(activeEl);

      if (e.shiftKey) {
        if (!activeInside || activeEl === first || activeEl === root) {
          e.preventDefault();
          /** @type {HTMLElement} */ (last).focus();
        }
      } else if (!activeInside || activeEl === last) {
        e.preventDefault();
        /** @type {HTMLElement} */ (first).focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [active, overlayId, containerRef]);

  useEffect(() => {
    if (active) {
      previousFocusRef.current = document.activeElement;
      focusTimerRef.current = setTimeout(() => {
        const root = containerRef.current;
        if (!root || root.contains(document.activeElement)) return;
        const focusable = root.querySelectorAll(FOCUSABLE_SELECTOR);
        if (focusable.length > 0) {
          /** @type {HTMLElement} */ (focusable[0]).focus();
        } else {
          root.focus();
        }
      }, 50);
    }

    return () => {
      if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
      if (!active) return;
      // Restore focus to the opener, guarding against unmounted nodes (same
      // isConnected rationale as Modal.jsx).
      const previous = previousFocusRef.current;
      if (previous && typeof previous.focus === 'function' && previous.isConnected !== false) {
        try {
          previous.focus();
        } catch {
          document.body?.focus?.();
        }
      }
    };
  }, [active, containerRef]);
}

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  lazy,
  Suspense
} from 'react';
import PropTypes from 'prop-types';
const UnifiedSearchModal = lazy(() => import('../components/search/UnifiedSearchModal'));
import SearchErrorBoundary from '../components/search/SearchErrorBoundary';
import { ModalLoadingOverlay } from '../components/ui/LoadingSkeleton';
import { useAppDispatch, useAppSelector } from '../store/hooks';
import { closeSettings } from '../store/slices/uiSlice';
import { logger } from '../../shared/logger';
import { isEditableTarget } from '../utils/isEditableTarget';
import { canHotkeySwapSurface } from '../utils/overlayStack';

const FloatingSearchContext = createContext(null);

// Hotkey/tray openers must not swap surfaces while a dialog other than
// Settings or Knowledge OS itself is on top (destructive ConfirmModal,
// consent prompt, ...): opening Knowledge OS also dispatches closeSettings,
// which would tear down an in-progress flow underneath the user. Shared with
// the settings-open paths in useKeyboardShortcuts (the mirror direction —
// opening Settings closes Knowledge OS via the effect below).
const canHotkeyOpenSearch = canHotkeySwapSurface;

export function FloatingSearchProvider({ children }) {
  const dispatch = useAppDispatch();
  const showSettings = useAppSelector((state) => state.ui?.showSettings);
  // Do not persist modal open state across restarts.
  // Persisting causes the full-screen modal to auto-open and lock scroll unexpectedly.
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalInitialTab, setModalInitialTab] = useState('search');
  // Track whether modal has ever been opened so the lazy chunk is only loaded once
  // needed, but the component stays mounted afterward for close animations.
  const [modalEverOpened, setModalEverOpened] = useState(false);

  const openSearchModal = useCallback(
    (tab = 'search') => {
      setModalInitialTab(tab);
      setIsModalOpen(true);
      setModalEverOpened(true);
      // One overlay at a time: both this modal and the settings panel portal
      // to document.body at the same z-index, so stacking them leaves
      // settings invisibly held open beneath Knowledge OS.
      dispatch(closeSettings());
    },
    [dispatch]
  );

  const closeSearchModal = useCallback(() => {
    setIsModalOpen(false);
  }, []);

  // The reverse direction: opening settings (gear, Ctrl+,, File menu, links
  // inside the modal itself) replaces an open Knowledge OS modal.
  useEffect(() => {
    if (showSettings) {
      setIsModalOpen(false);
    }
  }, [showSettings]);

  // Listen for global shortcut / tray trigger to open semantic search
  useEffect(() => {
    const api = window.electronAPI?.system?.onOpenSemanticSearch;
    if (!api) return undefined;

    const cleanup = api(() => {
      if (!canHotkeyOpenSearch()) return;
      openSearchModal('search');
    });

    return () => {
      if (typeof cleanup === 'function') {
        cleanup();
      }
    };
  }, [openSearchModal]);

  // Keyboard shortcut: Ctrl+K / Cmd+K to open search modal
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        if (isEditableTarget(e.target)) return;
        if (!canHotkeyOpenSearch()) return;
        e.preventDefault();
        openSearchModal('search');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [openSearchModal]);

  const contextValue = useMemo(
    () => ({
      isModalOpen,
      openSearchModal,
      closeSearchModal
    }),
    [isModalOpen, openSearchModal, closeSearchModal]
  );

  const handleSearchError = useCallback((error, errorInfo) => {
    logger.error('[FloatingSearchProvider] Search modal error caught by boundary', {
      error: error?.message,
      componentStack: errorInfo?.componentStack
    });
  }, []);

  return (
    <FloatingSearchContext.Provider value={contextValue}>
      {children}
      {/* Lazy-load: only mount once the modal has been opened at least once.
          Keep mounted after first open so Modal can run its close animation. */}
      {modalEverOpened && (
        <SearchErrorBoundary
          key="search-modal"
          onClose={closeSearchModal}
          onError={handleSearchError}
        >
          <Suspense
            fallback={
              // Lightweight spinner — not `null` — so a slow lazy chunk
              // load (first Ctrl+K on a cold renderer, especially on
              // low-end hardware) gives the user immediate visual
              // feedback that the search modal is opening. The overlay
              // is aria-live'd via role="status" so screen readers
              // announce it too. We only render it while the modal is
              // requested to be open; closing flips `isModalOpen` and
              // the fallback evaporates with the Suspense boundary.
              isModalOpen ? <ModalLoadingOverlay message="Opening search..." /> : null
            }
          >
            <UnifiedSearchModal
              isOpen={isModalOpen}
              onClose={closeSearchModal}
              defaultTopK={20}
              initialTab={modalInitialTab}
            />
          </Suspense>
        </SearchErrorBoundary>
      )}
    </FloatingSearchContext.Provider>
  );
}

FloatingSearchProvider.propTypes = {
  children: PropTypes.node.isRequired
};

export function useFloatingSearch() {
  const context = useContext(FloatingSearchContext);
  if (!context) {
    throw new Error('useFloatingSearch must be used within FloatingSearchProvider');
  }
  return context;
}

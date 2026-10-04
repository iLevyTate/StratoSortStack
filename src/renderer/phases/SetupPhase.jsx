import React, { useEffect, useState, useMemo, useRef, useCallback, useLayoutEffect } from 'react';
import { PHASES } from '../../shared/constants';
import { TIMEOUTS } from '../../shared/performanceConstants';
import { createLogger } from '../../shared/logger';
import { useAppDispatch, useAppSelector } from '../store/hooks';
import { setSmartFolders as setSmartFoldersAction } from '../store/slices/filesSlice';
import { setPhase } from '../store/slices/uiSlice';
import { fetchDocumentsPath } from '../store/slices/systemSlice';
import { useNotification } from '../contexts/NotificationContext';
import { useConfirmDialog } from '../hooks';
import {
  Button,
  IconButton,
  MinimizableGuideCard,
  StateMessage,
  StatusBadge
} from '../components/ui';
import { Heading, Text } from '../components/ui/Typography';
import WatcherStatusLine from '../components/setup/WatcherStatusLine';
import { ActionBar, Inline, Stack } from '../components/layout';
import { SmartFolderSkeleton } from '../components/ui/LoadingSkeleton';
import { SmartFolderItem, AddSmartFolderModal } from '../components/setup';
import { Plus, ChevronDown, ChevronUp, RotateCcw, Folder } from 'lucide-react';
import { filesIpc, settingsIpc, smartFoldersIpc } from '../services/ipc';
import { normalizePathValue } from '../utils/pathNormalization';
import { mapErrorToNotification } from '../utils/errorMapping';

const logger = createLogger('SetupPhase');
const normalizePathWithFallback = (value, fallback = 'Documents') => {
  const normalized = normalizePathValue(value);
  return normalized || fallback;
};

// Stable identity for a smart folder. Prefers a trimmed string id, falls back to
// the stringified id, and finally to a name|path composite for legacy entries
// that predate id generation.
const folderIdentity = (folder) => {
  const rawId = folder?.id;
  if (typeof rawId === 'string' && rawId.trim()) return rawId.trim();
  if (rawId != null && rawId !== '') return String(rawId);
  return `${folder?.name ?? ''}|${folder?.path ?? ''}`;
};

// Removes duplicate folders that share an identity. Legacy/persisted state can
// contain entries with non-unique bare-timestamp ids (e.g. `1769548763855`) that
// never pass through backend normalization; rendering those produced duplicate
// React keys and phantom duplicate cards. Keeps the first occurrence and preserves
// order, so derived counts and keys stay consistent across the component.
const dedupeSmartFolders = (folders) => {
  if (!Array.isArray(folders)) return [];
  const seen = new Set();
  const result = [];
  for (const folder of folders) {
    const identity = folderIdentity(folder);
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(folder);
  }
  return result;
};

function SetupPhase() {
  const dispatch = useAppDispatch();
  const documentsPathFromStore = useAppSelector((state) => state.system.documentsPath);
  const smartFoldersFromStore = useAppSelector((state) => state.files.smartFolders);

  const actions = useMemo(
    () => ({
      setPhaseData: (key, value) => {
        if (key === 'smartFolders') dispatch(setSmartFoldersAction(value));
      },
      advancePhase: (phase) => dispatch(setPhase(phase))
    }),
    [dispatch]
  );

  const { showConfirm, ConfirmDialog } = useConfirmDialog();
  const { showSuccess, showError, showWarning, showInfo, addNotification } = useNotification();

  const [smartFolders, setSmartFolders] = useState([]);
  const [editingFolder, setEditingFolder] = useState(null);
  const [defaultLocation, setDefaultLocation] = useState('Documents');
  const [isDefaultLocationLoaded, setIsDefaultLocationLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [showSkeletonLayer, setShowSkeletonLayer] = useState(true);
  const [contentVisible, setContentVisible] = useState(false);
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [isDeletingFolder, setIsDeletingFolder] = useState(null);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState(new Set());
  const [viewMode, setViewMode] = useState('compact'); // 'compact' or 'expanded'
  const [isListScrollable, setIsListScrollable] = useState(false);
  const isMountedRef = useRef(true);
  const notifyRef = useRef({});
  const listContainerRef = useRef(null);

  // Use ref to avoid re-adding listener on every editingFolder change
  const editingFolderRef = useRef(editingFolder);
  useEffect(() => {
    editingFolderRef.current = editingFolder;
  }, [editingFolder]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && editingFolderRef.current) {
        setEditingFolder(null);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Update defaultLocation when Redux store gets the path
  useEffect(() => {
    if (documentsPathFromStore && !isDefaultLocationLoaded) {
      const normalized = normalizePathWithFallback(documentsPathFromStore, 'Documents');
      if (normalized !== 'Documents') {
        setDefaultLocation(normalized);
      }
      setIsDefaultLocationLoaded(true);
    }
  }, [documentsPathFromStore, isDefaultLocationLoaded]);

  // Keep notification functions stable via ref
  useEffect(() => {
    notifyRef.current = {
      showSuccess,
      showError,
      showWarning,
      showInfo,
      addNotification
    };
  }, [showSuccess, showError, showWarning, showInfo, addNotification]);

  const loadDefaultLocation = useCallback(async () => {
    try {
      if (!documentsPathFromStore) {
        dispatch(fetchDocumentsPath());
      }
      const settings = await settingsIpc.get();
      if (settings?.defaultSmartFolderLocation) {
        setDefaultLocation(
          normalizePathWithFallback(settings.defaultSmartFolderLocation, 'Documents')
        );
        setIsDefaultLocationLoaded(true);
        return;
      }

      if (documentsPathFromStore) {
        setDefaultLocation(normalizePathWithFallback(documentsPathFromStore, 'Documents'));
        setIsDefaultLocationLoaded(true);
        return;
      }

      setIsDefaultLocationLoaded(true);
      return;
    } catch (error) {
      logger.warn('Failed to load default smart folder location from settings', {
        error: error?.message
      });
      if (documentsPathFromStore) {
        setDefaultLocation(normalizePathWithFallback(documentsPathFromStore, 'Documents'));
        setIsDefaultLocationLoaded(true);
        return;
      }
      setIsDefaultLocationLoaded(true);
    }
  }, [documentsPathFromStore, dispatch]);

  const handleOpenAddModal = useCallback(async () => {
    await loadDefaultLocation();
    setIsAddModalOpen(true);
  }, [loadDefaultLocation]);

  const loadSmartFolders = useCallback(async () => {
    try {
      const folders = await smartFoldersIpc.get();

      if (!Array.isArray(folders)) {
        logger.warn('Received non-array response', { folders });
        notifyRef.current.showError?.('Failed to load smart folders. Please try again.');
        return;
      }

      const uniqueFolders = dedupeSmartFolders(folders);
      setSmartFolders(uniqueFolders);
      actions.setPhaseData('smartFolders', uniqueFolders);
    } catch (error) {
      logger.error('Failed to load smart folders', {
        error: error.message,
        stack: error.stack
      });
      const { message } = mapErrorToNotification({ error });
      notifyRef.current.showError?.(`Failed to load smart folders: ${message}`);
    }
  }, [actions]);

  useEffect(() => {
    if (Array.isArray(smartFoldersFromStore) && smartFoldersFromStore.length > 0) {
      setSmartFolders((prev) =>
        prev !== smartFoldersFromStore ? dedupeSmartFolders(smartFoldersFromStore) : prev
      );
    }
  }, [smartFoldersFromStore]);

  useEffect(() => {
    isMountedRef.current = true;
    const initializeSetup = async () => {
      if (isMountedRef.current) setIsLoading(true);
      try {
        const initSettled = await Promise.allSettled([loadSmartFolders(), loadDefaultLocation()]);
        const rejected = initSettled.find((r) => r.status === 'rejected');
        if (rejected) throw rejected.reason;
      } catch (error) {
        logger.error('Failed to initialize setup', {
          error: error.message,
          stack: error.stack
        });
        if (isMountedRef.current) notifyRef.current.showError?.('Failed to load setup data');
      } finally {
        if (isMountedRef.current) setIsLoading(false);
      }
    };
    initializeSetup();
    return () => {
      isMountedRef.current = false;
    };
  }, [loadSmartFolders, loadDefaultLocation]);

  useEffect(() => {
    let fadeTimeout;

    if (isLoading) {
      setShowSkeletonLayer(true);
      setContentVisible(false);
    } else {
      setContentVisible(true);
      fadeTimeout = setTimeout(() => setShowSkeletonLayer(false), TIMEOUTS.ANIMATION_FADE);
    }

    return () => {
      if (fadeTimeout) clearTimeout(fadeTimeout);
    };
  }, [isLoading]);

  const handleAddFolder = async (newFolder) => {
    try {
      const result = await smartFoldersIpc.add(newFolder);
      if (!result?.success) {
        // The IPC handler returns a structured response when the proposed
        // name is canonically equivalent to an existing smart folder
        // (e.g. "Logos and Graphic Design" when "Logos" is already there).
        // Surface the existing folder's name explicitly so the user can
        // decide to use it instead of seeing a generic "Failed to add".
        if (result?.errorCode === 'FOLDER_NAME_EQUIVALENT' && result?.existingFolder?.name) {
          showWarning(
            `Smart folder "${result.existingFolder.name}" already covers this concept. ` +
              `Use the existing folder, or pick a more distinct name.`
          );
          return false;
        }
        showError(`Failed to add folder: ${result?.error || 'unknown error'}`);
        return false;
      }
      if (result.directoryCreated) {
        showSuccess(`Added smart folder and created directory: ${newFolder.name}`);
      } else if (result.directoryExisted) {
        showSuccess(`Added smart folder: ${newFolder.name} (directory already exists)`);
      } else {
        showSuccess(`Added smart folder: ${newFolder.name}`);
      }
      // Fire-and-forget list reload. A failed reload must NOT invalidate the
      // already-successful add — otherwise the modal stays open with a
      // misleading "Failed to add" error even though the folder is persisted.
      loadSmartFolders().catch((reloadError) => {
        logger.error('Smart folder list reload failed after add', {
          error: reloadError?.message,
          stack: reloadError?.stack
        });
        showWarning(
          'Folder added, but the list did not refresh. It will appear when you reopen this view.'
        );
      });
      return true;
    } catch (error) {
      logger.error('Failed to add smart folder', {
        error: error.message,
        stack: error.stack
      });
      showError('Failed to add smart folder');
      return false;
    }
  };

  const handleEditFolder = (folder) => {
    setEditingFolder({ ...folder });
    setExpandedFolders((prev) => new Set([...prev, folder.id]));
  };

  const handleSaveEdit = async () => {
    if (!editingFolder?.name?.trim()) {
      showWarning('Folder name cannot be empty');
      return;
    }
    setIsSavingEdit(true);
    try {
      const result = await smartFoldersIpc.edit(editingFolder.id, editingFolder);
      if (result.success) {
        showSuccess(`Updated folder: ${editingFolder.name}`);
        await loadSmartFolders();
        setEditingFolder(null);
      } else {
        showError(`Failed to update folder: ${result.error}`);
      }
    } catch (error) {
      logger.error('Failed to update folder', {
        error: error.message,
        stack: error.stack
      });
      showError('Failed to update folder');
    } finally {
      setIsSavingEdit(false);
    }
  };

  const handleCancelEdit = () => {
    setEditingFolder(null);
  };

  const handleDeleteFolder = async (folderId) => {
    const folder = smartFolders.find((f) => f.id === folderId);
    if (!folder) return;
    const confirmDelete = await showConfirm({
      title: 'Delete Smart Folder',
      message:
        'Are you sure you want to remove this smart folder from StratoSort? This will not delete the physical directory or its files.',
      confirmText: 'Remove folder',
      cancelText: 'Cancel',
      variant: 'danger',
      fileName: folder.name
    });
    if (!confirmDelete) return;
    setIsDeletingFolder(folderId);
    try {
      const result = await smartFoldersIpc.delete(folderId);
      if (result.success) {
        showSuccess(`Removed smart folder: ${result.deletedFolder?.name || folder.name}`);
        await loadSmartFolders();
      } else {
        showError(`Failed to delete folder: ${result.error}`);
      }
    } catch (error) {
      logger.error('Failed to delete folder', {
        error: error.message,
        stack: error.stack
      });
      showError('Failed to delete folder');
    } finally {
      setIsDeletingFolder(null);
    }
  };

  const handleOpenFolder = async (folderPath) => {
    try {
      const result = await filesIpc.openFolder(folderPath);
      if (result?.success) {
        showSuccess(`Opened folder: ${folderPath.split(/[\\/]/).pop()}`);
      } else {
        showError(`Failed to open folder: ${result?.error || 'Unknown error'}`);
      }
    } catch (error) {
      logger.error('Failed to open folder', {
        error: error.message,
        folderPath
      });
      showError('Failed to open folder');
    }
  };

  const handleResetToDefaults = async () => {
    const confirmReset = await showConfirm({
      title: 'Reset to default folders',
      message:
        'This replaces your smart folder list with the defaults: Documents, Images, Videos, Music, Spreadsheets, Presentations, Archives, and Uncategorized. ' +
        'StratoSort stores them directly under your Documents folder on this machine and creates those physical directories when missing. ' +
        'Your current smart folder configuration will be replaced. Continue?',
      confirmText: 'Reset',
      cancelText: 'Cancel',
      variant: 'warning'
    });
    if (!confirmReset) return;

    try {
      setIsLoading(true);
      const result = await smartFoldersIpc.resetToDefaults();
      if (result?.success) {
        const n = Array.isArray(result.folders) ? result.folders.length : null;
        showSuccess(
          n != null
            ? `Reset complete: ${n} default smart folders under Documents. Physical folders were created if they were missing.`
            : result.message || 'Smart folders reset to defaults'
        );
        await loadSmartFolders();
      } else {
        showError(`Failed to reset: ${result?.error || 'Unknown error'}`);
      }
    } catch (error) {
      logger.error('Failed to reset smart folders', {
        error: error.message,
        stack: error.stack
      });
      showError('Failed to reset smart folders');
    } finally {
      setIsLoading(false);
    }
  };

  const createSingleFolder = async (folderPath) => {
    try {
      const result = await filesIpc.createFolder(folderPath);
      if (!result?.success) {
        // The handler resolves rather than throws when the destination policy
        // refuses the parent (prompt declined, startup folder, unapproved
        // share) or mkdir fails, so the refusal lives in the envelope. Map the
        // code to its actionable copy; unmapped codes keep the handler message.
        const { message } = mapErrorToNotification({
          error: result?.error,
          errorCode: result?.errorCode
        });
        logger.warn('Folder creation refused', {
          folderPath,
          errorCode: result?.errorCode,
          error: result?.error
        });
        return { success: false, error: message, errorCode: result?.errorCode };
      }
      return { success: true };
    } catch (error) {
      logger.error('Failed to create folder', {
        error: error.message,
        folderPath
      });
      return { success: false, error: error.message };
    }
  };

  const handleToggleExpand = useCallback((folderId) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  }, []);

  const toggleViewMode = () => {
    setViewMode((prev) => (prev === 'compact' ? 'expanded' : 'compact'));
    if (viewMode === 'compact') {
      setExpandedFolders(new Set(smartFolders.map((f) => f.id)));
    } else {
      setExpandedFolders(new Set());
    }
  };

  const isCompactMode = viewMode === 'compact';
  const hasConfiguredFolders = smartFolders.length > 0;
  // Threshold past which the responsive smart-folder grid becomes
  // expensive to layout/paint (each card carries its own form, collapse
  // state, hover/motion, and icons). Rather than swap to a full
  // virtualized component — which breaks the 1-/2-/3-column grid and
  // loses in-place editing — we opt into the browser-native primitive
  // `content-visibility: auto` with a reserved `contain-intrinsic-size`
  // so offscreen items skip layout + paint work entirely.
  //
  // This costs nothing for the common case (<60 folders) and keeps
  // scrolling smooth for power users who configure hundreds.
  const SMART_FOLDER_VIRT_THRESHOLD = 60;
  const SMART_FOLDER_INTRINSIC_ROW_HEIGHT_PX = isCompactMode ? 140 : 280;
  const shouldVirtualizeFolders = smartFolders.length > SMART_FOLDER_VIRT_THRESHOLD;
  const virtItemStyle = shouldVirtualizeFolders
    ? {
        contentVisibility: 'auto',
        containIntrinsicSize: `${SMART_FOLDER_INTRINSIC_ROW_HEIGHT_PX}px`
      }
    : undefined;

  const updateListOverflow = useCallback(() => {
    const container = listContainerRef.current;
    if (!container) return;
    // Avoid sub-pixel rounding triggering a scrollbar when content fits.
    const overflow = Math.ceil(container.scrollHeight) - Math.ceil(container.clientHeight);
    const hasOverflow = overflow > 2;
    setIsListScrollable((prev) => (prev !== hasOverflow ? hasOverflow : prev));
  }, []);

  useLayoutEffect(() => {
    updateListOverflow();
  }, [updateListOverflow, smartFolders, viewMode, expandedFolders, editingFolder, contentVisible]);

  useEffect(() => {
    const container = listContainerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;

    let frameId;
    const observer = new ResizeObserver(() => {
      if (frameId) cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(updateListOverflow);
    });

    observer.observe(container);
    return () => {
      if (frameId) cancelAnimationFrame(frameId);
      observer.disconnect();
    };
  }, [updateListOverflow, smartFolders.length]);

  return (
    <div
      className="flex flex-col flex-1 min-h-0 gap-cozy lg:gap-relaxed pb-3"
      data-testid="phase-setup-content"
    >
      {/* Header */}
      <Stack className="text-center flex-shrink-0" gap="compact">
        <Heading as="h1" variant="display">
          Configure <span className="text-gradient">Smart Folders</span>
        </Heading>
        <Text variant="lead" className="max-w-xl mx-auto">
          Choose the trusted destinations StratoSort can suggest before anything moves.
        </Text>
      </Stack>

      <MinimizableGuideCard
        persistKey="setup_destinations_guide"
        guideLabel="setup guide"
        className="border border-stratosort-blue/18 bg-gradient-to-r from-system-gray-100/95 to-stratosort-blue/8"
        collapsedSummary={
          <Text variant="small" className="text-system-gray-700">
            {hasConfiguredFolders
              ? `${smartFolders.length} destination${smartFolders.length !== 1 ? 's' : ''} ready — expand for setup tips`
              : 'Add a destination to continue — expand for setup tips'}
          </Text>
        }
      >
        <div className="flex flex-col gap-default lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-2xl">
            <div className="flex flex-wrap gap-compact mb-3">
              <StatusBadge variant="info" size="sm">
                Recommended first step
              </StatusBadge>
              {hasConfiguredFolders ? (
                <StatusBadge variant="success" size="sm">
                  Ready for discovery
                </StatusBadge>
              ) : (
                <StatusBadge variant="warning" size="sm">
                  Add at least one destination
                </StatusBadge>
              )}
            </div>
            <Heading as="h2" variant="h5" className="mb-2">
              Start with a trusted set of destinations
            </Heading>
            <Text variant="small" className="text-system-gray-600">
              Most people begin with the default folder set, then refine categories later. You only
              need one destination to continue, and you review every suggested move before it
              happens.
            </Text>
            <Text variant="tiny" className="text-system-gray-500 mt-2">
              By default, folders are created directly under your user Documents directory. Paths
              are local to this machine; you can add custom locations or adjust defaults later in
              Settings.
            </Text>
          </div>
          <div className="min-w-[220px] rounded-2xl border border-border-soft/70 bg-system-gray-100/50 px-4 py-3">
            <Text variant="tiny" className="text-system-gray-500">
              Workflow readiness
            </Text>
            <Text variant="small" className="mt-1 font-medium text-system-gray-800">
              {hasConfiguredFolders
                ? `${smartFolders.length} destination${smartFolders.length !== 1 ? 's' : ''} ready`
                : 'Waiting for your first destination'}
            </Text>
            <Text variant="tiny" className="mt-1 text-system-gray-500">
              You can always come back and adjust these later.
            </Text>
          </div>
        </div>
      </MinimizableGuideCard>

      {/* Toolbar */}
      <Inline className="justify-between pt-2" gap="cozy">
        <Inline gap="compact">
          <Text variant="small" className="font-medium">
            {isLoading
              ? 'Loading...'
              : `${smartFolders.length} destination${smartFolders.length !== 1 ? 's' : ''}`}
          </Text>
          {/* F-204: what the watcher is doing with these folders (was silent). */}
          {!isLoading && <WatcherStatusLine folderCount={smartFolders.length} />}
          {smartFolders.length > 0 && (
            <Inline gap="compact" className="text-system-gray-500">
              <IconButton
                onClick={toggleViewMode}
                variant="ghost"
                size="sm"
                aria-label={isCompactMode ? 'Expand all folders' : 'Collapse all folders'}
                title={isCompactMode ? 'Expand all' : 'Collapse all'}
                icon={
                  isCompactMode ? (
                    <ChevronDown className="w-4 h-4" />
                  ) : (
                    <ChevronUp className="w-4 h-4" />
                  )
                }
              />
            </Inline>
          )}
        </Inline>

        <Inline gap="default">
          {smartFolders.length > 0 && (
            <Button onClick={handleResetToDefaults} variant="ghost" size="sm">
              <RotateCcw className="w-4 h-4 mr-1.5" />
              Reset to defaults
            </Button>
          )}
          <Button onClick={handleOpenAddModal} variant="primary" size="sm">
            <Plus className="w-4 h-4 mr-1.5" />
            Add folder
          </Button>
        </Inline>
      </Inline>

      {/* Folder list */}
      <div className="flex-1 min-h-0 relative">
        {showSkeletonLayer && (
          <div
            className={`transition-opacity [transition-duration:var(--motion-duration-fast)] [transition-timing-function:var(--motion-ease-standard)] ${
              isLoading ? 'opacity-100' : 'opacity-0 pointer-events-none absolute inset-0'
            }`}
            aria-hidden={!isLoading}
          >
            <SmartFolderSkeleton count={3} compact={isCompactMode} />
          </div>
        )}

        <div
          className={`transition-opacity [transition-duration:var(--motion-duration-fast)] [transition-timing-function:var(--motion-ease-standard)] ${
            contentVisible ? 'opacity-100' : 'opacity-0 pointer-events-none absolute inset-0'
          }`}
        >
          {smartFolders.length === 0 ? (
            <div
              data-testid="smart-folders-empty-state"
              className="flex flex-col items-center justify-center p-8 text-center"
            >
              <StateMessage
                icon={Folder}
                size="lg"
                title="No smart folders yet"
                description="Start with the default destinations or add one custom folder. You can refine the set after your first pass."
                action={
                  <Inline gap="default">
                    <Button onClick={handleResetToDefaults} variant="secondary" size="sm">
                      <RotateCcw className="w-4 h-4" />
                      Load defaults
                    </Button>
                    <Button onClick={handleOpenAddModal} variant="primary" size="sm">
                      <Plus className="w-4 h-4" />
                      Add custom folder
                    </Button>
                  </Inline>
                }
                contentClassName="max-w-md"
              />
            </div>
          ) : (
            <div
              ref={listContainerRef}
              data-testid="folder-list"
              className={`h-full px-1 pt-1 pb-3 ${
                isListScrollable
                  ? 'overflow-y-auto overflow-x-visible modern-scrollbar'
                  : 'overflow-visible'
              }`}
            >
              <div
                className={`grid grid-cols-1 ${
                  isCompactMode
                    ? 'md:grid-cols-2 gap-2.5 lg:gap-cozy'
                    : 'md:grid-cols-2 xl:grid-cols-3 gap-default lg:gap-5'
                }`}
              >
                {smartFolders.map((folder, index) => {
                  const folderKey = folderIdentity(folder);
                  const item = (
                    <SmartFolderItem
                      folder={folder}
                      index={index}
                      editingFolder={editingFolder}
                      setEditingFolder={setEditingFolder}
                      isSavingEdit={isSavingEdit}
                      isDeleting={isDeletingFolder === folder.id}
                      onSaveEdit={handleSaveEdit}
                      onCancelEdit={handleCancelEdit}
                      onEditStart={handleEditFolder}
                      onDeleteFolder={handleDeleteFolder}
                      onCreateDirectory={createSingleFolder}
                      onOpenFolder={handleOpenFolder}
                      addNotification={addNotification}
                      compact={isCompactMode}
                      isExpanded={expandedFolders.has(folder.id)}
                      onToggleExpand={handleToggleExpand}
                    />
                  );
                  if (!virtItemStyle) {
                    return React.cloneElement(item, { key: folderKey });
                  }
                  return (
                    <div key={folderKey} style={virtItemStyle}>
                      {item}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Footer navigation */}
      <ActionBar>
        <Button
          onClick={() => actions.advancePhase(PHASES?.WELCOME ?? 'welcome')}
          variant="secondary"
          size="md"
          className="w-full sm:w-auto min-w-[180px]"
        >
          Back
        </Button>
        <Button
          onClick={async () => {
            // The reload is a freshness check; if IPC fails, fall back to the
            // locally loaded folders rather than dying as an unhandled
            // rejection and leaving the primary CTA silently inert.
            let currentFolders;
            try {
              const reloadedFolders = await smartFoldersIpc.get();
              currentFolders = dedupeSmartFolders(reloadedFolders);
            } catch (error) {
              logger.warn('Smart folder reload failed; using locally loaded folders', {
                error: error?.message
              });
              currentFolders = dedupeSmartFolders(smartFolders);
            }

            if (currentFolders.length === 0) {
              showWarning('Please add at least one smart folder before continuing.');
            } else {
              actions.setPhaseData('smartFolders', currentFolders);
              setSmartFolders(currentFolders);
              actions.advancePhase(PHASES?.DISCOVER ?? 'discover');
            }
          }}
          variant="primary"
          size="md"
          className="w-full sm:w-auto min-w-[180px]"
          title={
            isLoading
              ? 'Loading setup data.'
              : !hasConfiguredFolders
                ? 'Add at least one destination to continue.'
                : undefined
          }
          disabled={isLoading || !hasConfiguredFolders}
        >
          {isLoading ? 'Loading...' : 'Continue to Discovery'}
        </Button>
      </ActionBar>

      {/* Add Folder Modal */}
      <AddSmartFolderModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        onAdd={handleAddFolder}
        defaultLocation={defaultLocation}
        isDefaultLocationLoaded={isDefaultLocationLoaded}
        existingFolders={smartFolders}
        showNotification={addNotification}
      />

      <ConfirmDialog />
    </div>
  );
}

export default SetupPhase;

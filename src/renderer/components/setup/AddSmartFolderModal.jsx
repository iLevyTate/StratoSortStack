import React, { useState, useCallback, useEffect, useMemo, useRef, useId } from 'react';
import PropTypes from 'prop-types';
import { useSelector } from 'react-redux';
import { Sparkles, FolderOpen } from 'lucide-react';
import { Button, Input, Textarea } from '../ui';
import { Text } from '../ui/Typography';
import Modal from '../ui/Modal';
import { Stack } from '../layout';
import { createLogger } from '../../../shared/logger';
import { filesIpc, smartFoldersIpc, llamaIpc } from '../../services/ipc';
import { selectRedactPaths } from '../../store/selectors';
import { mapErrorToNotification } from '../../utils/errorMapping';
import {
  validateSmartFolderName,
  namesAreEquivalent
} from '../../../shared/smartFolderNameValidation';

const logger = createLogger('AddSmartFolderModal');
const getPathSeparator = (path) => (path && path.includes('\\') ? '\\' : '/');

function AddSmartFolderModal({
  isOpen,
  onClose,
  onAdd,
  defaultLocation,
  existingFolders = [],
  showNotification,
  // Optional: when the modal is opened from a context that already knows the
  // intended folder name (e.g., the "5 invoices from Acme" suggestion banner),
  // seed the form with that name so the user doesn't have to retype.
  initialName = ''
}) {
  // PERF: Use memoized selector instead of inline Boolean coercion
  const redactPaths = useSelector(selectRedactPaths);
  const [folderName, setFolderName] = useState('');
  const [folderPath, setFolderPath] = useState('');
  const [description, setDescription] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [isGeneratingDescription, setIsGeneratingDescription] = useState(false);
  // Cold-load LLM init can be 10-20s; total inference on integrated graphics
  // can stretch past 30s. Three-phase progression so the modal stops looking
  // frozen on slow hardware:
  //   'loading'   first 3s — "Loading model…"
  //   'generating' 3-15s   — "Generating description…"
  //   'long-wait' 15s+     — banner reassures the user it's still working
  //                          and offers a Cancel escape hatch.
  const [genPhase, setGenPhase] = useState(null);
  const genPhaseTimerRef = useRef(null);
  const genLongWaitTimerRef = useRef(null);
  // Token that lets a Cancel click ignore the in-flight result. The backend
  // call cannot be aborted today (the IPC layer has no abort signal yet) but
  // we don't need to: we just stop applying the result to UI state.
  const genRequestIdRef = useRef(0);
  const [genFallbackHint, setGenFallbackHint] = useState(null);
  const isMountedRef = useRef(true);
  const formId = useId();
  const folderPathId = useId();

  // Pre-validate name on every keystroke so the user sees rejection reasons
  // (trailing dot, Windows reserved names, etc.) before they submit, matching
  // exactly what the server will accept. Empty name still disables the submit
  // button but is treated as "not yet typed" rather than an error.
  const nameValidation = useMemo(() => {
    if (!folderName.trim()) return { valid: false, error: null, warning: null };
    return validateSmartFolderName(folderName);
  }, [folderName]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (genPhaseTimerRef.current) {
        clearTimeout(genPhaseTimerRef.current);
        genPhaseTimerRef.current = null;
      }
      if (genLongWaitTimerRef.current) {
        clearTimeout(genLongWaitTimerRef.current);
        genLongWaitTimerRef.current = null;
      }
    };
  }, []);

  const resetForm = useCallback(() => {
    // Use the seeded name if a caller pre-filled it (e.g., from the
    // pattern-suggestion banner). Empty string otherwise — same as before.
    setFolderName(initialName || '');
    setFolderPath('');
    setDescription('');
    setIsGeneratingDescription(false);
  }, [initialName]);

  // Reset form state when modal opens to ensure a fresh form each time
  useEffect(() => {
    if (isOpen) {
      resetForm();
      // Fire-and-forget: warm the text model on open so "Generate with AI"
      // hits a warm model instead of paying the ~15s cold-load when clicked.
      // The call sits INSIDE the promise chain: llamaIpc.warm() throws
      // synchronously when the preload bridge is missing/stale
      // (requireElectronAPI), and a sync throw during argument evaluation
      // escapes a bare Promise.resolve(...).catch().
      void Promise.resolve()
        .then(() => llamaIpc?.warm?.())
        .catch(() => {});
    }
  }, [isOpen, resetForm]);

  const clearGenTimers = () => {
    if (genPhaseTimerRef.current) {
      clearTimeout(genPhaseTimerRef.current);
      genPhaseTimerRef.current = null;
    }
    if (genLongWaitTimerRef.current) {
      clearTimeout(genLongWaitTimerRef.current);
      genLongWaitTimerRef.current = null;
    }
  };

  const handleCancelGeneration = () => {
    // Invalidate the in-flight request so its result is ignored when it
    // eventually returns. The backend call still completes, but the user is
    // free to type their own description without the AI clobbering it.
    genRequestIdRef.current += 1;
    clearGenTimers();
    setIsGeneratingDescription(false);
    setGenPhase(null);
    setGenFallbackHint(null);
    showNotification?.('Description generation cancelled', 'info');
  };

  const handleGenerateDescription = async () => {
    if (!folderName.trim()) {
      showNotification?.('Please enter a folder name first', 'warning');
      return;
    }
    setGenFallbackHint(null);
    setIsGeneratingDescription(true);
    setGenPhase('loading');

    const requestId = ++genRequestIdRef.current;
    clearGenTimers();
    genPhaseTimerRef.current = setTimeout(() => {
      if (isMountedRef.current && genRequestIdRef.current === requestId) {
        setGenPhase('generating');
      }
    }, 3000);
    // Slow-hardware reassurance: integrated-GPU machines can sit at 30s+
    // on a cold-loaded text model. Without this, the modal just looks frozen.
    genLongWaitTimerRef.current = setTimeout(() => {
      if (isMountedRef.current && genRequestIdRef.current === requestId) {
        setGenPhase('long-wait');
      }
    }, 15000);

    try {
      const result = await smartFoldersIpc.generateDescription(folderName.trim());
      // Late return after Cancel — abandon silently.
      if (!isMountedRef.current || genRequestIdRef.current !== requestId) return;
      if (result?.success && result.description) {
        setDescription(result.description);
        if (result.fallback) {
          // Backend used the template path. Don't drop the user into "Why
          // does my description look generic?" — explain it inline.
          setGenFallbackHint(
            "AI was unavailable or too slow — used a template description. Edit it to fit what's actually in this folder."
          );
          showNotification?.('Template description used (AI unavailable)', 'info');
        } else {
          setGenFallbackHint(null);
          showNotification?.('Description generated', 'success');
        }
      } else {
        const msg = result?.error || 'Failed to generate description';
        if (/timed out/i.test(msg)) {
          setGenFallbackHint(
            'AI took too long. Try again, or type a description manually — even a short one works.'
          );
        }
        showNotification?.(msg, 'error');
      }
    } catch (err) {
      if (genRequestIdRef.current !== requestId) return; // ignore late errors after cancel
      logger.error('Failed to generate description', { error: err.message });
      if (isMountedRef.current) {
        const { message, severity } = mapErrorToNotification({
          error: err.message,
          operationType: 'Description generation'
        });
        showNotification?.(message, severity);
      }
    } finally {
      if (genRequestIdRef.current === requestId) {
        clearGenTimers();
        if (isMountedRef.current) {
          setIsGeneratingDescription(false);
          setGenPhase(null);
        }
      }
    }
  };

  const handleClose = useCallback(() => {
    resetForm();
    onClose();
  }, [onClose, resetForm]);

  const handleBrowse = async () => {
    try {
      const res = await filesIpc.selectDirectory({ purpose: 'destination' });
      if (res?.success && res.path) {
        if (isMountedRef.current) {
          setFolderPath(res.path);
        }
      }
    } catch (error) {
      logger.error('Failed to browse folder', { error: error.message });
      if (isMountedRef.current) {
        showNotification?.('Failed to browse folder', 'error');
      }
    }
  };

  const handleSubmit = async (e) => {
    e?.preventDefault();

    // Defense in depth: the submit button is also disabled while invalid,
    // but keep an explicit guard in case the form is submitted via keyboard
    // shortcut on a stale state.
    if (!nameValidation.valid) {
      showNotification?.(nameValidation.error || 'Please enter a folder name', 'warning');
      return;
    }
    const validatedName = nameValidation.sanitizedName;

    const isAbsolutePath = (p) =>
      /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/') || /^[\\/]{2}[^\\/]/.test(p);

    let targetPath = folderPath.trim();
    if (!targetPath) {
      if (!defaultLocation || typeof defaultLocation !== 'string') {
        showNotification?.(
          'Unable to determine folder location. Please browse to select a folder.',
          'error'
        );
        return;
      }
      let resolvedDefaultLocation = defaultLocation;
      if (!isAbsolutePath(defaultLocation)) {
        try {
          const documentsPath = await filesIpc.getDocumentsPath();
          if (documentsPath) {
            resolvedDefaultLocation =
              typeof documentsPath === 'string'
                ? documentsPath
                : documentsPath.path || documentsPath;
          }
        } catch (err) {
          logger.warn('Failed to fetch documents path', { error: err.message });
        }
      }

      if (!isAbsolutePath(resolvedDefaultLocation)) {
        showNotification?.(
          'Unable to determine folder location. Please browse to select a folder.',
          'error'
        );
        return;
      }

      const sep = getPathSeparator(resolvedDefaultLocation);
      targetPath = `${resolvedDefaultLocation}${sep}${validatedName}`;
    }

    if (!isAbsolutePath(targetPath)) {
      showNotification?.(
        'Unable to determine folder location. Please browse to select a folder.',
        'error'
      );
      return;
    }

    const existing = existingFolders.find(
      (f) =>
        f.name.toLowerCase() === validatedName.toLowerCase() ||
        (f.path && f.path.toLowerCase() === targetPath.toLowerCase())
    );
    if (existing) {
      showNotification?.(`A smart folder with this name or path already exists`, 'warning');
      return;
    }

    // Token-subset equivalence check — mirrors the FOLDER_NAME_EQUIVALENT
    // guard in the IPC handler so the user gets feedback before the round
    // trip. If the equivalent folder is the same as the exact-match check
    // above we skip — that case is already handled. We name the conflict
    // explicitly so the user knows WHICH existing folder collides.
    const equivalentExisting = existingFolders.find(
      (f) =>
        f.name &&
        f.name.toLowerCase() !== validatedName.toLowerCase() &&
        namesAreEquivalent(f.name, validatedName)
    );
    if (equivalentExisting) {
      showNotification?.(
        `Smart folder "${equivalentExisting.name}" already covers this concept. ` +
          `Use the existing folder, or choose a more distinct name.`,
        'warning'
      );
      return;
    }

    setIsAdding(true);
    try {
      const newFolder = {
        name: validatedName,
        path: targetPath,
        description: description.trim() || `Smart folder for ${validatedName}`,
        isDefault: false
      };

      const success = await onAdd(newFolder);
      if (success) {
        handleClose();
      }
    } catch (err) {
      logger.error('Failed to add smart folder', { error: err.message });
      if (isMountedRef.current) {
        const { message, severity } = mapErrorToNotification({
          error: err.message,
          operationType: 'Smart folder creation'
        });
        showNotification?.(message, severity);
      }
    } finally {
      if (isMountedRef.current) {
        setIsAdding(false);
      }
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Add Smart Folder"
      size="md"
      closeOnOverlayClick={!isAdding}
      closeOnEsc={!isAdding}
      closeDisabled={isAdding}
      footer={
        <>
          <Button
            type="button"
            onClick={handleClose}
            variant="secondary"
            size="sm"
            disabled={isAdding}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            size="sm"
            disabled={!nameValidation.valid || isAdding}
            isLoading={isAdding}
          >
            {isAdding ? 'Adding...' : 'Add folder'}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={handleSubmit}>
        <Stack gap="relaxed">
          <div>
            {/* eslint-disable jsx-a11y/no-autofocus -- deliberate initial focus per WAI-ARIA dialog pattern */}
            <Input
              label="Folder name"
              type="text"
              value={folderName}
              onChange={(e) => setFolderName(e.target.value)}
              placeholder="e.g., Documents, Photos, Projects"
              className="w-full"
              autoFocus
              required
              error={nameValidation.error || ''}
            />
            {/* eslint-enable jsx-a11y/no-autofocus */}
            {nameValidation.valid && nameValidation.warning && (
              <Text
                variant="small"
                className="mt-1 text-stratosort-warning"
                role="status"
                aria-live="polite"
              >
                {nameValidation.warning}
              </Text>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Text
              as="label"
              htmlFor={folderPathId}
              variant="small"
              className="block font-medium text-system-gray-700"
            >
              Target path <span className="text-system-gray-400 font-normal ml-1">(optional)</span>
            </Text>
            <div className="flex gap-compact">
              <Input
                id={folderPathId}
                aria-label="Target path"
                type={redactPaths ? 'password' : 'text'}
                value={folderPath}
                onChange={(e) => setFolderPath(e.target.value)}
                placeholder={
                  redactPaths
                    ? `…${getPathSeparator(defaultLocation)}${folderName || 'FolderName'}`
                    : `${defaultLocation}${getPathSeparator(defaultLocation)}${folderName || 'FolderName'}`
                }
                className="flex-1"
              />
              <Button
                type="button"
                onClick={handleBrowse}
                variant="secondary"
                size="sm"
                title="Browse for folder"
                className="shrink-0"
              >
                <FolderOpen className="w-4 h-4" />
                Browse
              </Button>
            </div>
          </div>

          <div className="relative">
            <div className="flex items-center justify-between mb-1.5">
              <Text as="label" variant="small" className="block font-medium text-system-gray-700">
                Description{' '}
                <span className="text-stratosort-blue font-medium ml-1">(AI uses this)</span>
              </Text>
              <div className="flex items-center gap-compact">
                {isGeneratingDescription && (
                  <Button
                    type="button"
                    onClick={handleCancelGeneration}
                    variant="ghost"
                    size="sm"
                    className="text-system-gray-500 hover:text-system-gray-700"
                    title="Stop generating and write your own"
                  >
                    Cancel
                  </Button>
                )}
                <Button
                  type="button"
                  onClick={handleGenerateDescription}
                  disabled={isGeneratingDescription || !folderName.trim()}
                  isLoading={isGeneratingDescription}
                  variant="subtle"
                  size="sm"
                  leftIcon={!isGeneratingDescription ? <Sparkles className="w-4 h-4" /> : null}
                  className="text-stratosort-blue bg-stratosort-blue/10 border-stratosort-blue/20 hover:bg-stratosort-blue/20"
                >
                  {!isGeneratingDescription
                    ? 'Generate with AI'
                    : genPhase === 'loading'
                      ? 'Loading model…'
                      : genPhase === 'long-wait'
                        ? 'Still working…'
                        : 'Generating description…'}
                </Button>
              </div>
            </div>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe what types of files should go here..."
              className="w-full"
              rows={3}
            />
            {/* Inline status — only present during an active generation. The
                long-wait variant explicitly explains why nothing seems to be
                happening on integrated-GPU machines so the user doesn't
                assume the modal has hung. */}
            {isGeneratingDescription && (
              <div
                role="status"
                aria-live="polite"
                className={[
                  'mt-2 flex items-start gap-compact rounded-md border px-3 py-2 text-xs',
                  genPhase === 'long-wait'
                    ? 'border-amber-200 bg-amber-50 text-amber-800'
                    : 'border-stratosort-blue/20 bg-stratosort-blue/5 text-stratosort-blue'
                ].join(' ')}
              >
                <Sparkles className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
                <span className="leading-relaxed">
                  {genPhase === 'loading'
                    ? 'Loading the language model into memory…'
                    : genPhase === 'long-wait'
                      ? "Still working — this can take up to a minute on machines without a dedicated GPU. You can cancel and type a description yourself if you'd prefer."
                      : 'Generating description from your folder name…'}
                </span>
              </div>
            )}
            {!isGeneratingDescription && genFallbackHint && (
              <div
                role="status"
                className="border-amber-200 bg-amber-50 text-amber-800 mt-2 flex items-start gap-compact rounded-md border px-3 py-2 text-xs"
              >
                <Sparkles className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
                <span className="leading-relaxed">{genFallbackHint}</span>
              </div>
            )}
          </div>
        </Stack>
      </form>
    </Modal>
  );
}

AddSmartFolderModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onAdd: PropTypes.func.isRequired,
  defaultLocation: PropTypes.string.isRequired,
  existingFolders: PropTypes.array,
  showNotification: PropTypes.func,
  initialName: PropTypes.string
};

export default AddSmartFolderModal;

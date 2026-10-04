// @ts-check
import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { logger } from '../../../shared/logger';
import { serializeData } from '../../utils/serialization';
import { smartFoldersIpc } from '../../services/ipc';
import { BOOTSTRAP_IPC_OPTIONS, runIpcWithTimeoutRetry } from '../ipcTimeout';
import { toCanonicalPath } from '../../utils/canonicalPath';
import {
  collectOrganizedPathKeys,
  mergeOrganizedPathIndex,
  removeFromOrganizedPathIndex
} from '../../utils/organizedPathIndex';

// Thunk to fetch smart folders with optional cache bypass
export const fetchSmartFolders = createAsyncThunk(
  'files/fetchSmartFolders',
  async (/** @type {boolean | undefined} */ arg, { getState, rejectWithValue }) => {
    const forceRefresh = arg === true;
    const { files } = /** @type {any} */ (getState());
    // Return cached value if already fetched (even if empty) and not forcing refresh
    if (!forceRefresh && files.smartFoldersLoaded) {
      return files.smartFolders;
    }
    try {
      // Bootstrap retries: a cold main process (or memory-starved host) routinely
      // exceeds a single 10s race even though the handler succeeds moments later.
      // Without retries the renderer latches a sticky "IPC timeout" degraded banner.
      const folders = await runIpcWithTimeoutRetry(
        () => smartFoldersIpc.get(),
        BOOTSTRAP_IPC_OPTIONS
      );
      return Array.isArray(folders) ? folders : [];
    } catch (error) {
      logger.error('[filesSlice] Failed to fetch smart folders', { error: error?.message });
      return rejectWithValue(error?.message || 'Failed to load smart folders');
    }
  }
);

// Thunk to invalidate and refetch smart folders
// Call this when smart folders are modified (added, removed, or edited)
export const invalidateSmartFolders = createAsyncThunk(
  'files/invalidateSmartFolders',
  async (_, { dispatch, rejectWithValue }) => {
    // Force a refresh by dispatching fetchSmartFolders with forceRefresh=true.
    // Propagate the inner thunk's rejection so callers using .unwrap() see it.
    // Without this check the outer thunk fulfilled even when the fetch failed,
    // handing callers an "error-shaped success" payload.
    const result = /** @type {any} */ (await dispatch(fetchSmartFolders(true)));
    if (result.meta.requestStatus === 'rejected') {
      return rejectWithValue(
        result.payload || result.error?.message || 'Failed to refresh smart folders'
      );
    }
    return result.payload;
  }
);

// Helper to serialize file objects - converts Date to ISO string for Redux compatibility
// REPLACED by shared serializeData utility

// fileStates entries carry lifecycle metadata only (state, name, size,
// timestamps, error). The heavy `analysis` payload (extractedText et al.) is
// owned canonically by analysisSlice.results; a second copy here doubled the
// in-memory footprint scanned by the dev ImmutableStateInvariantMiddleware and
// the persisted localStorage payload, and is never read back (display reads
// `file.analysis` from results, and OrganizePhase reconstructs fileStates FROM
// results). So every fileStates write drops it.
function stripAnalysisPayload(/** @type {any} */ entry) {
  if (!entry || typeof entry !== 'object' || !('analysis' in entry)) return entry;
  /** @type {Record<string, any>} */
  const rest = {};
  for (const key of Object.keys(entry)) {
    if (key !== 'analysis') rest[key] = entry[key];
  }
  return rest;
}

function stripAnalysisFromMap(/** @type {any} */ map) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return {};
  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, value] of Object.entries(map)) {
    out[key] = stripAnalysisPayload(value);
  }
  return out;
}

/** @type {any} */
const initialState = {
  selectedFiles: [], // Array of file objects
  smartFolders: [], // Array of configured smart folders
  smartFoldersLoaded: false, // Whether smart folders have been fetched at least once
  smartFoldersLoading: false, // Loading state for smart folders
  smartFoldersError: null,
  organizedFiles: [], // History of organized files (rich UI; persistence-capped)
  // Compact durable path keys (original + destination). Survives the
  // organizedFiles persistence cap so Discover does not resurrect moved files.
  organizedPathIndex: [],
  fileStates: {}, // Map of path -> state (pending, analyzing, ready, error)
  namingConvention: {
    convention: 'subject-date',
    dateFormat: 'YYYY-MM-DD',
    caseConvention: 'kebab-case',
    separator: '-'
  }
};

const filesSlice = createSlice({
  name: 'files',
  initialState,
  reducers: {
    setSelectedFiles: (state, action) => {
      state.selectedFiles = serializeData(action.payload);
    },
    addSelectedFiles: (state, action) => {
      // Filter duplicates (against the queue and within the batch) using
      // canonical path comparison (case-insensitive on Windows)
      const seenCanonical = new Set(
        state.selectedFiles.map((/** @type {any} */ f) => toCanonicalPath(f?.path))
      );
      const newFiles = serializeData(action.payload).filter((/** @type {any} */ newFile) => {
        const key = toCanonicalPath(newFile?.path);
        if (seenCanonical.has(key)) return false;
        seenCanonical.add(key);
        return true;
      });
      state.selectedFiles = [...state.selectedFiles, ...newFiles];
    },
    removeSelectedFile: (state, action) => {
      const canonicalPayload = toCanonicalPath(action.payload);
      state.selectedFiles = state.selectedFiles.filter(
        (/** @type {any} */ f) => toCanonicalPath(f?.path) !== canonicalPayload
      );
      // Also cleanup file state (check both raw and canonical keys)
      Object.keys(state.fileStates).forEach((statePath) => {
        if (toCanonicalPath(statePath) === canonicalPayload) {
          delete state.fileStates[statePath];
        }
      });
    },
    removeSelectedFiles: (state, action) => {
      if (!Array.isArray(action.payload)) return;
      const pathsToRemove = new Set(action.payload.map(toCanonicalPath).filter(Boolean));
      state.selectedFiles = state.selectedFiles.filter(
        (/** @type {any} */ f) => !pathsToRemove.has(toCanonicalPath(f?.path))
      );
      // Batch cleanup file states
      Object.keys(state.fileStates).forEach((statePath) => {
        if (pathsToRemove.has(toCanonicalPath(statePath))) {
          delete state.fileStates[statePath];
        }
      });
    },
    updateFileState: (state, action) => {
      const { path, state: fileState, metadata, timestamp } = action.payload || {};
      if (typeof path !== 'string' || path.length === 0) return;
      const safeMetadata = stripAnalysisPayload(serializeData(metadata));
      // Reuse a canonically-equal existing key so one file never holds two
      // entries when IPC events report a different casing/separator style
      // than the original selection (lookups elsewhere use the selected
      // file's raw path, which matches the first-seen key).
      // Fast path: when `path` is already a stored key (the common case — a
      // file cycles discovering -> analyzing -> done under the same path),
      // reuse it in O(1) and skip the O(n) canonical scan. That scan only
      // exists to dedupe a key recorded with different casing/separators, which
      // can only occur when the exact key is absent. This turns a per-session
      // O(n^2) into ~O(n) without changing which key gets written.
      let existingKey = path;
      if (state.fileStates[path] === undefined) {
        const canonical = toCanonicalPath(path);
        existingKey = Object.keys(state.fileStates).find(
          (statePath) => toCanonicalPath(statePath) === canonical
        );
      }
      state.fileStates[existingKey || path] = {
        ...safeMetadata,
        state: fileState,
        timestamp: timestamp || new Date().toISOString()
      };
    },
    setFileStates: (state, action) => {
      state.fileStates = stripAnalysisFromMap(action.payload);
    },
    mergeFileStates: (state, action) => {
      if (!action.payload || typeof action.payload !== 'object') return;
      // Merge under canonically-deduped keys (same rationale as
      // updateFileState): a hydration payload keyed with different
      // casing/separators must update the existing entry, not duplicate it.
      const merged = { ...state.fileStates };
      const canonicalToKey = new Map(
        Object.keys(merged).map((statePath) => [toCanonicalPath(statePath), statePath])
      );
      for (const [incomingPath, stateInfo] of Object.entries(serializeData(action.payload))) {
        const existingKey = canonicalToKey.get(toCanonicalPath(incomingPath));
        merged[existingKey || incomingPath] = stripAnalysisPayload(stateInfo);
        if (!existingKey) {
          canonicalToKey.set(toCanonicalPath(incomingPath), incomingPath);
        }
      }
      state.fileStates = merged;
    },
    setSmartFolders: (state, action) => {
      state.smartFolders = action.payload;
    },
    addSmartFolder: (state, action) => {
      state.smartFolders.push(action.payload);
    },
    setOrganizedFiles: (state, action) => {
      const next = serializeData(action.payload);
      state.organizedFiles = next;
      // Merge, don't replace: callers may pass a truncated rich-history tail
      // (persistence / repair) while the compact index must keep older paths.
      state.organizedPathIndex = mergeOrganizedPathIndex(
        state.organizedPathIndex,
        collectOrganizedPathKeys(next)
      );
    },
    addOrganizedFiles: (state, action) => {
      const newFiles = serializeData(action.payload);
      const existingOriginals = new Set(
        state.organizedFiles.map((/** @type {any} */ f) => toCanonicalPath(f?.originalPath))
      );
      // Skip re-appends for the same source path so Complete/Organize lists do
      // not double-render rows (and React keys) after redo or double IPC ack.
      const uniqueNew = newFiles.filter((/** @type {any} */ f) => {
        const key = toCanonicalPath(f?.originalPath);
        if (!key) return true;
        if (existingOriginals.has(key)) return false;
        existingOriginals.add(key);
        return true;
      });
      if (uniqueNew.length === 0) return;
      state.organizedFiles = [...state.organizedFiles, ...uniqueNew];
      state.organizedPathIndex = mergeOrganizedPathIndex(
        state.organizedPathIndex,
        collectOrganizedPathKeys(uniqueNew)
      );
    },
    removeOrganizedFiles: (state, action) => {
      if (!Array.isArray(action.payload)) return;
      const isWinPath = (/** @type {any} */ p) => p && (p.includes('\\') || /^[A-Za-z]:/.test(p));
      const normalize = (/** @type {any} */ p) => {
        const n = (p || '').replace(/[\\/]+/g, '/');
        return isWinPath(p) ? n.toLowerCase() : n;
      };
      const pathsToRemove = new Set(action.payload.map(normalize));
      const removedEntries = state.organizedFiles.filter((/** @type {any} */ file) =>
        pathsToRemove.has(normalize(file.originalPath))
      );

      state.organizedFiles = state.organizedFiles.filter(
        (/** @type {any} */ file) => !pathsToRemove.has(normalize(file.originalPath))
      );
      state.organizedPathIndex = removeFromOrganizedPathIndex(
        state.organizedPathIndex,
        collectOrganizedPathKeys(removedEntries)
      );
    },
    // Explicit re-selection is intent: a fresh Downloads\invoice.pdf after the
    // old one was organized (or a re-dropped destination) must re-enter the
    // active queue. Only the re-selected keys leave the durable index — the
    // other side of the move stays organized — but the rich history row is
    // dropped like undo does, because Organize derives its processed set from it.
    releaseOrganizedPaths: (state, action) => {
      if (!Array.isArray(action.payload)) return;
      const released = new Set(action.payload.map(toCanonicalPath).filter(Boolean));
      if (released.size === 0) return;
      state.organizedFiles = state.organizedFiles.filter(
        (/** @type {any} */ entry) =>
          !collectOrganizedPathKeys([entry]).some((key) => released.has(key))
      );
      state.organizedPathIndex = removeFromOrganizedPathIndex(
        state.organizedPathIndex,
        Array.from(released)
      );
    },
    setNamingConvention: (state, action) => {
      state.namingConvention = { ...state.namingConvention, ...action.payload };
    },
    clearFiles: (state) => {
      state.selectedFiles = [];
      state.fileStates = {};
    },
    resetFilesState: (state) => ({
      ...initialState,
      smartFolders: state.smartFolders,
      smartFoldersLoaded: state.smartFoldersLoaded,
      smartFoldersLoading: state.smartFoldersLoading,
      smartFoldersError: state.smartFoldersError,
      organizedPathIndex: Array.isArray(state.organizedPathIndex) ? state.organizedPathIndex : []
    }),
    // This ensures Redux state stays in sync with actual file locations
    updateFilePathsAfterMove: (state, action) => {
      const { oldPaths, newPaths } = action.payload;
      if (!Array.isArray(oldPaths) || !Array.isArray(newPaths)) return;

      // Enforce atomicity: never perform partial path remaps.
      if (oldPaths.length !== newPaths.length) {
        logger.error('[filesSlice] updateFilePathsAfterMove: array length mismatch, skipping', {
          oldPathsLength: oldPaths.length,
          newPathsLength: newPaths.length,
          action: 'no-op to preserve state consistency'
        });
        return;
      }

      // Create path mapping only after payload validation passes.
      /** @type {Record<string, string>} */
      const pathMap = {};
      for (let i = 0; i < oldPaths.length; i++) {
        const oldKey = toCanonicalPath(oldPaths[i]);
        if (oldKey) {
          pathMap[oldKey] = newPaths[i];
        }
      }

      // Remap selectedFiles, then collapse any destination collisions.
      // Example: Downloads\notes.pdf remaps onto Research\notes.pdf while that
      // destination is already in the selection → two rows, same React key.
      const remappedSelected = state.selectedFiles.map((/** @type {any} */ file) => {
        const newPath = pathMap[toCanonicalPath(file?.path)];
        if (newPath) {
          return {
            ...file,
            path: newPath,
            name: newPath.split(/[\\/]/).pop() || file.name
          };
        }
        return file;
      });
      const seenSelected = new Set();
      state.selectedFiles = remappedSelected.filter((/** @type {any} */ file) => {
        const key = toCanonicalPath(file?.path);
        if (!key) return true;
        if (seenSelected.has(key)) return false;
        seenSelected.add(key);
        return true;
      });

      // First pass: identify all moves
      /** @type {Set<string>} */
      const oldKeysToRemove = new Set();
      /** @type {Record<string, any>} */
      const newEntriesToAdd = {};

      Object.keys(state.fileStates).forEach((pathKey) => {
        const newPath = pathMap[toCanonicalPath(pathKey)];
        if (newPath && newPath !== pathKey) {
          oldKeysToRemove.add(pathKey);
          newEntriesToAdd[newPath] = { ...state.fileStates[pathKey], path: newPath };
        }
      });

      // Second pass: apply moves safely without iterative deletion
      /** @type {Record<string, any>} */
      const updatedFileStates = {};
      Object.keys(state.fileStates).forEach((pathKey) => {
        if (!oldKeysToRemove.has(pathKey)) {
          updatedFileStates[pathKey] = state.fileStates[pathKey];
        }
      });

      Object.assign(updatedFileStates, newEntriesToAdd);
      state.fileStates = updatedFileStates;

      // Update organizedFiles if present
      state.organizedFiles = state.organizedFiles.map((/** @type {any} */ file) => {
        if (!file) return file; // Skip null/undefined entries
        const newPath =
          (file.originalPath && pathMap[toCanonicalPath(file.originalPath)]) ||
          (file.path && pathMap[toCanonicalPath(file.path)]);
        if (newPath) {
          return {
            ...file,
            currentPath: newPath,
            path: newPath
          };
        }
        return file;
      });

      // The durable index is owned only by addOrganizedFiles / removeOrganizedFiles
      // (and setOrganizedFiles merge). Remapping destinations here after undo would
      // re-insert the restored original path and hide the file from every queue.
    }
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchSmartFolders.pending, (state) => {
        state.smartFoldersLoading = true;
        state.smartFoldersError = null;
      })
      .addCase(fetchSmartFolders.fulfilled, (state, action) => {
        state.smartFolders = action.payload;
        state.smartFoldersLoaded = true;
        state.smartFoldersLoading = false;
        state.smartFoldersError = null;
      })
      .addCase(fetchSmartFolders.rejected, (state, action) => {
        // Only log the error, don't clear the array
        state.smartFoldersLoading = false;
        state.smartFoldersError =
          action.payload || action.error?.message || 'Failed to load smart folders';
      });
  }
});

export const {
  setSelectedFiles,
  addSelectedFiles,
  removeSelectedFile,
  removeSelectedFiles,
  updateFileState,
  setFileStates,
  mergeFileStates,
  setSmartFolders,
  addSmartFolder,
  setOrganizedFiles,
  setNamingConvention,
  clearFiles,
  resetFilesState,
  updateFilePathsAfterMove,
  addOrganizedFiles,
  removeOrganizedFiles,
  releaseOrganizedPaths
} = filesSlice.actions;

// The actual implementations are in atomicActions.js which properly imports from both slices
export { atomicUpdateFilePathsAfterMove, atomicRemoveFilesWithCleanup } from './atomicActions';

export default filesSlice.reducer;

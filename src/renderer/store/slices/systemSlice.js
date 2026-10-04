// @ts-check
import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { serializeData } from '../../utils/serialization';
import { filesIpc, systemIpc } from '../../services/ipc';
import { runIpcWithTimeoutRetry } from '../ipcTimeout';

let notificationSeq = 0;
const generateNotificationId = () => {
  notificationSeq = (notificationSeq + 1) % 1000;
  return `${Date.now().toString(36)}-${notificationSeq.toString(36)}`;
};

// Normalize the documents path returned from IPC to a plain string.
// Some IPC implementations return { success, path }, while others return the
// string path directly. We only want to store the path string in Redux.
const normalizeDocumentsPath = (/** @type {any} */ value) => {
  if (!value) return 'Documents';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof value.path === 'string') {
    return value.path;
  }
  return 'Documents';
};

// Thunk to fetch documents path (only once)
export const fetchDocumentsPath = createAsyncThunk(
  'system/fetchDocumentsPath',
  async (/** @type {boolean | undefined} */ arg, { getState, rejectWithValue }) => {
    const forceRefresh = arg === true;
    const { system } = /** @type {any} */ (getState());
    // Return cached value only after a successful load
    if (!forceRefresh && system.documentsPathLoaded) {
      return system.documentsPath;
    }
    try {
      const path = await runIpcWithTimeoutRetry(() => filesIpc.getDocumentsPath());
      return normalizeDocumentsPath(path);
    } catch (error) {
      return rejectWithValue(error?.message || 'Failed to load documents path');
    }
  }
);

// Thunk to poll degraded-state flags raised by main-process subsystems.
// Returns the full snapshot so the slice can replace its local view; this keeps
// the reducer idempotent and lets dismissals round-trip through the tracker.
export const fetchDegradedState = createAsyncThunk(
  'system/fetchDegradedState',
  async (_arg, { rejectWithValue }) => {
    try {
      const result = await runIpcWithTimeoutRetry(() => systemIpc.getDegradedState());
      const flags = Array.isArray(result?.flags) ? result.flags : [];
      return flags;
    } catch (error) {
      return rejectWithValue(error?.message || 'Failed to load degraded state');
    }
  }
);

export const dismissDegradedFlag = createAsyncThunk(
  'system/dismissDegradedFlag',
  async (code, { rejectWithValue }) => {
    if (typeof code !== 'string' || !code) {
      return rejectWithValue('Missing flag code');
    }
    try {
      await systemIpc.dismissDegradedFlag(code);
      return code;
    } catch (error) {
      return rejectWithValue(error?.message || 'Failed to dismiss flag');
    }
  }
);

// Thunk to fetch privacy flag for UI path redaction (only once)
export const fetchRedactPaths = createAsyncThunk(
  'system/fetchRedactPaths',
  async (/** @type {boolean | undefined} */ arg, { getState, rejectWithValue }) => {
    const forceRefresh = arg === true;
    const { system } = /** @type {any} */ (getState());
    // Return cached value only after a successful load
    if (!forceRefresh && system.redactPathsLoaded) {
      return system.redactPaths;
    }
    try {
      const value = await runIpcWithTimeoutRetry(() =>
        systemIpc.getConfigValue('FEATURES.redactPaths')
      );
      return Boolean(value);
    } catch (error) {
      return rejectWithValue(error?.message || 'Failed to load redactPaths flag');
    }
  }
);

/**
 * Notification status constants (mirrors shared/notificationTypes.js)
 */
const NotificationStatus = {
  PENDING: 'pending',
  DISPLAYED: 'displayed',
  SEEN: 'seen',
  DISMISSED: 'dismissed'
};

/** @type {any} */
const initialState = {
  metrics: {
    cpu: 0,
    memory: 0,
    uptime: 0
  },
  health: {
    // Vector DB (Orama) is in-process, always online after initialization
    vectorDb: 'online',
    // LLM (node-llama-cpp) is in-process, always online after initialization
    llama: 'online'
  },
  notifications: [],
  // Track unread count for UI badge
  unreadNotificationCount: 0,
  version: '1.0.0',
  documentsPath: null, // Cached documents path
  documentsPathLoaded: false,
  documentsPathLoading: false,
  documentsPathError: null,
  // Privacy / recording mode flags
  redactPaths: null, // null = unknown/unfetched, boolean once loaded
  redactPathsLoaded: false,
  redactPathsLoading: false,
  redactPathsError: null,
  // Degraded-state flags raised by main-process subsystems. Populated by
  // fetchDegradedState(); individual flags are shaped like DegradedFlag in
  // src/main/services/DegradedStateTracker.js.
  degradedFlags: [],
  degradedFlagsLoaded: false,
  degradedFlagsError: null
};

const systemSlice = createSlice({
  name: 'system',
  initialState,
  reducers: {
    updateMetrics: (state, action) => {
      const payload = action.payload || {};
      const changed = Object.keys(payload).some((key) => state.metrics[key] !== payload[key]);
      if (changed) {
        state.metrics = { ...state.metrics, ...payload };
      }
    },
    updateHealth: (state, action) => {
      // Defensive null-guard mirroring updateMetrics. ipcMiddleware now
      // dispatches this from vectorDb.onStatusChanged events, so a malformed
      // status push would crash the reducer with `Object.keys(null)`. The
      // Zod validation in front of the event makes this unlikely in prod,
      // but matching the pattern in updateMetrics keeps the contract
      // consistent.
      const payload = action.payload || {};
      const changed = Object.keys(payload).some((key) => state.health[key] !== payload[key]);
      if (changed) {
        state.health = { ...state.health, ...payload };
      }
    },
    addNotification: (state, action) => {
      // Prune stale notifications: remove seen/dismissed entries older than 1 hour.
      // This prevents the list from filling up with items the user already handled.
      const STALE_THRESHOLD_MS = 60 * 60 * 1000;
      const cutoffIso = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();
      const beforeLen = state.notifications.length;
      state.notifications = state.notifications.filter((/** @type {any} */ n) => {
        if (n.timestamp > cutoffIso) return true;
        // Keep unseen notifications regardless of age
        return n.status !== NotificationStatus.SEEN && n.status !== NotificationStatus.DISMISSED;
      });
      // Recalculate unread count after pruning to prevent drift
      if (state.notifications.length < beforeLen) {
        state.unreadNotificationCount = state.notifications.filter(
          (/** @type {any} */ n) =>
            n.status !== NotificationStatus.SEEN && n.status !== NotificationStatus.DISMISSED
        ).length;
      }

      // Limit notifications history
      if (state.notifications.length >= 50) {
        state.notifications.shift();
      }
      const safePayload = serializeData(action.payload);
      const {
        id: incomingId,
        timestamp: incomingTimestamp,
        status: _ignoredStatus,
        displayedAt: _ignoredDisplayedAt,
        seenAt: _ignoredSeenAt,
        dismissedAt: _ignoredDismissedAt,
        ...safeFields
      } = safePayload || {};
      const nowIso = new Date().toISOString();
      const notification = {
        ...safeFields,
        // Preserve ID from main process if present, otherwise generate
        id: incomingId || generateNotificationId(),
        timestamp: incomingTimestamp || nowIso,
        // Mark as displayed when added to Redux
        status: NotificationStatus.DISPLAYED,
        displayedAt: nowIso,
        seenAt: null,
        dismissedAt: null
      };
      state.notifications.push(/** @type {any} */ notification);
      // Derive unread count from array to prevent drift under concurrent operations
      state.unreadNotificationCount = state.notifications.filter(
        (/** @type {any} */ n) =>
          n.status !== NotificationStatus.SEEN && n.status !== NotificationStatus.DISMISSED
      ).length;
    },
    removeNotification: (state, action) => {
      state.notifications = state.notifications.filter(
        (/** @type {any} */ n) => n.id !== action.payload
      );
      // Derive unread count from array to prevent drift under concurrent operations
      state.unreadNotificationCount = state.notifications.filter(
        (/** @type {any} */ n) =>
          n.status !== NotificationStatus.SEEN && n.status !== NotificationStatus.DISMISSED
      ).length;
    },
    clearNotifications: (state) => {
      state.notifications = [];
      state.unreadNotificationCount = 0;
    },
    /**
     * Mark a notification as seen (user has viewed it but not dismissed)
     */
    markNotificationSeen: (state, action) => {
      const notification = state.notifications.find(
        (/** @type {any} */ n) => n.id === action.payload
      );
      if (
        notification &&
        notification.status !== NotificationStatus.SEEN &&
        notification.status !== NotificationStatus.DISMISSED
      ) {
        notification.status = NotificationStatus.SEEN;
        notification.seenAt = new Date().toISOString();
        state.unreadNotificationCount = state.notifications.filter(
          (/** @type {any} */ n) =>
            n.status !== NotificationStatus.SEEN && n.status !== NotificationStatus.DISMISSED
        ).length;
      }
    },
    /**
     * Mark a notification as dismissed (user explicitly closed it)
     */
    markNotificationDismissed: (state, action) => {
      const notification = state.notifications.find(
        (/** @type {any} */ n) => n.id === action.payload
      );
      if (/** @type {any} */ notification) {
        notification.status = NotificationStatus.DISMISSED;
        notification.dismissedAt = new Date().toISOString();
        state.unreadNotificationCount = state.notifications.filter(
          (/** @type {any} */ n) =>
            n.status !== NotificationStatus.SEEN && n.status !== NotificationStatus.DISMISSED
        ).length;
      }
    },
    /**
     * Mark all notifications as seen
     */
    markAllNotificationsSeen: (state) => {
      const now = new Date().toISOString();
      state.notifications.forEach((/** @type {any} */ notification) => {
        if (
          notification.status !== NotificationStatus.SEEN &&
          notification.status !== NotificationStatus.DISMISSED
        ) {
          notification.status = NotificationStatus.SEEN;
          notification.seenAt = now;
        }
      });
      state.unreadNotificationCount = 0;
    },
    setDocumentsPath: (state, action) => {
      state.documentsPath = normalizeDocumentsPath(action.payload);
      state.documentsPathLoaded = true;
      state.documentsPathError = null;
    }
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchDocumentsPath.pending, (state) => {
        state.documentsPathLoading = true;
        state.documentsPathError = null;
      })
      .addCase(fetchDocumentsPath.fulfilled, (state, action) => {
        state.documentsPath = action.payload;
        state.documentsPathLoaded = true;
        state.documentsPathLoading = false;
        state.documentsPathError = null;
      })
      .addCase(fetchDocumentsPath.rejected, (state, action) => {
        state.documentsPath = 'Documents';
        state.documentsPathLoaded = false;
        state.documentsPathLoading = false;
        state.documentsPathError =
          action.payload || action.error?.message || 'Failed to load documents path';
      })
      .addCase(fetchRedactPaths.pending, (state) => {
        state.redactPathsLoading = true;
        state.redactPathsError = null;
      })
      .addCase(fetchRedactPaths.fulfilled, (state, action) => {
        state.redactPaths = Boolean(action.payload);
        state.redactPathsLoaded = true;
        state.redactPathsLoading = false;
        state.redactPathsError = null;
      })
      .addCase(fetchRedactPaths.rejected, (state, action) => {
        state.redactPaths =
          typeof state.redactPaths === 'boolean' ? state.redactPaths : initialState.redactPaths;
        state.redactPathsLoaded = false;
        state.redactPathsLoading = false;
        state.redactPathsError =
          action.payload || action.error?.message || 'Failed to load redactPaths flag';
      })
      .addCase(fetchDegradedState.fulfilled, (state, action) => {
        state.degradedFlags = Array.isArray(action.payload) ? action.payload : [];
        state.degradedFlagsLoaded = true;
        state.degradedFlagsError = null;
      })
      .addCase(fetchDegradedState.rejected, (state, action) => {
        state.degradedFlagsError =
          action.payload || action.error?.message || 'Failed to load degraded state';
      })
      .addCase(dismissDegradedFlag.fulfilled, (state, action) => {
        const code = action.payload;
        state.degradedFlags = state.degradedFlags.map((/** @type {any} */ flag) =>
          flag.code === code ? { ...flag, dismissed: true } : flag
        );
      })
      .addCase(dismissDegradedFlag.rejected, (state, action) => {
        state.degradedFlagsError =
          action.payload || action.error?.message || 'Failed to dismiss flag';
      });
  }
});

export const {
  updateMetrics,
  updateHealth,
  addNotification,
  removeNotification,
  clearNotifications,
  markNotificationSeen,
  markNotificationDismissed,
  markAllNotificationsSeen,
  setDocumentsPath
} = systemSlice.actions;

// Export status constants for use in components
export { NotificationStatus };

export default systemSlice.reducer;

import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import PropTypes from 'prop-types';
import { RefreshCw, Download, Upload, Trash2, RotateCcw, Clock } from 'lucide-react';
import Button from '../ui/Button';
import IconButton from '../ui/IconButton';
import { ConfirmModal } from '../ui/Modal';
import SettingsCard from './SettingsCard';
import StateMessage from '../ui/StateMessage';
import { toErrorMessage } from '../../utils/errorMapping';
import { createLogger } from '../../../shared/logger';
import { Text } from '../ui/Typography';
import { getElectronAPI, settingsIpc } from '../../services/ipc';
import { formatDateTime } from '../../utils/format';

/**
 * Settings backup/restore section with import/export functionality
 */
/**
 * A restore or import can succeed with reservations (a value clamped, a key
 * dropped). The backend lists them (`warnings` on the envelope, or
 * `validationWarnings` in the data); without this they were only logged.
 * @param {(message: string, severity?: string, duration?: number, key?: string) => void} addNotification
 * @param {unknown} warnings
 * @param {string} verb
 */
function notifyValidationWarnings(addNotification, warnings, verb) {
  const list = Array.isArray(warnings) ? warnings.filter(Boolean).map(String) : [];
  if (list.length === 0) return;
  addNotification(
    list.length === 1
      ? `${verb} with a warning: ${list[0]}`
      : `${verb} with ${list.length} warnings: ${list[0]}`,
    'warning',
    8000,
    'settings-restore-warning'
  );
}

function SettingsBackupSection({ addNotification }) {
  const [backups, setBackups] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isRestoring, setIsRestoring] = useState(null);
  const [isDeleting, setIsDeleting] = useState(null);
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  // Confirm-modal targets. Backup objects (not just paths) so we can show
  // backup name in the confirm message and use it as the type-to-confirm
  // phrase for delete.
  const [restoreTarget, setRestoreTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const isMountedRef = useRef(false);

  const logger = useMemo(() => createLogger('SettingsBackupSection'), []);
  const settingsApi = getElectronAPI()?.settings;
  const canListBackups = typeof settingsApi?.listBackups === 'function';
  const canCreateBackup = typeof settingsApi?.createBackup === 'function';
  const canRestoreBackup = typeof settingsApi?.restoreBackup === 'function';
  const canDeleteBackup = typeof settingsApi?.deleteBackup === 'function';
  const canExportSettings = typeof settingsApi?.export === 'function';
  const canImportSettings = typeof settingsApi?.import === 'function';

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const loadBackups = useCallback(async () => {
    if (!isMountedRef.current) return;
    if (!canListBackups) {
      setBackups([]);
      return;
    }
    setIsLoading(true);
    try {
      const res = await settingsIpc.listBackups();
      if (!isMountedRef.current) return;
      if (res?.success && Array.isArray(res.backups)) {
        setBackups(res.backups);
      } else {
        setBackups([]);
      }
    } catch (e) {
      logger.debug('[SettingsBackupSection] listBackups failed', { error: e?.message });
      if (!isMountedRef.current) return;
      setBackups([]);
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false);
      }
    }
  }, [canListBackups, logger]);

  useEffect(() => {
    loadBackups();
  }, [loadBackups]);

  const handleCreateBackup = useCallback(async () => {
    if (!isMountedRef.current) return;
    if (!canCreateBackup) {
      addNotification('Create backup is unavailable in this build', 'error');
      return;
    }
    setIsCreating(true);
    try {
      const res = await settingsIpc.createBackup();
      if (!isMountedRef.current) return;
      if (res?.success) {
        addNotification('Backup created successfully', 'success');
        loadBackups();
      } else {
        addNotification(toErrorMessage(res?.error, 'Failed to create backup'), 'error');
      }
    } catch {
      addNotification('Failed to create backup', 'error');
    } finally {
      if (isMountedRef.current) {
        setIsCreating(false);
      }
    }
  }, [addNotification, canCreateBackup, loadBackups]);

  const performRestoreBackup = useCallback(
    async (backupPath) => {
      if (!isMountedRef.current) return;
      if (!canRestoreBackup) {
        addNotification('Restore backup is unavailable in this build', 'error');
        return;
      }
      setIsRestoring(backupPath);
      try {
        const res = await settingsIpc.restoreBackup(backupPath);
        if (!isMountedRef.current) return;
        if (res?.success) {
          // Closure cue (Shneiderman rule 4): explicit "Reload now" action
          // alongside the toast so the user can apply the restore without
          // hunting for a manual reload command.
          addNotification(
            'Backup restored. Reload now to apply changes.',
            'success',
            8000,
            'backup-restored'
          );
          notifyValidationWarnings(
            addNotification,
            res.validationWarnings ?? res.warnings,
            'Restored'
          );
        } else {
          const message = toErrorMessage(res?.error, 'Failed to restore backup');
          addNotification(message, 'error');
          throw new Error(message);
        }
      } catch (err) {
        addNotification(err?.message || 'Failed to restore backup', 'error');
        throw err;
      } finally {
        if (isMountedRef.current) {
          setIsRestoring(null);
        }
      }
    },
    [addNotification, canRestoreBackup]
  );

  const performDeleteBackup = useCallback(
    async (backupPath) => {
      if (!isMountedRef.current) return;
      if (!canDeleteBackup) {
        addNotification('Delete backup is unavailable in this build', 'error');
        return;
      }
      setIsDeleting(backupPath);
      try {
        const res = await settingsIpc.deleteBackup(backupPath);
        if (!isMountedRef.current) return;
        if (res?.success) {
          addNotification('Backup deleted', 'success');
          loadBackups();
        } else {
          const message = toErrorMessage(res?.error, 'Failed to delete backup');
          addNotification(message, 'error');
          throw new Error(message);
        }
      } catch (err) {
        addNotification(err?.message || 'Failed to delete backup', 'error');
        throw err;
      } finally {
        if (isMountedRef.current) {
          setIsDeleting(null);
        }
      }
    },
    [addNotification, canDeleteBackup, loadBackups]
  );

  const handleExport = useCallback(async () => {
    if (!isMountedRef.current) return;
    if (!canExportSettings) {
      addNotification('Export settings is unavailable in this build', 'error');
      return;
    }
    setIsExporting(true);
    try {
      const res = await settingsIpc.export();
      if (!isMountedRef.current) return;
      if (res?.success) {
        addNotification('Settings exported successfully', 'success');
      } else if (res?.canceled) {
        // User canceled, no notification needed
      } else {
        addNotification(toErrorMessage(res?.error, 'Failed to export settings'), 'error');
      }
    } catch {
      addNotification('Failed to export settings', 'error');
    } finally {
      if (isMountedRef.current) {
        setIsExporting(false);
      }
    }
  }, [addNotification, canExportSettings]);

  const handleImport = useCallback(async () => {
    if (!isMountedRef.current) return;
    if (!canImportSettings) {
      addNotification('Import settings is unavailable in this build', 'error');
      return;
    }
    setIsImporting(true);
    try {
      const res = await settingsIpc.import();
      if (!isMountedRef.current) return;
      if (res?.success) {
        addNotification('Settings imported. Reload to apply changes.', 'success');
        notifyValidationWarnings(
          addNotification,
          res.validationWarnings ?? res.warnings,
          'Imported'
        );
      } else if (res?.canceled) {
        // User canceled, no notification needed
      } else {
        addNotification(toErrorMessage(res?.error, 'Failed to import settings'), 'error');
      }
    } catch {
      addNotification('Failed to import settings', 'error');
    } finally {
      if (isMountedRef.current) {
        setIsImporting(false);
      }
    }
  }, [addNotification, canImportSettings]);

  // Route through the shared Intl.DateTimeFormat cache (utils/format) so the
  // locale we render with is explicit, cached, and overridable via
  // `setDateLocale()` for tests / support bundles. The previous inline
  // `toLocaleString(undefined, {...})` picked up whatever locale the OS
  // happened to have, which made screenshots in bug reports hard to compare.
  const formatDate = (timestamp) =>
    timestamp ? formatDateTime(timestamp, 'datetime', 'Unknown') : 'Unknown';

  return (
    <SettingsCard
      title="Settings backup & restore"
      description="Backups you create stay until you delete them. The app also keeps its 10 most recent automatic snapshots, taken before each settings change. Export and import move settings between installs."
      headerAction={
        <IconButton
          icon={<RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />}
          size="sm"
          variant="secondary"
          onClick={loadBackups}
          aria-label="Refresh backup list"
          title="Refresh"
          disabled={isLoading}
        />
      }
    >
      {/* Quick Actions */}
      <div className="flex flex-wrap gap-compact">
        <Button
          onClick={handleCreateBackup}
          variant="secondary"
          disabled={isCreating || !canCreateBackup}
          size="sm"
          leftIcon={<Clock className="w-4 h-4" />}
        >
          {isCreating ? 'Creating\u2026' : 'Create backup'}
        </Button>
        <Button
          onClick={handleExport}
          variant="secondary"
          disabled={isExporting || !canExportSettings}
          size="sm"
          leftIcon={<Download className="w-4 h-4" />}
        >
          {isExporting ? 'Exporting\u2026' : 'Export to File'}
        </Button>
        <Button
          onClick={handleImport}
          variant="secondary"
          disabled={isImporting || !canImportSettings}
          size="sm"
          leftIcon={<Upload className="w-4 h-4" />}
        >
          {isImporting ? 'Importing\u2026' : 'Import from File'}
        </Button>
      </div>

      {/* Backup List */}
      {backups.length > 0 && (
        <div className="space-y-2">
          <Text as="label" variant="tiny" className="block font-medium text-system-gray-600">
            Available backups ({backups.length})
          </Text>
          <div className="max-h-40 overflow-y-auto space-y-1.5 border border-border-soft rounded-xl p-3 bg-surface-muted">
            {backups.map((backup) => (
              <div
                key={backup.path || backup.filename}
                className="flex items-center justify-between gap-compact p-2 rounded-lg border border-border-soft bg-surface-primary"
              >
                <div className="min-w-0 flex-1">
                  <Text variant="small" className="font-medium text-system-gray-700 truncate">
                    {/* Main's listBackups returns `filename` (there is no `name` field) */}
                    {backup.filename || 'Backup'}
                  </Text>
                  <Text variant="tiny" className="text-system-gray-500">
                    {formatDate(backup.timestamp || backup.created)}
                    {' · '}
                    {backup.kind === 'manual' ? 'Manual, kept until deleted' : 'Automatic'}
                  </Text>
                </div>
                <div className="flex items-center gap-1">
                  <IconButton
                    icon={<RotateCcw className="w-4 h-4" />}
                    size="sm"
                    variant="ghost"
                    onClick={() => setRestoreTarget(backup)}
                    aria-label="Restore this backup"
                    title="Restore"
                    disabled={isRestoring === backup.path || !canRestoreBackup}
                  />
                  <IconButton
                    icon={<Trash2 className="w-4 h-4" />}
                    size="sm"
                    variant="ghost"
                    onClick={() => setDeleteTarget(backup)}
                    aria-label="Delete this backup"
                    title="Delete"
                    disabled={isDeleting === backup.path || !canDeleteBackup}
                    className="text-stratosort-danger hover:text-stratosort-danger/80"
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {backups.length === 0 && !isLoading && (
        <StateMessage
          icon={Clock}
          tone="neutral"
          size="sm"
          align="left"
          title="No backups found"
          description="Create one to save your current settings."
          className="py-2"
          contentClassName="max-w-sm"
        />
      )}

      <ConfirmModal
        isOpen={Boolean(restoreTarget)}
        onClose={() => setRestoreTarget(null)}
        onConfirm={async () => {
          if (restoreTarget?.path) {
            await performRestoreBackup(restoreTarget.path);
          }
        }}
        title="Restore this backup?"
        message="Restoring will overwrite your current settings with the saved snapshot. Your in-memory edits since the last save will be lost."
        confirmText="Restore"
        cancelText="Cancel"
        variant="warning"
        fileName={restoreTarget?.filename}
      />

      <ConfirmModal
        isOpen={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (deleteTarget?.path) {
            await performDeleteBackup(deleteTarget.path);
          }
        }}
        title="Delete this backup?"
        message="The backup file will be removed permanently. This action cannot be undone."
        confirmText="Delete backup"
        cancelText="Cancel"
        variant="danger"
        fileName={deleteTarget?.filename}
        // Fixed phrase rather than the backup's timestamp filename: the guard
        // previously keyed off a `name` field that never existed, so it never
        // engaged at all — and making users retype a 40-character timestamp
        // filename would be worse than no guard.
        requireConfirmText="DELETE"
      />
    </SettingsCard>
  );
}

SettingsBackupSection.propTypes = {
  addNotification: PropTypes.func.isRequired
};

export default SettingsBackupSection;

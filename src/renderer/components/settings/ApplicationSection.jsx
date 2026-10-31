import React from 'react';
import PropTypes from 'prop-types';
import { RefreshCw } from 'lucide-react';
import Switch from '../ui/Switch';
import SettingRow from './SettingRow';
import Button from '../ui/Button';
import SettingsCard from './SettingsCard';
import { logger } from '../../../shared/logger';
import { getElectronAPI, systemIpc } from '../../services/ipc';

/**
 * Application settings section (launch on startup, etc.)
 */
function ApplicationSection({ settings, setSettings, addNotification }) {
  const [isCheckingUpdates, setIsCheckingUpdates] = React.useState(false);
  const electronApi = getElectronAPI();
  const canCheckUpdates = typeof electronApi?.system?.checkForUpdates === 'function';

  const handleCheckForUpdates = React.useCallback(async () => {
    if (isCheckingUpdates) return;
    if (!canCheckUpdates) {
      addNotification?.('Update checks are unavailable in this build', 'error');
      return;
    }

    setIsCheckingUpdates(true);
    try {
      const result = await systemIpc.checkForUpdates();
      if (result?.unsupported) {
        addNotification?.(
          result.reason || 'This copy of StratoSort cannot update itself.',
          'warning'
        );
      } else if (result?.disabled) {
        addNotification?.('Update checks are temporarily disabled in this build.', 'info');
      } else {
        addNotification?.('Checking for updates\u2026', 'info');
      }
    } catch (error) {
      logger.error('[Settings] Failed to check for updates', { error });
      addNotification?.('Failed to check for updates', 'error');
    } finally {
      setIsCheckingUpdates(false);
    }
  }, [addNotification, canCheckUpdates, isCheckingUpdates]);

  return (
    <SettingsCard
      title="Application preferences"
      description="Startup behavior, folder watching, updates, and manual update checks."
    >
      <SettingRow
        label="Launch on startup"
        description="Automatically start StratoSort when you log in to your computer."
      >
        <Switch
          checked={!!settings.launchOnStartup}
          onChange={(checked) =>
            setSettings((prev) => ({
              ...prev,
              launchOnStartup: checked
            }))
          }
          aria-label="Toggle launch on startup"
        />
      </SettingRow>

      <SettingRow
        label="Watch Smart Folders"
        description="Detect new files in configured Smart Folder locations and enqueue them for processing. Turn off only if another tool owns those folders exclusively."
      >
        <Switch
          checked={settings.smartFolderWatchEnabled !== false}
          onChange={(checked) =>
            setSettings((prev) => ({
              ...prev,
              smartFolderWatchEnabled: checked
            }))
          }
          aria-label="Toggle smart folder filesystem watching"
        />
      </SettingRow>

      <SettingRow
        label="Background update checks"
        description="Periodically checks for newer app versions using the bundled updater (no documents are transmitted). Turning this off only affects automatic checks; you can still use Check for updates below."
      >
        <Switch
          checked={settings.autoUpdateCheck !== false}
          onChange={(checked) =>
            setSettings((prev) => ({
              ...prev,
              autoUpdateCheck: checked
            }))
          }
          aria-label="Toggle automatic update checks"
        />
      </SettingRow>

      <SettingRow
        label="Software updates"
        description="Check for a newer build now. Installers and release notes are published on your distribution channel when available."
      >
        <Button
          variant="subtle"
          size="sm"
          onClick={handleCheckForUpdates}
          disabled={!canCheckUpdates}
          isLoading={isCheckingUpdates}
          leftIcon={<RefreshCw className="w-4 h-4" />}
          aria-label="Check for application updates"
        >
          Check for updates
        </Button>
      </SettingRow>
    </SettingsCard>
  );
}

ApplicationSection.propTypes = {
  settings: PropTypes.object.isRequired,
  setSettings: PropTypes.func.isRequired,
  addNotification: PropTypes.func
};

export default ApplicationSection;

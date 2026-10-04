import React from 'react';
import PropTypes from 'prop-types';
import Switch from '../ui/Switch';
import Button from '../ui/Button';
import SettingRow from './SettingRow';
import SettingsCard from './SettingsCard';
import {
  DEBUG_STORAGE_KEYS,
  getStoredDebugModeEnabled,
  getStoredForceModelWizardEnabled,
  writeStoredFlag
} from '../../utils/debugFlags';

function DebugToolsSection({ settings, setSettings, addNotification }) {
  const isDevBuild = process.env.NODE_ENV === 'development';
  const [debugModeEnabled, setDebugModeEnabled] = React.useState(() => getStoredDebugModeEnabled());
  const [forceModelWizardEnabled, setForceModelWizardEnabled] = React.useState(() =>
    getStoredForceModelWizardEnabled()
  );

  if (!isDevBuild) return null;

  const handleDebugModeChange = (checked) => {
    writeStoredFlag(DEBUG_STORAGE_KEYS.debugMode, checked);
    setDebugModeEnabled(checked);

    if (!checked) {
      writeStoredFlag(DEBUG_STORAGE_KEYS.forceModelWizard, false);
      setForceModelWizardEnabled(false);
      addNotification?.('Debug mode disabled. Debug-only flags were cleared.', 'info');
      return;
    }

    addNotification?.('Debug mode enabled.', 'info');
  };

  const handleForceWizardChange = (checked) => {
    if (!debugModeEnabled) return;
    writeStoredFlag(DEBUG_STORAGE_KEYS.forceModelWizard, checked);
    setForceModelWizardEnabled(checked);
    addNotification?.(
      checked
        ? 'Model setup wizard will be forced on Welcome.'
        : 'Model setup wizard forcing disabled.',
      'info'
    );
  };

  const clearDebugFlags = () => {
    writeStoredFlag(DEBUG_STORAGE_KEYS.forceModelWizard, false);
    writeStoredFlag(DEBUG_STORAGE_KEYS.debugMode, false);
    setForceModelWizardEnabled(false);
    setDebugModeEnabled(false);
    addNotification?.('Debug flags cleared.', 'info');
  };

  const handleDeveloperGraphChange = (checked) => {
    setSettings?.((prev) => ({
      ...prev,
      developerGraphEnabled: checked
    }));
    addNotification?.(
      checked
        ? 'Graph view restored in Knowledge Graph.'
        : 'Graph view hidden. Search and chat remain available.',
      'info'
    );
  };

  return (
    <SettingsCard
      title="Experimental & Developer Tools"
      description="Developer-only switches for testing setup, onboarding, and optional Knowledge Graph features."
    >
      <SettingRow
        label="Enable graph view"
        description="Shows graph visualization and graph-specific actions in Knowledge Graph. Search and chat stay available when this is off."
      >
        <Switch
          checked={settings?.developerGraphEnabled !== false}
          onChange={handleDeveloperGraphChange}
          aria-label="Toggle graph view"
        />
      </SettingRow>

      <SettingRow
        label="Enable debug mode"
        description="Turns on local debug switches in this app profile. Dev builds only."
      >
        <Switch
          checked={debugModeEnabled}
          onChange={handleDebugModeChange}
          aria-label="Toggle debug mode"
        />
      </SettingRow>

      <SettingRow
        label="Force setup wizard"
        description="When enabled, Welcome shows the model setup wizard even if required models exist."
      >
        <Switch
          checked={forceModelWizardEnabled}
          onChange={handleForceWizardChange}
          disabled={!debugModeEnabled}
          aria-label="Toggle force setup wizard"
        />
      </SettingRow>

      <SettingRow
        label="Reset debug flags"
        description="Clears local debug switches and restores normal behavior."
      >
        <Button variant="subtle" size="sm" onClick={clearDebugFlags}>
          Reset
        </Button>
      </SettingRow>
    </SettingsCard>
  );
}

DebugToolsSection.propTypes = {
  settings: PropTypes.object,
  setSettings: PropTypes.func,
  addNotification: PropTypes.func
};

export default DebugToolsSection;

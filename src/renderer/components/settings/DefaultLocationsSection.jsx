import React, { useCallback, useMemo } from 'react';
import PropTypes from 'prop-types';
import { useSelector } from 'react-redux';
import { FolderOpen } from 'lucide-react';
import Button from '../ui/Button';
import Input from '../ui/Input';
import SettingRow from './SettingRow';
import SettingsCard from './SettingsCard';
import { Text } from '../ui/Typography';
import { selectRedactPaths } from '../../store/selectors';

const { VALIDATION_RULES, validateSetting } = require('../../../shared/settingsValidation');

/**
 * Default locations section for smart folder configuration
 */
function DefaultLocationsSection({ settings, setSettings }) {
  // PERF: Use memoized selector instead of inline Boolean coercion
  const redactPaths = useSelector(selectRedactPaths);

  const location = settings.defaultSmartFolderLocation || '';

  // Mirror the shared save-time validation so the user sees WHY a value
  // won't stick. The sanitizer silently drops invalid values during save —
  // without this hint the field just reverted on the next Settings open
  // with no feedback at all.
  const locationError = useMemo(() => {
    if (!location.trim()) return null;
    const errors = validateSetting(
      'defaultSmartFolderLocation',
      location,
      VALIDATION_RULES.defaultSmartFolderLocation
    );
    return errors.length > 0
      ? 'This value cannot be saved — use an absolute path or a simple folder name (no slashes, "..", or special characters). Until it is fixed, the previous saved value stays in effect.'
      : null;
  }, [location]);

  const handleBrowse = useCallback(async () => {
    try {
      if (!window?.electronAPI?.files?.selectDirectory) return;
      // New Smart Folders are created here, so it is a place files go.
      const res = await window.electronAPI.files.selectDirectory({ purpose: 'destination' });
      if (res?.success && res.path) {
        setSettings((prev) => ({
          ...prev,
          defaultSmartFolderLocation: res.path
        }));
      }
    } catch {
      // Ignore selection errors
    }
  }, [setSettings]);

  return (
    <SettingsCard
      title="Default locations"
      description="Choose where StratoSort creates new smart folders by default."
    >
      <SettingRow
        layout="col"
        label="Default Smart Folder location"
        description="Where new smart folders will be created by default."
      >
        <div className="settings-input-group">
          <Input
            type={redactPaths ? 'password' : 'text'}
            value={location}
            onChange={(e) =>
              setSettings((prev) => ({
                ...prev,
                defaultSmartFolderLocation: e.target.value
              }))
            }
            className="w-full"
            placeholder="Documents"
            aria-label="Default smart folder location"
            aria-invalid={Boolean(locationError)}
            aria-describedby={locationError ? 'default-location-error' : undefined}
          />
          <Button
            onClick={handleBrowse}
            variant="secondary"
            type="button"
            title="Browse"
            aria-label="Browse for default folder"
            leftIcon={<FolderOpen className="w-4 h-4" />}
            size="sm"
            className="w-full sm:w-auto justify-center min-w-[9rem]"
          >
            Browse
          </Button>
        </div>
        {locationError && (
          <Text
            id="default-location-error"
            variant="tiny"
            role="alert"
            className="text-stratosort-danger mt-1"
          >
            {locationError}
          </Text>
        )}
      </SettingRow>
    </SettingsCard>
  );
}

DefaultLocationsSection.propTypes = {
  settings: PropTypes.object.isRequired,
  setSettings: PropTypes.func.isRequired
};

export default DefaultLocationsSection;

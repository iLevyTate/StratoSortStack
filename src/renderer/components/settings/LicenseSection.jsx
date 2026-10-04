import React from 'react';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import Button from '../ui/Button';
import StatusBadge from '../ui/StatusBadge';
import SettingsCard from './SettingsCard';
import { Text } from '../ui/Typography';
import { buildCommercialInquiryMailtoUrl } from '../../../shared/supportInfo';
import {
  activateLicense,
  deactivateLicense,
  selectLicenseSnapshot,
  selectLicenseWorking,
  selectLicenseError
} from '../../store/slices/licenseSlice';

const STATE_COPY = {
  free: { label: 'Free for personal use', variant: 'success' },
  licensed: { label: 'Licensed', variant: 'success' },
  version_not_covered: { label: 'Update not covered', variant: 'warning' }
};

/**
 * Commercial license status and offline key activation. Verification happens
 * entirely in the main process against the embedded public key, with no
 * network involved. The status is informational: nothing in the app is
 * disabled whatever it says.
 */
function LicenseSection() {
  const dispatch = useAppDispatch();
  const snapshot = useAppSelector(selectLicenseSnapshot);
  const isWorking = useAppSelector(selectLicenseWorking);
  const lastError = useAppSelector(selectLicenseError);
  const [keyInput, setKeyInput] = React.useState('');

  const copy = STATE_COPY[snapshot.state] || STATE_COPY.free;
  const isLicensed = snapshot.state === 'licensed' || snapshot.state === 'version_not_covered';

  const handleActivate = () => {
    const key = keyInput.trim();
    if (!key) return;
    dispatch(activateLicense(key))
      .then((action) => {
        if (action.meta.requestStatus === 'fulfilled') setKeyInput('');
        return action;
      })
      .catch(() => {
        // Rejection surfaces via the slice's lastError; nothing else to do.
      });
  };

  return (
    <SettingsCard
      title="License"
      description="Personal and noncommercial use is free. Commercial use needs a paid key, verified entirely on this device."
    >
      <div className="flex items-center gap-cozy">
        <StatusBadge appearance="label" variant={copy.variant}>
          {copy.label}
        </StatusBadge>
        {isLicensed && snapshot.name && (
          <Text as="span" variant="tiny">
            Licensed to {snapshot.name}
            {snapshot.edition ? ` · ${snapshot.edition}` : ''}
          </Text>
        )}
      </div>

      {!isLicensed && (
        <Text variant="small" className="mt-2">
          Every feature works without a key, and nothing expires. A key only records that this copy
          is licensed for commercial use.
        </Text>
      )}
      {snapshot.state === 'version_not_covered' && (
        <Text variant="small" className="mt-2">
          This build ({snapshot.buildDate}) was released after your license&apos;s update window
          ended ({snapshot.maintenanceUntil}). Renew to keep commercial use covered on new versions.
        </Text>
      )}
      {isLicensed && snapshot.maintenanceUntil && snapshot.state === 'licensed' && (
        <Text variant="tiny" className="mt-1 text-system-gray-500">
          Includes updates released through {snapshot.maintenanceUntil}.
        </Text>
      )}

      {!isLicensed ? (
        <div className="mt-3 flex flex-col gap-compact sm:flex-row">
          <textarea
            id="license-key-input"
            aria-label="License key"
            value={keyInput}
            onChange={(event) => setKeyInput(event.target.value)}
            placeholder="Paste a commercial license key (SSORT1-…)"
            rows={2}
            spellCheck={false}
            autoComplete="off"
            className="flex-1 rounded-lg border border-border-soft bg-system-gray-50 px-3 py-2 font-mono text-xs text-system-gray-800 placeholder:text-system-gray-400"
          />
          <Button
            variant="primary"
            size="sm"
            onClick={handleActivate}
            disabled={isWorking || !keyInput.trim()}
            isLoading={isWorking}
            className="self-start"
          >
            Activate
          </Button>
        </div>
      ) : (
        <div className="mt-3">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => dispatch(deactivateLicense())}
            disabled={isWorking}
          >
            Remove license from this device
          </Button>
        </div>
      )}

      {snapshot.state !== 'licensed' && (
        <div className="mt-3 flex flex-wrap items-center gap-compact">
          <Text as="span" variant="tiny" className="text-system-gray-500">
            Need a commercial license? Purchase is by email; keys are delivered offline.
          </Text>
          <Button
            variant="subtle"
            size="xs"
            onClick={() => {
              try {
                window.open(buildCommercialInquiryMailtoUrl(), '_blank', 'noopener,noreferrer');
              } catch {
                // Blocked window.open is non-fatal; the address is in docs/COMMERCIAL.md.
              }
            }}
          >
            Buy a commercial license
          </Button>
        </div>
      )}

      {lastError && (
        <Text role="alert" variant="tiny" className="mt-2 text-stratosort-danger">
          {lastError}
        </Text>
      )}
    </SettingsCard>
  );
}

export default LicenseSection;

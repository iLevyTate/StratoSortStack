import React from 'react';
import PropTypes from 'prop-types';
import Button from '../ui/Button';
import SettingRow from './SettingRow';
import SettingsCard from './SettingsCard';
import { logger } from '../../../shared/logger';
import {
  SUPPORT_EMAIL,
  formatPlatform,
  describeWhisperStack,
  buildSupportMailtoUrl,
  buildVersionString
} from '../../../shared/supportInfo';
import { getElectronAPI, settingsIpc, systemIpc } from '../../services/ipc';

/**
 * About section: shows app + runtime versions, bundled legal documents, and
 * email-based support contact.
 */
function AboutSection({ addNotification }) {
  const electronApi = getElectronAPI();
  const canGetRuntimeInfo =
    typeof electronApi?.system?.getRuntimeInfo === 'function' &&
    typeof systemIpc?.getRuntimeInfo === 'function';
  const canOpenLogsFolder = typeof electronApi?.settings?.openLogsFolder === 'function';
  const canOpenLegalDocument = typeof electronApi?.system?.openLegalDocument === 'function';

  const [info, setInfo] = React.useState(null);
  const [loadError, setLoadError] = React.useState(() =>
    canGetRuntimeInfo ? null : 'Runtime info is unavailable in this build'
  );
  const [isOpeningLogs, setIsOpeningLogs] = React.useState(false);
  const [isCopying, setIsCopying] = React.useState(false);
  const [openingLegalKind, setOpeningLegalKind] = React.useState(null);

  React.useEffect(() => {
    if (!canGetRuntimeInfo) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const result = await systemIpc.getRuntimeInfo();
        if (!cancelled) setInfo(result || null);
      } catch (error) {
        logger.error('[About] Failed to read runtime info', { error });
        if (!cancelled) setLoadError(error?.message || 'Failed to read runtime info');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canGetRuntimeInfo]);

  const openExternal = React.useCallback(
    (url) => {
      try {
        window.open(url, '_blank', 'noopener,noreferrer');
      } catch (error) {
        logger.error('[About] Failed to open external URL', { url, error });
        addNotification?.('Failed to open link', 'error');
      }
    },
    [addNotification]
  );

  const handleContactSupport = React.useCallback(() => {
    openExternal(buildSupportMailtoUrl(info || {}));
  }, [info, openExternal]);

  const handleOpenLegalDocument = React.useCallback(
    async (kind) => {
      if (openingLegalKind) return;
      if (!canOpenLegalDocument) {
        addNotification?.('Legal documents are unavailable in this build', 'error');
        return;
      }
      setOpeningLegalKind(kind);
      try {
        await systemIpc.openLegalDocument(kind);
      } catch (error) {
        logger.error('[About] Failed to open legal document', { kind, error });
        addNotification?.('Failed to open legal document', 'error');
      } finally {
        setOpeningLegalKind(null);
      }
    },
    [addNotification, canOpenLegalDocument, openingLegalKind]
  );

  const handleOpenLogsFolder = React.useCallback(async () => {
    if (isOpeningLogs) return;
    if (!canOpenLogsFolder) {
      addNotification?.('Open logs folder is unavailable in this build', 'error');
      return;
    }
    setIsOpeningLogs(true);
    try {
      const result = await settingsIpc.openLogsFolder();
      if (result?.success === false) {
        throw new Error(result.error || 'Failed to open logs folder');
      }
    } catch (error) {
      logger.error('[About] Failed to open logs folder', { error });
      addNotification?.('Failed to open logs folder', 'error');
    } finally {
      setIsOpeningLogs(false);
    }
  }, [addNotification, canOpenLogsFolder, isOpeningLogs]);

  const handleCopyVersion = React.useCallback(async () => {
    if (isCopying || !info) return;
    setIsCopying(true);
    try {
      await navigator.clipboard.writeText(buildVersionString(info));
      addNotification?.('Version info copied to clipboard', 'success');
    } catch (error) {
      logger.error('[About] Failed to copy version info', { error });
      addNotification?.('Failed to copy version info', 'error');
    } finally {
      setIsCopying(false);
    }
  }, [addNotification, info, isCopying]);

  const versionDisplay = info?.appVersion ? `v${info.appVersion}` : null;
  const platformDisplay = info ? formatPlatform(info.platform, info.arch, info.osRelease) : null;

  return (
    <SettingsCard
      title="About"
      description="Version, runtime details, and legal documents. Contact support by email and attach logs when reporting a problem."
    >
      <SettingRow label="Application">
        <div className="text-sm font-medium text-system-gray-800 sm:text-right">
          {info?.appName || 'StratoSort Stack'}
          {versionDisplay ? ` ${versionDisplay}` : ''}
        </div>
      </SettingRow>

      {platformDisplay && (
        <SettingRow label="Platform">
          <div className="text-sm font-medium text-system-gray-800 sm:text-right">
            {platformDisplay}
          </div>
        </SettingRow>
      )}

      {info && (
        <SettingRow
          label="Runtime"
          description="Include this when contacting support so engineering can match the build."
        >
          <dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-1 text-sm sm:justify-end">
            <dt className="text-system-gray-500">Electron</dt>
            <dd className="font-medium text-system-gray-800 sm:text-right">
              {info.electronVersion || 'unknown'}
            </dd>
            <dt className="text-system-gray-500">Chrome</dt>
            <dd className="font-medium text-system-gray-800 sm:text-right">
              {info.chromeVersion || 'unknown'}
            </dd>
            <dt className="text-system-gray-500">Node</dt>
            <dd className="font-medium text-system-gray-800 sm:text-right">
              {info.nodeVersion || 'unknown'}
            </dd>
            <dt className="text-system-gray-500">Build</dt>
            <dd className="font-medium text-system-gray-800 sm:text-right">
              {info.isPackaged ? 'packaged' : 'dev'}
              {info.buildSha ? ` · ${info.buildSha}` : ''}
            </dd>
          </dl>
        </SettingRow>
      )}

      {info && (
        <SettingRow
          label="Media (Whisper)"
          description="Speech-to-text for audio and video. Shows the installed model; GPU/CPU path appears after transcription starts."
        >
          <div className="text-sm font-medium text-system-gray-800 sm:text-right">
            {describeWhisperStack(info.mediaStack)}
          </div>
        </SettingRow>
      )}

      {loadError && (
        <SettingRow label="Status">
          <div className="text-sm text-red-600 sm:text-right" role="alert">
            {loadError}
          </div>
        </SettingRow>
      )}

      <SettingRow
        label="Support"
        description="Email support with your runtime details and attach logs from Open logs folder."
      >
        <div className="space-y-2">
          <div className="text-sm font-medium text-system-gray-800 sm:text-right">
            {SUPPORT_EMAIL}
          </div>
          <div className="flex flex-wrap gap-cozy sm:justify-end">
            <Button variant="primary" size="sm" onClick={handleContactSupport}>
              Email support
            </Button>
            <Button
              variant="subtle"
              size="sm"
              onClick={handleOpenLogsFolder}
              disabled={!canOpenLogsFolder}
              isLoading={isOpeningLogs}
            >
              Open logs folder
            </Button>
            <Button
              variant="subtle"
              size="sm"
              onClick={handleCopyVersion}
              disabled={!info}
              isLoading={isCopying}
            >
              Copy version info
            </Button>
          </div>
        </div>
      </SettingRow>

      <SettingRow
        label="AI model attribution"
        description="Local inference uses Meta Llama models among others. Built with Llama."
      >
        <div className="space-y-compact sm:text-right">
          <p className="text-sm font-semibold text-system-gray-800">Built with Llama</p>
          <p className="text-micro text-system-gray-500">
            Meta Llama 3.2 is licensed under the Llama 3.2 Community License. Full notices ship with
            the app (THIRD_PARTY_NOTICES).
          </p>
        </div>
      </SettingRow>

      <SettingRow
        label="Legal"
        description="License, privacy policy, and security policy bundled with this app."
      >
        <div className="flex flex-wrap gap-cozy sm:justify-end">
          <Button
            variant="subtle"
            size="sm"
            onClick={() => handleOpenLegalDocument('license')}
            disabled={!canOpenLegalDocument}
            isLoading={openingLegalKind === 'license'}
          >
            License
          </Button>
          <Button
            variant="subtle"
            size="sm"
            onClick={() => handleOpenLegalDocument('privacy')}
            disabled={!canOpenLegalDocument}
            isLoading={openingLegalKind === 'privacy'}
          >
            Privacy policy
          </Button>
          <Button
            variant="subtle"
            size="sm"
            onClick={() => handleOpenLegalDocument('security')}
            disabled={!canOpenLegalDocument}
            isLoading={openingLegalKind === 'security'}
          >
            Security policy
          </Button>
        </div>
      </SettingRow>
    </SettingsCard>
  );
}

AboutSection.propTypes = {
  addNotification: PropTypes.func
};

export default AboutSection;

import React from 'react';
import PropTypes from 'prop-types';
import Button from '../ui/Button';
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

  const buildLabel = info
    ? `${info.isPackaged ? 'Packaged' : 'Dev'}${info.buildSha ? ` · ${info.buildSha}` : ''}`
    : null;

  return (
    <SettingsCard
      title="About"
      description="Version and support. The runtime line is what to paste when you write in."
    >
      <div className="flex flex-col gap-default">
        <div className="min-w-0">
          <p className="text-base font-semibold tracking-tight text-system-gray-900">
            {info?.appName || 'StratoSort Stack'}
            {versionDisplay ? (
              <span className="ml-2 text-sm font-medium text-system-gray-500">
                {versionDisplay}
              </span>
            ) : null}
          </p>
          {platformDisplay && (
            <p className="mt-0.5 text-sm text-system-gray-500">{platformDisplay}</p>
          )}
        </div>

        {info && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
            {[
              ['Electron', info.electronVersion || 'unknown'],
              ['Chrome', info.chromeVersion || 'unknown'],
              ['Node', info.nodeVersion || 'unknown'],
              ['Build', buildLabel]
            ].map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="text-xs font-medium uppercase tracking-wide text-system-gray-500">
                  {label}
                </dt>
                <dd className="mt-0.5 truncate text-sm font-medium text-system-gray-800">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        )}

        {info && (
          <p className="text-sm text-system-gray-600">
            <span className="text-system-gray-500">Speech-to-text. </span>
            {describeWhisperStack(info.mediaStack)}
          </p>
        )}

        {loadError && (
          <p className="text-sm text-red-600" role="alert">
            {loadError}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-cozy">
          <Button variant="primary" size="sm" onClick={handleContactSupport}>
            Email support
          </Button>
          <Button
            variant="subtle"
            size="sm"
            onClick={handleCopyVersion}
            disabled={!info}
            isLoading={isCopying}
          >
            Copy version
          </Button>
          <Button
            variant="subtle"
            size="sm"
            onClick={handleOpenLogsFolder}
            disabled={!canOpenLogsFolder}
            isLoading={isOpeningLogs}
          >
            Open logs
          </Button>
          <span className="text-xs text-system-gray-500">{SUPPORT_EMAIL}</span>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border-soft pt-3">
          {[
            ['license', 'License'],
            ['privacy', 'Privacy'],
            ['security', 'Security']
          ].map(([kind, label]) => (
            <button
              key={kind}
              type="button"
              className="text-sm text-system-gray-600 underline-offset-2 hover:text-system-gray-900 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-stratosort-blue disabled:opacity-50"
              onClick={() => handleOpenLegalDocument(kind)}
              disabled={!canOpenLegalDocument || openingLegalKind !== null}
            >
              {openingLegalKind === kind ? 'Opening…' : label}
            </button>
          ))}
        </div>

        <p className="text-xs leading-relaxed text-system-gray-500">
          Built with Llama. Meta Llama 3.2 is licensed under the Llama 3.2 Community License. Full
          notices ship with the app.
        </p>
      </div>
    </SettingsCard>
  );
}

AboutSection.propTypes = {
  addNotification: PropTypes.func
};

export default AboutSection;

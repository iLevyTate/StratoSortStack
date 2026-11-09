import React, { useCallback, useEffect, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import NumericSettingInput from './NumericSettingInput';
import Switch from '../ui/Switch';
import SettingRow from './SettingRow';
import SettingsCard from './SettingsCard';
import CloudAIConsentModal, { hasAcknowledgedCloudAI } from '../common/CloudAIConsentModal';
import { useAppSelector } from '../../store/hooks';
import { getElectronAPI } from '../../services/ipc';
import { DEFAULT_SETTINGS } from '../../../shared/defaultSettings';
import { isCloudProviderId, resolveOperationProviderId } from '../../../shared/aiProviderRouting';

const BYTES_PER_MB = 1024 * 1024;
const CONCURRENCY_MIN = 1;
// Effective ceiling is CONCURRENCY.MAX_WORKERS (8) in the analysis pipeline;
// the UI mirrors that so a manual value can't be set higher than it can run.
const CONCURRENCY_MAX = 8;
const FILE_SIZE_MIN_MB = 1;
// Mirror settingsValidation's VALIDATION_RULES ceilings (in MB).
const MAX_IMAGE_FILE_MB = 500;
const MAX_DOCUMENT_FILE_MB = 500;
const MAX_TEXT_FILE_MB = 200;

function bytesToMb(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  return Math.round(bytes / BYTES_PER_MB);
}

function mbToBytes(mb) {
  if (!Number.isFinite(mb)) return null;
  return Math.round(mb) * BYTES_PER_MB;
}

/**
 * The cloud provider that video analysis could send frames to: the Analysis
 * provider when it is a cloud one, else the first override of a smart folder
 * that still exists and uses one. Null when every analysis stays local.
 *
 * Deleting a smart folder leaves its override in settings; such an override
 * can never route a file, so it must not make the keyframe switch ask for
 * cloud consent.
 * @param {any} aiSettings
 * @param {any[] | null | undefined} smartFolders
 * @returns {string | null}
 */
export function cloudAnalysisProviderOf(aiSettings, smartFolders) {
  const analyze = resolveOperationProviderId(aiSettings, 'analyze');
  if (isCloudProviderId(analyze)) return analyze;
  const liveIds = new Set(
    (Array.isArray(smartFolders) ? smartFolders : [])
      .map((folder) => (folder?.id == null ? null : String(folder.id)))
      .filter(Boolean)
  );
  const overrides = Object.entries(aiSettings?.routing?.perFolder || {});
  const live = overrides.find(([folderId, id]) => liveIds.has(folderId) && isCloudProviderId(id));
  return live ? live[1] : null;
}

/**
 * Processing limits - advanced settings for file size and concurrency.
 *
 * Uses NumericSettingInput so invalid keystrokes surface a role="alert"
 * inline message (WCAG 3.3.1) instead of being silently dropped or clamped.
 */
function ProcessingLimitsSection({ settings, setSettings }) {
  const [recommendedConcurrency, setRecommendedConcurrency] = useState(null);
  const cloudAnalysisProvider = useAppSelector((s) =>
    cloudAnalysisProviderOf(s.aiProvider?.settings, s.files?.smartFolders)
  );
  const consentCurrent = useAppSelector((s) => hasAcknowledgedCloudAI(s));
  // Cloud provider awaiting the user's answer before frames may be sent.
  const [pendingFrameConsent, setPendingFrameConsent] = useState(null);

  useEffect(() => {
    const api = getElectronAPI();
    if (api?.system?.getRecommendedConcurrency) {
      api.system
        .getRecommendedConcurrency()
        .then((r) => {
          if (r && typeof r.maxConcurrent === 'number') {
            setRecommendedConcurrency(r.maxConcurrent);
          }
          return undefined;
        })
        .catch(() => {});
    }
  }, []);

  const updateSetting = useCallback(
    (key, value) => {
      setSettings((prev) => ({ ...prev, [key]: value }));
    },
    [setSettings]
  );

  const autoConcurrency = useMemo(
    () => (settings.autoConcurrency ?? DEFAULT_SETTINGS.autoConcurrency) !== false,
    [settings.autoConcurrency]
  );

  const maxConcurrent = useMemo(() => {
    const raw = settings.maxConcurrentAnalysis ?? DEFAULT_SETTINGS.maxConcurrentAnalysis;
    const num = Number(raw);
    return Number.isFinite(num) ? num : CONCURRENCY_MIN;
  }, [settings.maxConcurrentAnalysis]);

  // Toggling auto OFF seeds the manual field from the live hardware
  // recommendation rather than any stale stored override, so power users start
  // from a sensible, hardware-correct value.
  const handleAutoToggle = useCallback(
    (checked) => {
      setSettings((prev) => {
        const next = { ...prev, autoConcurrency: checked };
        if (!checked && recommendedConcurrency != null) {
          next.maxConcurrentAnalysis = Math.max(
            CONCURRENCY_MIN,
            Math.min(recommendedConcurrency, CONCURRENCY_MAX)
          );
        }
        return next;
      });
    },
    [setSettings, recommendedConcurrency]
  );

  const maxImageFileSizeMb = useMemo(
    () => bytesToMb(settings.maxImageFileSize ?? DEFAULT_SETTINGS.maxImageFileSize),
    [settings.maxImageFileSize]
  );

  const maxDocumentFileSizeMb = useMemo(
    () => bytesToMb(settings.maxDocumentFileSize ?? DEFAULT_SETTINGS.maxDocumentFileSize),
    [settings.maxDocumentFileSize]
  );

  const maxTextFileSizeMb = useMemo(
    () => bytesToMb(settings.maxTextFileSize ?? DEFAULT_SETTINGS.maxTextFileSize),
    [settings.maxTextFileSize]
  );

  const handleConcurrencyCommit = useCallback(
    (next) => updateSetting('maxConcurrentAnalysis', next),
    [updateSetting]
  );

  const handleFileSizeCommit = useCallback(
    (key) => (mb) => {
      const bytes = mbToBytes(mb);
      if (bytes != null) updateSetting(key, bytes);
    },
    [updateSetting]
  );

  const captionVideoKeyframes =
    (settings.captionVideoKeyframes ?? DEFAULT_SETTINGS.captionVideoKeyframes) === true;

  // Turning keyframes on while Analysis uses a cloud provider lets frames
  // leave the machine. A user whose consent predates frames sees the current
  // consent text first; "Keep local" leaves the setting off.
  const handleKeyframeToggle = (checked) => {
    if (checked === true && cloudAnalysisProvider && !consentCurrent) {
      setPendingFrameConsent(cloudAnalysisProvider);
      return;
    }
    updateSetting('captionVideoKeyframes', checked === true);
  };

  return (
    <SettingsCard
      title="Processing limits"
      description="File size limits and analysis concurrency. Adjust for your hardware."
    >
      <SettingRow
        label="Hardware-aware concurrency"
        description={
          autoConcurrency && recommendedConcurrency != null
            ? `Auto: using ${recommendedConcurrency} file${
                recommendedConcurrency === 1 ? '' : 's'
              } at a time, matched to your detected GPU, CPU, and RAM.`
            : 'When on, concurrency is chosen automatically from your hardware. Turn off to set it manually.'
        }
      >
        <Switch
          checked={autoConcurrency}
          onChange={handleAutoToggle}
          aria-label="Toggle hardware-aware concurrency"
        />
      </SettingRow>

      {!autoConcurrency && (
        <SettingRow
          layout="col"
          label="Concurrent analysis (manual)"
          description={
            recommendedConcurrency != null
              ? `System recommends ${recommendedConcurrency}. Higher values need more VRAM/RAM and can slow things down or crash on limited hardware.`
              : 'Number of files analyzed in parallel. Higher values need more VRAM/RAM.'
          }
        >
          <NumericSettingInput
            value={maxConcurrent}
            onCommit={handleConcurrencyCommit}
            min={CONCURRENCY_MIN}
            max={CONCURRENCY_MAX}
            fallback={DEFAULT_SETTINGS.maxConcurrentAnalysis}
            className="w-24"
            ariaLabel="Max concurrent analysis"
          />
        </SettingRow>
      )}

      <SettingRow
        layout="col"
        label="Max image file size (MB)"
        description="Maximum size for image analysis."
      >
        <NumericSettingInput
          value={maxImageFileSizeMb}
          onCommit={handleFileSizeCommit('maxImageFileSize')}
          min={FILE_SIZE_MIN_MB}
          max={MAX_IMAGE_FILE_MB}
          fallback={bytesToMb(DEFAULT_SETTINGS.maxImageFileSize)}
          className="w-24"
          ariaLabel="Max image file size in MB"
        />
      </SettingRow>

      <SettingRow
        layout="col"
        label="Max document file size (MB)"
        description="Maximum size for document extraction."
      >
        <NumericSettingInput
          value={maxDocumentFileSizeMb}
          onCommit={handleFileSizeCommit('maxDocumentFileSize')}
          min={FILE_SIZE_MIN_MB}
          max={MAX_DOCUMENT_FILE_MB}
          fallback={bytesToMb(DEFAULT_SETTINGS.maxDocumentFileSize)}
          className="w-24"
          ariaLabel="Max document file size in MB"
        />
      </SettingRow>

      <SettingRow
        layout="col"
        label="Max text file size (MB)"
        description="Maximum size for plain-text and code file analysis."
      >
        <NumericSettingInput
          value={maxTextFileSizeMb}
          onCommit={handleFileSizeCommit('maxTextFileSize')}
          min={FILE_SIZE_MIN_MB}
          max={MAX_TEXT_FILE_MB}
          fallback={bytesToMb(DEFAULT_SETTINGS.maxTextFileSize)}
          className="w-24"
          ariaLabel="Max text file size in MB"
        />
      </SettingRow>

      <SettingRow
        label="Describe video keyframes"
        description={
          captionVideoKeyframes
            ? 'On: each video also gets scene-change frames. If Analysis uses a cloud provider, up to four frames are sent to it with the transcript; otherwise the local vision model describes up to 6 of them (often 30 to 90 seconds on CPU).'
            : 'Off: videos are analyzed from their audio transcript only; no frames are extracted or sent anywhere. Turn on to add what is on screen, at the cost of ffmpeg scene detection plus local vision calls, or up to four frames sent to a cloud Analysis provider.'
        }
      >
        <Switch
          checked={captionVideoKeyframes}
          onChange={handleKeyframeToggle}
          aria-label="Toggle video keyframe descriptions"
        />
      </SettingRow>

      {pendingFrameConsent && (
        <CloudAIConsentModal
          provider={pendingFrameConsent}
          onAccept={() => {
            setPendingFrameConsent(null);
            updateSetting('captionVideoKeyframes', true);
          }}
          onDecline={() => setPendingFrameConsent(null)}
        />
      )}
    </SettingsCard>
  );
}

ProcessingLimitsSection.propTypes = {
  settings: PropTypes.object.isRequired,
  setSettings: PropTypes.func.isRequired
};

export default ProcessingLimitsSection;

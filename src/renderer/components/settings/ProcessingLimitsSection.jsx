import React, { useCallback, useEffect, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import NumericSettingInput from './NumericSettingInput';
import Switch from '../ui/Switch';
import SettingRow from './SettingRow';
import SettingsCard from './SettingsCard';
import { getElectronAPI } from '../../services/ipc';
import { DEFAULT_SETTINGS } from '../../../shared/defaultSettings';

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
 * Processing limits - advanced settings for file size and concurrency.
 *
 * Uses NumericSettingInput so invalid keystrokes surface a role="alert"
 * inline message (WCAG 3.3.1) instead of being silently dropped or clamped.
 */
function ProcessingLimitsSection({ settings, setSettings }) {
  const [recommendedConcurrency, setRecommendedConcurrency] = useState(null);

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
            ? 'On: each video also gets scene-change frames described by the vision model and merged into its transcript. Adds ffmpeg scene detection plus up to 6 vision-model calls per video (often 30 to 90 seconds on CPU).'
            : 'Off: videos are analyzed from their audio transcript only; no frames are extracted. Turn on to add visual descriptions, at the cost of ffmpeg scene detection plus up to 6 vision-model calls per video.'
        }
      >
        <Switch
          checked={captionVideoKeyframes}
          onChange={(checked) => updateSetting('captionVideoKeyframes', checked === true)}
          aria-label="Toggle video keyframe descriptions"
        />
      </SettingRow>
    </SettingsCard>
  );
}

ProcessingLimitsSection.propTypes = {
  settings: PropTypes.object.isRequired,
  setSettings: PropTypes.func.isRequired
};

export default ProcessingLimitsSection;

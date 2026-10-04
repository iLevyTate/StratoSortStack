import React, { useMemo, useCallback } from 'react';
import PropTypes from 'prop-types';
import Switch from '../ui/Switch';
import Select from '../ui/Select';
import Textarea from '../ui/Textarea';
import SettingRow from './SettingRow';
import SettingsCard from './SettingsCard';
import SettingsGroup from './SettingsGroup';
import { Text } from '../ui/Typography';

const DEFAULT_CONFIDENCE = 0.75; // 75%
const CONFIDENCE_MIN = 0.5; // 50%
const CONFIDENCE_MAX = 0.95; // 95%
const ORG_GUIDANCE_MAX_LENGTH = 2048; // mirrors settingsValidation.organizationCustomGuidance

/**
 * AutoOrganizeSection - Settings for automatic file organization
 *
 * Controls:
 * - autoOrganize: Enable/disable auto-organize for new downloads
 * - confidenceThreshold: Minimum confidence (0-1) required to auto-move files
 */
function AutoOrganizeSection({ settings, setSettings }) {
  const updateSetting = useCallback(
    (key, value) => {
      setSettings((prev) => ({
        ...prev,
        [key]: value
      }));
    },
    [setSettings]
  );

  const storedConfidence = useMemo(() => {
    const raw = settings.confidenceThreshold ?? DEFAULT_CONFIDENCE;
    return Number.isFinite(raw) ? raw : DEFAULT_CONFIDENCE;
  }, [settings.confidenceThreshold]);
  const clampedConfidence = Math.min(CONFIDENCE_MAX, Math.max(CONFIDENCE_MIN, storedConfidence));
  // Display the value the backend actually honors. Validation accepts 0–1,
  // so a stored 30% is enforced at 30% — showing the slider-clamped 50%
  // here would misrepresent the effective threshold.
  const confidencePercent = Math.round(storedConfidence * 100);
  const confidenceSliderValue = Math.round(clampedConfidence * 100);
  const confidenceOutOfSliderRange =
    storedConfidence < CONFIDENCE_MIN || storedConfidence > CONFIDENCE_MAX;

  const orgGuidance = settings.organizationCustomGuidance || '';
  const orgGuidanceRemaining = ORG_GUIDANCE_MAX_LENGTH - orgGuidance.length;

  return (
    <SettingsCard
      title="Auto-organize"
      description="Configure how new downloads are routed and when automation kicks in."
    >
      <SettingRow
        label="Auto-organize Downloads"
        description="Automatically organize new files detected in your download folder."
      >
        <Switch
          checked={settings.autoOrganize || false}
          onChange={(checked) => updateSetting('autoOrganize', checked)}
          aria-label="Toggle auto-organize downloads"
        />
      </SettingRow>

      <SettingRow
        label="Watch smart folders"
        description="Analyze files as they land in your smart folders while the app is open. Turn off to analyze only what you pick in Discover."
      >
        <Switch
          checked={settings.smartFolderWatchEnabled !== false}
          onChange={(checked) => updateSetting('smartFolderWatchEnabled', checked)}
          aria-label="Toggle smart folder watching"
        />
      </SettingRow>

      <SettingRow
        label="Smart Folder routing"
        description="How a file chooses a destination. Auto and Embedding-first compare the file's meaning to each folder's description (vectors). Hybrid lets the language model propose and vectors override when they are more sure. LLM-only matches the model's category to folder names and keywords."
      >
        <Select
          id="settings-smart-folder-routing"
          value={settings.smartFolderRoutingMode || 'auto'}
          onChange={(e) => updateSetting('smartFolderRoutingMode', e.target.value)}
          aria-label="Smart folder routing mode"
          className="w-full"
        >
          <option value="auto">
            Auto (recommended) — meaning first when folder vectors are ready
          </option>
          <option value="embedding">Embedding-first — closest folder by meaning</option>
          <option value="hybrid">Hybrid — language model first, vectors can override</option>
          <option value="llm">LLM-only — category and keywords, no vectors</option>
        </Select>
      </SettingRow>
      {settings.smartFolderRoutingMode !== 'llm' &&
        (settings.defaultEmbeddingPolicy === 'skip' ||
          settings.defaultEmbeddingPolicy === 'web_only' ||
          settings.embeddingTiming === 'manual') && (
          <Text variant="tiny" className="text-stratosort-warning">
            Folder choice still compares this analysis to folder descriptions, but search will not
            store file vectors while embedding policy is skip/web-only or timing is manual. Use
            Embed locally and During analysis so Search, Relate, and Atlas stay in sync with
            Organize.
          </Text>
        )}

      {/* Confidence threshold - only shown when autoOrganize is enabled */}
      {settings.autoOrganize && (
        <SettingsGroup gap="cozy">
          <div className="flex items-center justify-between">
            <Text as="span" variant="small" className="font-medium text-system-gray-700">
              Minimum confidence
            </Text>
            <Text as="span" variant="small" className="font-medium text-stratosort-blue">
              {confidencePercent}%
            </Text>
          </div>
          <Text variant="tiny" className="text-system-gray-500">
            Files must meet this confidence level to be automatically organized. Lower confidence
            matches require manual review.
          </Text>
          {confidenceOutOfSliderRange && (
            <Text variant="tiny" className="text-stratosort-warning">
              The saved value ({confidencePercent}%) is outside the slider&apos;s{' '}
              {Math.round(CONFIDENCE_MIN * 100)}–{Math.round(CONFIDENCE_MAX * 100)}% range. It still
              applies as saved; moving the slider will replace it.
            </Text>
          )}
          <input
            type="range"
            min={Math.round(CONFIDENCE_MIN * 100)}
            max={Math.round(CONFIDENCE_MAX * 100)}
            step="1"
            value={confidenceSliderValue}
            onChange={(e) => {
              const next = Number(e.target.value);
              const normalized = Math.min(CONFIDENCE_MAX, Math.max(CONFIDENCE_MIN, next / 100));
              updateSetting('confidenceThreshold', normalized);
            }}
            aria-label="Minimum confidence threshold"
            className="w-full accent-stratosort-blue"
          />
        </SettingsGroup>
      )}

      <SettingRow
        layout="col"
        label="Organization instructions"
        description="Optional global guidance the AI applies when choosing a folder for every file (document and image analysis). Use it for workspace-wide rules — unlike a folder's description, which only describes that one folder."
      >
        <Textarea
          value={orgGuidance}
          maxLength={ORG_GUIDANCE_MAX_LENGTH}
          onChange={(e) => updateSetting('organizationCustomGuidance', e.target.value)}
          rows={4}
          placeholder="e.g. Group invoices by vendor. Keep anything tax-related in Finance. Prefer project folders over generic ones when a project name appears."
          className="text-sm font-mono leading-relaxed min-h-[6rem] py-2"
          aria-label="Global organization instructions"
          aria-describedby="organization-guidance-hint"
        />
        <Text
          id="organization-guidance-hint"
          variant="tiny"
          className="text-system-gray-500 mt-1 leading-relaxed"
        >
          {orgGuidance.trim()
            ? `Applied to every file's analysis. ${orgGuidanceRemaining} characters remaining. The AI still only uses folders from your smart-folder list.`
            : `Optional. Up to ${ORG_GUIDANCE_MAX_LENGTH} characters. The AI never invents folders outside your smart-folder list.`}
        </Text>
      </SettingRow>
    </SettingsCard>
  );
}

AutoOrganizeSection.propTypes = {
  settings: PropTypes.object.isRequired,
  setSettings: PropTypes.func.isRequired
};

export default AutoOrganizeSection;

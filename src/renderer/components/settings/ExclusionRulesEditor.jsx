import React, { useCallback, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { Plus, X } from 'lucide-react';
import Button from '../ui/Button';
import Input from '../ui/Input';
import { Caption, Text } from '../ui/Typography';
import SettingRow from './SettingRow';
import SettingsCard from './SettingsCard';
import SettingsGroup from './SettingsGroup';
import { DEFAULT_EXCLUSION_GLOBS } from '../../../shared/config/exclusionRulesSchema';

/**
 * ExclusionRulesEditor
 *
 * Lets users add/remove glob patterns that the Downloads watcher, the Smart
 * Folder watchers and the Downloads triage sweep always skip. The sweep
 * merges user globs with the built-in DEFAULT_EXCLUSION_GLOBS at scan time;
 * the watchers apply the user globs on top of their own temp-file gates
 * (see `src/main/services/watcherExclusions.js`). Users only see and edit
 * their additions here.
 *
 * The list is stored in settings under `downloadsTriageExclusions`. The
 * sweep receives it on every run and the watchers read it from the cached
 * settings snapshot; there is no separate persistence hook in this component.
 */
// Mirrors the save-time sanitizer's entry cap for downloadsTriageExclusions.
const MAX_USER_GLOBS = 200;

export default function ExclusionRulesEditor({ settings, setSettings }) {
  const userGlobs = useMemo(() => {
    const value = settings?.downloadsTriageExclusions;
    return Array.isArray(value) ? value : [];
  }, [settings?.downloadsTriageExclusions]);

  const [draft, setDraft] = useState('');

  const commit = useCallback(
    (next) => {
      setSettings((prev) => ({
        ...prev,
        downloadsTriageExclusions: next
      }));
    },
    [setSettings]
  );

  const handleAdd = useCallback(() => {
    const trimmed = String(draft || '').trim();
    if (!trimmed || trimmed.length > 256) return;
    // Enforce the cap here, not just on the Add button's disabled state —
    // the Enter key also lands in this handler. Without this the 201st chip
    // rendered normally and was then silently stripped by the sanitizer on
    // the next save.
    if (userGlobs.length >= MAX_USER_GLOBS) return;
    if (userGlobs.includes(trimmed)) {
      setDraft('');
      return;
    }
    commit([...userGlobs, trimmed]);
    setDraft('');
  }, [draft, userGlobs, commit]);

  const handleRemove = useCallback(
    (pattern) => {
      commit(userGlobs.filter((g) => g !== pattern));
    },
    [userGlobs, commit]
  );

  const handleKeyDown = useCallback(
    (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        handleAdd();
      }
    },
    [handleAdd]
  );

  return (
    <SettingsCard
      title="Exclusion rules"
      description="Glob patterns that the Downloads watcher, Smart Folder watchers and the Downloads triage sweep always skip. In Downloads, the watcher and the sweep also apply built-in defaults (installers, partial downloads, OS scratch files); your additions live on top."
    >
      <SettingRow
        label="Your exclusion globs"
        description="Example: *.iso, setup-*.exe, **/archived/**"
        layout="col"
      >
        <SettingsGroup gap="compact">
          <div className="flex items-center gap-compact">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="e.g. *.iso"
              aria-label="Add exclusion glob"
              className="flex-1"
              maxLength={256}
            />
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={handleAdd}
              disabled={!draft.trim() || userGlobs.length >= MAX_USER_GLOBS}
              leftIcon={<Plus className="w-4 h-4" />}
            >
              Add
            </Button>
          </div>

          {userGlobs.length === 0 ? (
            <Text variant="tiny" className="text-system-gray-500">
              No custom exclusions yet. The built-in defaults still apply in Downloads.
            </Text>
          ) : (
            <ul className="flex flex-wrap gap-compact" aria-label="Custom exclusion globs">
              {userGlobs.map((pattern) => (
                <li
                  key={pattern}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-system-gray-100 border border-system-gray-200 text-sm font-mono"
                >
                  <span className="text-system-gray-700">{pattern}</span>
                  <button
                    type="button"
                    onClick={() => handleRemove(pattern)}
                    className="text-system-gray-500 hover:text-stratosort-danger"
                    aria-label={`Remove exclusion ${pattern}`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <Caption className="text-system-gray-500">
            {userGlobs.length} custom glob{userGlobs.length === 1 ? '' : 's'} ·{' '}
            {DEFAULT_EXCLUSION_GLOBS.length} built-in defaults
          </Caption>
        </SettingsGroup>
      </SettingRow>
    </SettingsCard>
  );
}

ExclusionRulesEditor.propTypes = {
  settings: PropTypes.object.isRequired,
  setSettings: PropTypes.func.isRequired
};

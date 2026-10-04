import React, { useState, useMemo, useCallback } from 'react';
import PropTypes from 'prop-types';
import Select from '../ui/Select';
import Input from '../ui/Input';
import Textarea from '../ui/Textarea';
import Button from '../ui/Button';
import SettingRow from './SettingRow';
import SettingsCard from './SettingsCard';
import { Text } from '../ui/Typography';
import {
  CHAT_PERSONAS,
  DEFAULT_CHAT_PERSONA_ID,
  CUSTOM_PERSONA_LIMITS,
  CUSTOM_PERSONA_ID_PATTERN,
  CUSTOM_PERSONA_ID_PREFIX,
  sanitizeCustomPersona,
  getAllChatPersonas
} from '../../../shared/chatPersonas';

const CUSTOM_GUIDANCE_MAX_LENGTH = 2048;

/** Inline help under custom-persona editor fields — mirrors chatPersonas.js rules. */
const PERSONA_FIELD_HINTS = {
  id: `Required. Use lowercase letters, digits, hyphens (-), and underscores (_). Must start with a letter or digit — not _ or -. No spaces or uppercase. Max ${CUSTOM_PERSONA_LIMITS.MAX_ID_LENGTH} characters. Examples: legal-reviewer, persona_v2.`,
  label: `Required. Name shown in the persona dropdown. Max ${CUSTOM_PERSONA_LIMITS.MAX_LABEL_LENGTH} characters. Any readable text (including spaces and capitals).`,
  description: `Optional. Short note shown under the dropdown when this persona is selected. Max ${CUSTOM_PERSONA_LIMITS.MAX_DESCRIPTION_LENGTH} characters.`,
  guidance: `Required. Tone and rules sent to the model for this persona. Max ${CUSTOM_PERSONA_LIMITS.MAX_GUIDANCE_LENGTH} characters. Plain text in any language; do not use this field for the id rules above.`
};

function FieldHint({ id, children }) {
  return (
    <Text id={id} variant="tiny" className="text-system-gray-500 mt-0.5 leading-relaxed">
      {children}
    </Text>
  );
}

FieldHint.propTypes = {
  id: PropTypes.string,
  children: PropTypes.node.isRequired
};

/**
 * Sanitize-and-merge: drops malformed entries the same way the main-side
 * helper does, but called eagerly in the renderer so the dropdown only
 * shows valid personas before the user clicks Save. Mirrors the
 * canonical sanitizer to keep the displayed list and the saved list in
 * lockstep.
 */
function safeCustomPersonas(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    if (out.length >= CUSTOM_PERSONA_LIMITS.MAX_COUNT) break;
    const cleaned = sanitizeCustomPersona(entry);
    if (!cleaned) continue;
    if (seen.has(cleaned.id)) continue;
    seen.add(cleaned.id);
    out.push(cleaned);
  }
  return out;
}

const CHAT_RESPONSE_MODES = [
  {
    value: 'fast',
    label: 'Fast',
    description: 'Quick response with keyword expansion and spell check.'
  },
  {
    value: 'deep',
    label: 'Deep',
    description: 'Slower, more accurate response with LLM re-ranking.'
  }
];

function ChatPersonaSection({ settings, setSettings }) {
  const currentValue = settings.chatPersona || DEFAULT_CHAT_PERSONA_ID;
  const responseMode = settings.chatResponseMode === 'deep' ? 'deep' : 'fast';
  const customGuidance = settings.chatPersonaCustomGuidance || '';
  const remaining = CUSTOM_GUIDANCE_MAX_LENGTH - customGuidance.length;
  const customPersonas = useMemo(
    () => safeCustomPersonas(settings.customChatPersonas || []),
    [settings.customChatPersonas]
  );
  const allPersonas = useMemo(
    () => getAllChatPersonas(settings.customChatPersonas || []),
    [settings.customChatPersonas]
  );

  // Local form state for the "+ Add custom persona" inline editor.
  // Kept in component state — only commits to settings when the user
  // clicks Save, so a half-typed persona doesn't pollute the saved list.
  const [showEditor, setShowEditor] = useState(false);
  const [draft, setDraft] = useState({ id: '', label: '', description: '', guidance: '' });
  const [editingId, setEditingId] = useState(null);
  const [error, setError] = useState('');

  const resetDraft = useCallback(() => {
    setDraft({ id: '', label: '', description: '', guidance: '' });
    setEditingId(null);
    setError('');
  }, []);

  const startCreate = () => {
    resetDraft();
    setShowEditor(true);
  };

  const startEdit = (persona) => {
    // Strip the prefix for the editor — it's a UI concern; the
    // sanitizer re-applies it on save so the wire format is stable.
    const bareId = persona.id.startsWith(CUSTOM_PERSONA_ID_PREFIX)
      ? persona.id.slice(CUSTOM_PERSONA_ID_PREFIX.length)
      : persona.id;
    setDraft({
      id: bareId,
      label: persona.label || '',
      description: persona.description || '',
      guidance: persona.guidance || ''
    });
    setEditingId(persona.id);
    setError('');
    setShowEditor(true);
  };

  const cancelEdit = () => {
    setShowEditor(false);
    resetDraft();
  };

  const saveDraft = () => {
    setError('');
    const trimmedId = draft.id.trim().toLowerCase();
    if (!trimmedId || !CUSTOM_PERSONA_ID_PATTERN.test(trimmedId)) {
      setError('Id must start with a letter or digit and contain only a-z, 0-9, _ or -.');
      return;
    }
    if (!draft.label.trim()) {
      setError('Label is required.');
      return;
    }
    if (!draft.guidance.trim()) {
      setError('Guidance is required.');
      return;
    }
    const cleaned = sanitizeCustomPersona({
      id: trimmedId,
      label: draft.label,
      description: draft.description,
      guidance: draft.guidance
    });
    if (!cleaned) {
      setError('Could not save persona — please check the fields.');
      return;
    }
    // Uniqueness must be checked BEFORE committing, and must block the save
    // with a visible error. Previously a duplicate id on create bailed out of
    // the state updater silently while the editor still closed as if it had
    // saved, and renaming a persona onto an existing id produced two entries
    // with the same id — the first-wins dedupe then silently deleted one.
    const collides = customPersonas.some((p) => p.id === cleaned.id && p.id !== editingId);
    if (collides) {
      setError(`A persona with id "${cleaned.id}" already exists. Choose a different id.`);
      return;
    }
    setSettings((prev) => {
      const existing = safeCustomPersonas(prev.customChatPersonas || []);
      const next = editingId
        ? existing.map((p) => (p.id === editingId ? cleaned : p))
        : [...existing, cleaned];
      // Switch active persona to the just-saved one for instant feedback.
      return {
        ...prev,
        customChatPersonas: next,
        chatPersona: cleaned.id
      };
    });
    setShowEditor(false);
    resetDraft();
  };

  const deletePersona = (id) => {
    setSettings((prev) => {
      const filtered = safeCustomPersonas(prev.customChatPersonas || []).filter((p) => p.id !== id);
      const next = { ...prev, customChatPersonas: filtered };
      // If the deleted persona was the active one, fall back to default.
      if (prev.chatPersona === id) {
        next.chatPersona = DEFAULT_CHAT_PERSONA_ID;
      }
      return next;
    });
  };

  const selectedPersona = allPersonas.find((p) => p.id === currentValue);
  const atCap = customPersonas.length >= CUSTOM_PERSONA_LIMITS.MAX_COUNT;

  return (
    <SettingsCard
      title="Chat persona"
      description="Choose the default tone and interaction style for chat responses, or create your own."
    >
      <SettingRow
        layout="col"
        label="Persona preset"
        description="Applies globally to chat responses."
      >
        <Select
          value={currentValue}
          onChange={(e) =>
            setSettings((prev) => ({
              ...prev,
              chatPersona: e.target.value
            }))
          }
          className="w-full"
        >
          <optgroup label="Built-in">
            {CHAT_PERSONAS.map((persona) => (
              <option key={persona.id} value={persona.id}>
                {persona.label}
              </option>
            ))}
          </optgroup>
          {customPersonas.length > 0 && (
            <optgroup label="Custom">
              {customPersonas.map((persona) => (
                <option key={persona.id} value={persona.id}>
                  {persona.label}
                </option>
              ))}
            </optgroup>
          )}
        </Select>
        <Text variant="tiny" className="text-system-gray-500 mt-1">
          {selectedPersona?.description || ''}
        </Text>
      </SettingRow>

      <SettingRow
        layout="col"
        label="Response detail"
        description="Default depth for chat answers. The search chat panel mirrors this and can override it per-session."
      >
        <Select
          value={responseMode}
          onChange={(e) =>
            setSettings((prev) => ({
              ...prev,
              chatResponseMode: e.target.value === 'deep' ? 'deep' : 'fast'
            }))
          }
          className="w-full"
        >
          {CHAT_RESPONSE_MODES.map((mode) => (
            <option key={mode.value} value={mode.value}>
              {mode.label}
            </option>
          ))}
        </Select>
        <Text variant="tiny" className="text-system-gray-500 mt-1">
          {CHAT_RESPONSE_MODES.find((m) => m.value === responseMode)?.description || ''}
        </Text>
      </SettingRow>

      <SettingRow
        layout="col"
        label="Custom personas"
        description={`Create reusable presets with their own tone. Each needs a unique id (slug rules below), label, and guidance. Up to ${CUSTOM_PERSONA_LIMITS.MAX_COUNT} personas — ${customPersonas.length}/${CUSTOM_PERSONA_LIMITS.MAX_COUNT} used.`}
      >
        {customPersonas.length === 0 && !showEditor && (
          <Text variant="tiny" className="text-system-gray-500">
            None yet. Create one to use it as a chat persona preset.
          </Text>
        )}
        {customPersonas.length > 0 && (
          <ul className="space-y-2 mb-2">
            {customPersonas.map((persona) => (
              <li
                key={persona.id}
                className="flex items-start justify-between rounded-md border border-border-soft bg-surface-primary p-2"
              >
                <div className="min-w-0 flex-1 pr-2">
                  <Text variant="body" className="font-medium text-system-gray-700 truncate">
                    {persona.label}
                  </Text>
                  {persona.description && (
                    <Text variant="tiny" className="text-system-gray-500 truncate">
                      {persona.description}
                    </Text>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button size="sm" variant="secondary" onClick={() => startEdit(persona)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => deletePersona(persona.id)}>
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {!showEditor && (
          <Button size="sm" variant="secondary" onClick={startCreate} disabled={atCap}>
            {atCap ? 'Maximum reached' : '+ Add custom persona'}
          </Button>
        )}
        {showEditor && (
          <div className="rounded-md border border-border-soft bg-surface-muted p-3 space-y-2">
            <Text variant="body" className="font-medium text-system-gray-700">
              {editingId ? 'Edit persona' : 'New persona'}
            </Text>
            <Input
              type="text"
              placeholder="id (e.g. legal-reviewer)"
              value={draft.id}
              maxLength={CUSTOM_PERSONA_LIMITS.MAX_ID_LENGTH}
              onChange={(e) => setDraft((d) => ({ ...d, id: e.target.value }))}
              className="font-mono text-sm py-2"
              aria-label="Persona id"
              aria-describedby="persona-id-hint"
            />
            <FieldHint id="persona-id-hint">{PERSONA_FIELD_HINTS.id}</FieldHint>
            <Input
              type="text"
              placeholder="label (shown in dropdown)"
              value={draft.label}
              maxLength={CUSTOM_PERSONA_LIMITS.MAX_LABEL_LENGTH}
              onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
              className="text-sm py-2"
              aria-label="Persona label"
              aria-describedby="persona-label-hint"
            />
            <FieldHint id="persona-label-hint">{PERSONA_FIELD_HINTS.label}</FieldHint>
            <Input
              type="text"
              placeholder="description (optional, shown under dropdown)"
              value={draft.description}
              maxLength={CUSTOM_PERSONA_LIMITS.MAX_DESCRIPTION_LENGTH}
              onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              className="text-sm py-2"
              aria-label="Persona description"
              aria-describedby="persona-description-hint"
            />
            <FieldHint id="persona-description-hint">{PERSONA_FIELD_HINTS.description}</FieldHint>
            <Textarea
              placeholder="guidance — sent to the LLM as the system prompt for this persona"
              value={draft.guidance}
              maxLength={CUSTOM_PERSONA_LIMITS.MAX_GUIDANCE_LENGTH}
              rows={4}
              onChange={(e) => setDraft((d) => ({ ...d, guidance: e.target.value }))}
              className="text-sm font-mono leading-relaxed min-h-[6rem] py-2"
              aria-label="Persona guidance"
              aria-describedby="persona-guidance-hint"
            />
            <FieldHint id="persona-guidance-hint">{PERSONA_FIELD_HINTS.guidance}</FieldHint>
            {error && (
              <Text variant="tiny" className="text-system-red-600">
                {error}
              </Text>
            )}
            <div className="flex justify-end gap-compact">
              <Button size="sm" variant="secondary" onClick={cancelEdit}>
                Cancel
              </Button>
              <Button size="sm" variant="success" onClick={saveDraft}>
                Save
              </Button>
            </div>
          </div>
        )}
      </SettingRow>

      <SettingRow
        layout="col"
        label="Custom instructions"
        description="Extra guidance appended to whichever persona preset is selected above. Not the same as creating a custom persona — use this for project-specific rules that apply on top of the preset."
      >
        <Textarea
          value={customGuidance}
          maxLength={CUSTOM_GUIDANCE_MAX_LENGTH}
          onChange={(e) =>
            setSettings((prev) => ({
              ...prev,
              chatPersonaCustomGuidance: e.target.value
            }))
          }
          rows={4}
          placeholder="e.g. Always respond in formal British English. Cite sources by document name and date when available. Prefer bullet lists over prose."
          className="text-sm font-mono leading-relaxed min-h-[6rem] py-2"
          aria-label="Custom persona instructions"
          aria-describedby="custom-instructions-hint"
        />
        <Text
          id="custom-instructions-hint"
          variant="tiny"
          className="text-system-gray-500 mt-1 leading-relaxed"
        >
          {customGuidance.trim()
            ? `Appended to ${selectedPersona?.label || 'persona'} guidance. ${remaining} characters remaining. Any plain text is allowed (no slug/id rules here).`
            : `Optional. Up to ${CUSTOM_GUIDANCE_MAX_LENGTH} characters. Any language, punctuation, and line breaks are fine — unlike persona ids, which are restricted to lowercase slugs.`}
        </Text>
      </SettingRow>
    </SettingsCard>
  );
}

ChatPersonaSection.propTypes = {
  settings: PropTypes.object.isRequired,
  setSettings: PropTypes.func.isRequired
};

export default ChatPersonaSection;

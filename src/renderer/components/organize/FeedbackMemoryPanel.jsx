import React, { useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { Trash2, Info, Pencil } from 'lucide-react';
import { Card, Button, IconButton, StateMessage, Textarea } from '../ui';
import { Heading, Text } from '../ui/Typography';

// Matches feedbackMemoryAdd / feedbackMemoryUpdate in src/main/ipc/validationSchemas.js.
const MIN_MEMORY_LENGTH = 2;
const MAX_MEMORY_LENGTH = 500;

/**
 * Turn a failed IPC result (or a rejected invoke) into a short message. The
 * handlers resolve `{ success: false, error }` rather than throwing, and
 * `error` may be a string or an `{ code, message }` object. A schema failure
 * arrives as `error.details.validationErrors` (Zod's flatten() output), whose
 * bare message is just "Invalid input", so a bad `text` gets the length hint.
 */
function describeFailure(result, fallback) {
  if (result?.error?.details?.validationErrors?.fieldErrors?.text) {
    return `Notes must be ${MIN_MEMORY_LENGTH}-${MAX_MEMORY_LENGTH} characters.`;
  }
  const error = result?.error;
  if (typeof error === 'string' && error) return error;
  if (error && typeof error.message === 'string' && error.message) return error.message;
  if (result instanceof Error && result.message) return result.message;
  return fallback;
}

function FeedbackMemoryPanel({ className = '', refreshToken }) {
  const [memories, setMemories] = useState([]);
  const [newText, setNewText] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editingText, setEditingText] = useState('');
  const [errorMessage, setErrorMessage] = useState(null);
  const isMountedRef = React.useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const loadMemories = async () => {
    if (isMountedRef.current) setLoading(true);
    try {
      const result = await window.electronAPI?.suggestions?.getFeedbackMemory?.();
      if (isMountedRef.current && result?.success && Array.isArray(result.items)) {
        setMemories(result.items);
      }
    } catch {
      // Best-effort UI; errors are surfaced via IPC logs
    } finally {
      if (isMountedRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    loadMemories();
  }, [refreshToken]);

  const handleAdd = async () => {
    const trimmed = newText.trim();
    if (!trimmed) return;
    setSaving(true);
    setErrorMessage(null);
    try {
      const result = await window.electronAPI?.suggestions?.addFeedbackMemory?.(trimmed);
      if (isMountedRef.current) {
        if (result?.success && result.item) {
          setMemories((prev) => [result.item, ...prev]);
          setNewText('');
        } else {
          // newText is kept so the user can fix it and try again.
          setErrorMessage(describeFailure(result, 'Could not save this memory.'));
          await loadMemories();
        }
      }
    } catch (error) {
      if (isMountedRef.current) {
        setErrorMessage(describeFailure(error, 'Could not save this memory.'));
      }
    } finally {
      if (isMountedRef.current) setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!id) return;
    setErrorMessage(null);
    try {
      const result = await window.electronAPI?.suggestions?.deleteFeedbackMemory?.(id);
      if (!isMountedRef.current) return;
      // `removed: false` means the store no longer had it, so dropping the
      // row is still right. Any other failure leaves the row in place.
      if (result?.success) {
        setMemories((prev) => prev.filter((entry) => entry.id !== id));
      } else {
        setErrorMessage(describeFailure(result, 'Could not delete this memory.'));
      }
    } catch (error) {
      if (isMountedRef.current) {
        setErrorMessage(describeFailure(error, 'Could not delete this memory.'));
      }
    }
  };

  const startEditing = (entry) => {
    setEditingId(entry.id);
    setEditingText(entry.text || '');
  };

  const cancelEditing = () => {
    setEditingId(null);
    setEditingText('');
    setErrorMessage(null);
  };

  const handleUpdate = async () => {
    const trimmed = editingText.trim();
    if (!editingId || !trimmed) return;
    setErrorMessage(null);
    try {
      const result = await window.electronAPI?.suggestions?.updateFeedbackMemory?.(
        editingId,
        trimmed
      );
      if (!isMountedRef.current) return;
      if (result?.success) {
        if (result.item) {
          setMemories((prev) =>
            prev.map((entry) => (entry.id === editingId ? result.item : entry))
          );
        } else {
          // Saved against an entry that no longer exists: show the real list.
          await loadMemories();
        }
        cancelEditing();
      } else {
        // Keep the editor open with the user's text so the edit is not lost.
        setErrorMessage(describeFailure(result, 'Could not save this change.'));
      }
    } catch (error) {
      if (isMountedRef.current) {
        setErrorMessage(describeFailure(error, 'Could not save this change.'));
      }
    }
  };

  return (
    <Card className={`p-4 border-system-gray-200 ${className}`}>
      <div className="flex items-center justify-between mb-3">
        <Heading as="h3" variant="h6" className="text-system-gray-900">
          Memory & Rules
        </Heading>
        <Button size="sm" variant="ghost" onClick={loadMemories} disabled={loading}>
          Refresh
        </Button>
      </div>

      <Text variant="tiny" className="text-system-gray-600 mb-3">
        Rules and notes that adjust future suggestions. A rule like &ldquo;CSV files go to
        Bing&rdquo; moves that folder up for files of that type when it is already one of the
        folders StratoSort considers for them. Your corrections and folder descriptions are listed
        here too. Edit or delete any that are wrong.
      </Text>

      <div className="space-y-2 mb-4">
        <Textarea
          value={newText}
          onChange={(event) => setNewText(event.target.value)}
          placeholder='e.g., "All .stl files go to 3D Prints"'
          className="w-full text-sm"
          rows={2}
          maxLength={MAX_MEMORY_LENGTH}
        />
        <Button
          size="sm"
          variant="primary"
          onClick={handleAdd}
          disabled={saving || newText.trim().length < MIN_MEMORY_LENGTH}
          className="bg-stratosort-blue hover:bg-stratosort-blue/90"
        >
          Save memory
        </Button>
      </div>

      {errorMessage && (
        <Text variant="tiny" role="alert" className="text-stratosort-danger mb-3">
          {errorMessage}
        </Text>
      )}

      {loading ? (
        <Text variant="tiny" className="text-system-gray-500 animate-loading-fade">
          Loading memories...
        </Text>
      ) : memories.length === 0 ? (
        <StateMessage
          icon={Info}
          tone="neutral"
          size="sm"
          align="left"
          title="No saved memories yet"
          description="Add a note above to guide future suggestions."
          className="py-2"
        />
      ) : (
        <div className="space-y-2 max-h-48 overflow-y-auto modern-scrollbar">
          {memories.map((entry) => (
            <div
              key={entry.id}
              className="flex items-start justify-between gap-cozy rounded-md border border-system-gray-100 bg-system-gray-50 px-3 py-2"
            >
              {editingId === entry.id ? (
                <div className="flex-1 space-y-2">
                  <Textarea
                    value={editingText}
                    onChange={(event) => setEditingText(event.target.value)}
                    className="w-full text-sm"
                    rows={2}
                    maxLength={MAX_MEMORY_LENGTH}
                  />
                  <div className="flex gap-compact">
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={handleUpdate}
                      disabled={editingText.trim().length < MIN_MEMORY_LENGTH}
                    >
                      Save
                    </Button>
                    <Button size="sm" variant="ghost" onClick={cancelEditing}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <Text as="div" variant="tiny" className="text-system-gray-700">
                    <Text as="div" variant="tiny" className="font-medium text-system-gray-800">
                      {entry.text}
                    </Text>
                    {entry.targetFolder && (
                      <Text as="div" variant="tiny" className="text-system-gray-500">
                        Target: {entry.targetFolder}
                      </Text>
                    )}
                    {(entry.history || []).map((past) => (
                      <Text
                        as="div"
                        variant="tiny"
                        className="text-system-gray-500"
                        key={past.changedAt}
                      >
                        Before {new Date(past.changedAt).toLocaleDateString()}: {past.description}
                      </Text>
                    ))}
                  </Text>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      leftIcon={<Pencil className="w-3.5 h-3.5" />}
                      className="text-system-gray-500 hover:text-stratosort-blue"
                      onClick={() => startEditing(entry)}
                      aria-label="Edit memory"
                    >
                      Edit
                    </Button>
                    <IconButton
                      type="button"
                      icon={<Trash2 className="w-4 h-4" />}
                      size="sm"
                      variant="ghost"
                      className="text-system-gray-400 hover:text-stratosort-danger hover:bg-stratosort-danger/10"
                      onClick={() => handleDelete(entry.id)}
                      aria-label="Delete memory"
                    />
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

FeedbackMemoryPanel.propTypes = {
  className: PropTypes.string,
  refreshToken: PropTypes.number
};

export default FeedbackMemoryPanel;

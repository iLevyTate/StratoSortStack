import React, { useState, useRef } from 'react';
import PropTypes from 'prop-types';
import { Tag, Plus, X } from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import Input from '../ui/Input';
import { Text } from '../ui/Typography';
import { createLogger } from '../../../shared/logger';

const logger = createLogger('TagClusterModal');

/**
 * TagClusterModal
 *
 * A modal for applying tags to all files in a cluster.
 */
export default function TagClusterModal({
  isOpen,
  onClose,
  clusterName = 'Unknown',
  initialTags = [],
  onApplyTags // (tags) => Promise<void>
}) {
  const [tagInput, setTagInput] = useState('');
  const [tags, setTags] = useState([]);
  const [isApplying, setIsApplying] = useState(false);
  const [applyError, setApplyError] = useState('');
  const prevIsOpenRef = useRef(false);

  // Pre-populate only on the false→true transition of isOpen so that
  // unstable initialTags references (e.g. `|| []` in the parent) don't
  // wipe user input while the modal is open.
  React.useEffect(() => {
    const wasOpen = prevIsOpenRef.current;
    prevIsOpenRef.current = isOpen;
    if (isOpen && !wasOpen) {
      setTags(Array.isArray(initialTags) ? [...initialTags] : []);
      setApplyError('');
    }
  }, [isOpen, initialTags]);

  const handleAddTag = () => {
    const trimmed = tagInput.trim();
    if (trimmed) {
      setTags((prev) => (prev.includes(trimmed) ? prev : [...prev, trimmed]));
      setTagInput('');
    }
  };

  const handleRemoveTag = (tagToRemove) => {
    setTags((prev) => prev.filter((t) => t !== tagToRemove));
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddTag();
    }
  };

  const handleApply = async () => {
    if (tags.length === 0) return;
    setIsApplying(true);
    setApplyError('');
    try {
      await onApplyTags(tags);
      onClose();
      setTags([]);
    } catch (error) {
      logger.error('Failed to apply tags', {
        error: error?.message,
        stack: error?.stack
      });
      setApplyError(error?.message || 'Failed to apply tags. Please try again.');
    } finally {
      setIsApplying(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Tag cluster: ${clusterName}`}
      description="Add tags to all files in this cluster."
      size="sm"
      closeOnOverlayClick={!isApplying}
      closeOnEsc={!isApplying}
      closeDisabled={isApplying}
      footer={
        <div className="flex flex-col gap-compact w-full">
          <div role="alert" aria-live="assertive">
            {applyError && (
              <Text variant="small" className="text-stratosort-danger font-medium text-center">
                {applyError}
              </Text>
            )}
          </div>
          <div className="flex gap-compact justify-end">
            <Button variant="secondary" size="sm" onClick={onClose} disabled={isApplying}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleApply}
              disabled={isApplying || tags.length === 0}
              isLoading={isApplying}
              leftIcon={<Tag className="w-4 h-4" />}
            >
              Apply {tags.length} Tag{tags.length !== 1 ? 's' : ''}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <div>
          <Text as="label" variant="small" className="block font-medium text-system-gray-700 mb-1">
            Add tags
          </Text>
          <div className="flex gap-compact">
            <Input
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a tag and press Enter..."
              className="flex-1"
              disabled={isApplying}
            />
            <Button
              type="button"
              variant="secondary"
              onClick={handleAddTag}
              disabled={!tagInput.trim() || isApplying}
              leftIcon={<Plus className="w-4 h-4" />}
              aria-label="Add tag"
            />
          </div>
        </div>

        {tags.length > 0 && (
          <div className="flex flex-wrap gap-compact p-3 bg-system-gray-50 rounded-lg border border-system-gray-100">
            {tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-system-gray-100 border border-system-gray-200 text-sm text-system-gray-700 shadow-sm"
              >
                <Tag className="w-3 h-3 text-system-gray-400" />
                <Text as="span" variant="small" className="text-system-gray-700">
                  {tag}
                </Text>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => handleRemoveTag(tag)}
                  className="ml-1 h-5 w-5 p-0.5 rounded-full text-system-gray-400 hover:text-system-gray-600"
                  aria-label={`Remove tag ${tag}`}
                  leftIcon={<X className="w-3 h-3" />}
                >
                  <span className="sr-only">Remove</span>
                </Button>
              </span>
            ))}
          </div>
        )}

        <Text variant="small" className="text-system-gray-500">
          Note: This will update metadata for all files in the cluster.
        </Text>
      </div>
    </Modal>
  );
}

TagClusterModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  clusterName: PropTypes.string,
  initialTags: PropTypes.arrayOf(PropTypes.string),
  onApplyTags: PropTypes.func.isRequired
};

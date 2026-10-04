import React, { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import PropTypes from 'prop-types';
import { FolderInput, FileText } from 'lucide-react';
import { List } from 'react-window';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { Text } from '../ui/Typography';
import FileIcon from '../ui/FileIcon';
import { useFileActions } from '../../hooks/useFileActions';
import { safeBasename } from '../../utils/pathUtils';
import { createLogger } from '../../../shared/logger';

const logger = createLogger('TriageModal');

const ITEM_HEIGHT = 64;

const VirtualizedFileRow = React.memo(function VirtualizedFileRow({ index, style, data }) {
  const { files, selectedFiles, handleToggleFile, openFile, revealFile } = data;
  const file = files[index];
  if (!file) return null;

  const path = file.path || file.id;
  const isSelected = selectedFiles.has(path);

  return (
    <div style={style} className="pr-2 pb-1">
      <div
        className={`
          group flex items-center gap-cozy p-2 rounded-lg border transition-colors h-full
          ${
            isSelected
              ? 'bg-stratosort-blue/5 border-stratosort-blue/20'
              : 'bg-system-gray-100 border-transparent hover:bg-system-gray-50'
          }
        `}
      >
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- propagation guard only; no user-facing interaction */}
        <div onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={isSelected}
            onChange={() => handleToggleFile(path)}
            aria-label={`Select ${file.name || safeBasename(path)}`}
            className="rounded border-system-gray-300 text-stratosort-blue focus:ring-stratosort-blue/20"
          />
        </div>
        <button
          type="button"
          onClick={() => handleToggleFile(path)}
          aria-pressed={isSelected}
          className="flex min-w-0 flex-1 items-center gap-cozy text-left"
        >
          <FileIcon filename={file.name || safeBasename(path)} className="w-8 h-8 shrink-0" />
          <div className="flex-1 min-w-0">
            <Text as="div" variant="small" className="font-medium text-system-gray-900 truncate">
              {file.name || safeBasename(path)}
            </Text>
            <Text as="div" variant="tiny" className="text-system-gray-500 truncate">
              {path}
            </Text>
          </div>
        </button>
        <div className="flex gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
          <Button
            size="xs"
            variant="ghost"
            onClick={(e) => {
              e.stopPropagation();
              openFile(path);
            }}
          >
            Open
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={(e) => {
              e.stopPropagation();
              revealFile(path);
            }}
          >
            Reveal
          </Button>
        </div>
      </div>
    </div>
  );
});

VirtualizedFileRow.propTypes = {
  index: PropTypes.number.isRequired,
  style: PropTypes.object.isRequired,
  data: PropTypes.shape({
    files: PropTypes.array.isRequired,
    selectedFiles: PropTypes.instanceOf(Set).isRequired,
    handleToggleFile: PropTypes.func.isRequired,
    openFile: PropTypes.func.isRequired,
    revealFile: PropTypes.func.isRequired
  }).isRequired
};

/**
 * TriageModal
 *
 * A modal for reviewing and organizing a list of files (e.g. scattered files).
 * Allows batch moving to a selected folder.
 */
export default function TriageModal({
  isOpen,
  onClose,
  files = [], // Array of { path, name, ... }
  title = 'Review files',
  description = 'Review and organize these files.',
  onMoveFiles // (files, destination) => Promise<void>
}) {
  const [selectedFiles, setSelectedFiles] = useState(new Set());
  const [destinationPath, setDestinationPath] = useState('');
  const [isMoving, setIsMoving] = useState(false);
  const [moveError, setMoveError] = useState('');
  const { openFile, revealFile } = useFileActions(setMoveError);
  const prevIsOpenRef = useRef(false);
  const containerRef = useRef(null);
  const [listHeight, setListHeight] = useState(400);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setListHeight(entry.contentRect.height);
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [isOpen]);

  useEffect(() => {
    const wasOpen = prevIsOpenRef.current;
    prevIsOpenRef.current = isOpen;

    if (isOpen && !wasOpen) {
      setDestinationPath('');
      setMoveError('');
      setIsMoving(false);
      if (files.length > 0) {
        setSelectedFiles(new Set(files.map((f) => f.path || f.id)));
      }
    }
  }, [isOpen, files]);

  const handleToggleFile = useCallback((path) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const handleToggleAll = useCallback(() => {
    setSelectedFiles((prev) => {
      if (prev.size === files.length) {
        return new Set();
      }
      return new Set(files.map((f) => f.path || f.id));
    });
  }, [files]);

  const handleBrowse = useCallback(async () => {
    try {
      if (!window.electronAPI?.files?.selectDirectory) return;
      const res = await window.electronAPI.files.selectDirectory({ purpose: 'destination' });
      if (res?.success && res.path) {
        setDestinationPath(res.path);
      }
    } catch {
      // Ignore
    }
  }, []);

  const handleMove = useCallback(async () => {
    if (!destinationPath || selectedFiles.size === 0) return;
    setIsMoving(true);
    setMoveError('');
    try {
      const filesToMove = files.filter((f) => selectedFiles.has(f.path || f.id));
      await onMoveFiles(filesToMove, destinationPath);
      onClose();
    } catch (error) {
      logger.error('Failed to move files', {
        error: error?.message,
        stack: error?.stack
      });
      setMoveError(error?.message || 'Failed to move files. Please try again.');
    } finally {
      setIsMoving(false);
    }
  }, [destinationPath, selectedFiles, files, onMoveFiles, onClose]);

  const selectedCount = selectedFiles.size;

  const rowProps = useMemo(
    () => ({
      data: {
        files,
        selectedFiles,
        handleToggleFile,
        openFile,
        revealFile
      }
    }),
    [files, selectedFiles, handleToggleFile, openFile, revealFile]
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      description={description}
      size="lg"
      closeOnOverlayClick={!isMoving}
      closeOnEsc={!isMoving}
      closeDisabled={isMoving}
      footer={
        <div className="flex flex-col gap-compact w-full">
          {moveError && (
            <Text variant="small" className="text-stratosort-danger font-medium text-center">
              {moveError}
            </Text>
          )}
          <div className="flex gap-compact justify-end">
            <Button variant="secondary" size="sm" onClick={onClose} disabled={isMoving}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleMove}
              disabled={isMoving || !destinationPath || selectedCount === 0}
              isLoading={isMoving}
              leftIcon={<FolderInput className="w-4 h-4" />}
            >
              Move {selectedCount} {selectedCount === 1 ? 'File' : 'Files'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col h-[60vh]">
        {/* Toolbar */}
        <div className="flex items-center justify-between mb-4 pb-4 border-b border-system-gray-100">
          <div className="flex items-center gap-compact">
            <input
              type="checkbox"
              checked={files.length > 0 && selectedFiles.size === files.length}
              onChange={handleToggleAll}
              aria-label="Select all files"
              className="rounded border-system-gray-300 text-stratosort-blue focus:ring-stratosort-blue/20"
            />
            <Text variant="small" className="font-medium text-system-gray-700">
              Select all ({selectedCount}/{files.length})
            </Text>
          </div>
          <div className="flex items-center gap-compact">
            <Text variant="small" className="text-system-gray-500">
              Move to:
            </Text>
            <div className="flex items-center gap-compact">
              <Text
                as="div"
                variant="small"
                className="px-3 py-1.5 bg-system-gray-50 border border-system-gray-200 rounded-md text-system-gray-700 min-w-[200px] max-w-[300px] truncate"
              >
                {destinationPath ? safeBasename(destinationPath) : 'Select folder...'}
              </Text>
              <Button size="sm" variant="secondary" onClick={handleBrowse}>
                Browse
              </Button>
            </div>
          </div>
        </div>

        {/* File List */}
        <div className="flex-1 min-h-0" ref={containerRef}>
          {files.length > 0 ? (
            <List
              rowCount={files.length}
              rowHeight={ITEM_HEIGHT}
              rowComponent={VirtualizedFileRow}
              rowProps={rowProps}
              overscanCount={5}
              style={{ height: listHeight, width: '100%' }}
              className="scrollbar-thin scrollbar-thumb-system-gray-300 scrollbar-track-transparent"
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-system-gray-400">
              <FileText className="w-12 h-12 mb-2 opacity-50" />
              <Text>No files to review</Text>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

TriageModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  files: PropTypes.array,
  title: PropTypes.string,
  description: PropTypes.string,
  onMoveFiles: PropTypes.func.isRequired
};

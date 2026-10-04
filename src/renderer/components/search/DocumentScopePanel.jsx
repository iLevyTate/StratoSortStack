import React, { memo, useState, useCallback } from 'react';
import PropTypes from 'prop-types';
import { X, FileText, Folder, Plus, FolderInput, ChevronRight } from 'lucide-react';
import { Button, IconButton } from '../ui';
import { Text } from '../ui/Typography';
import { formatDisplayPath } from '../../utils/pathDisplay';
import { useSelector } from 'react-redux';
import { selectRedactPaths } from '../../store/selectors';

const ScopeItem = memo(function ScopeItem({ item, onRemove }) {
  const redactPaths = useSelector(selectRedactPaths);
  const isFolder = item.type === 'folder';

  return (
    <div className="group mb-1 flex items-center justify-between rounded-md border border-border-soft bg-system-gray-100/90 p-2">
      <div className="flex items-center gap-compact min-w-0 flex-1">
        {isFolder ? (
          <Folder className="w-4 h-4 text-stratosort-blue shrink-0" />
        ) : (
          <FileText className="w-4 h-4 text-system-gray-400 shrink-0" />
        )}
        <div className="flex flex-col min-w-0">
          <span className="text-sm font-medium truncate" title={item.path}>
            {item.name || 'Unknown'}
          </span>
          <span className="text-xs text-system-gray-400 truncate">
            {formatDisplayPath(item.path, { redact: redactPaths, segments: 1 })}
          </span>
        </div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 p-1 h-auto text-system-gray-400 hover:text-stratosort-danger hover:bg-stratosort-danger/10 transition"
        onClick={() => onRemove(item.id)}
        title="Remove from scope"
      >
        <X className="w-3 h-3" />
      </Button>
    </div>
  );
});

ScopeItem.propTypes = {
  item: PropTypes.shape({
    id: PropTypes.string.isRequired,
    path: PropTypes.string.isRequired,
    name: PropTypes.string,
    type: PropTypes.string
  }).isRequired,
  onRemove: PropTypes.func.isRequired
};

export default function DocumentScopePanel({
  scope,
  onAddToScope,
  onRemoveFromScope,
  onClearScope,
  onClose,
  className = ''
}) {
  const [isOver, setIsOver] = useState(false);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsOver(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsOver(false);
  }, []);

  const handleDrop = useCallback(
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      setIsOver(false);

      const droppedFiles = e.dataTransfer?.files;
      if (droppedFiles && droppedFiles.length > 0) {
        const files = Array.from(droppedFiles).map((f) => ({
          path: f.path,
          name: f.name,
          type: 'file'
        }));
        onAddToScope(files);
      }
    },
    [onAddToScope]
  );

  const handleAddClick = useCallback(async () => {
    try {
      const result = await window.electronAPI?.files?.select?.();

      if (result?.success && Array.isArray(result.files) && result.files.length > 0) {
        const files = result.files.map((f) => ({
          path: f.path,
          name: f.name || f.path.split(/[/\\]/).pop(),
          type: 'file'
        }));
        onAddToScope(files);
      }
    } catch {
      // IPC rejection is non-fatal (e.g. user cancelled dialog)
    }
  }, [onAddToScope]);

  return (
    <div
      className={`flex h-full flex-col border-l border-system-gray-200/80 bg-system-gray-50/60 ${className}`}
    >
      <div className="flex items-center justify-between min-w-0 border-b border-system-gray-200/80 bg-system-gray-50/50 p-3">
        <div className="flex items-center gap-compact min-w-0">
          {onClose && (
            <IconButton
              onClick={onClose}
              size="sm"
              variant="secondary"
              className="shrink-0 w-8 h-8"
              title="Collapse document scope sidebar"
              aria-label="Collapse document scope sidebar"
              icon={<ChevronRight className="w-4 h-4 text-system-gray-500" />}
            />
          )}
          <Text
            variant="small"
            className="font-semibold text-system-gray-800 truncate"
            title="Document scope"
          >
            Document scope
          </Text>
        </div>
        {scope.length > 0 && (
          <Button
            variant="ghost"
            size="xs"
            onClick={onClearScope}
            className="text-xs text-system-gray-500 shrink-0"
          >
            Clear
          </Button>
        )}
      </div>

      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- drag-drop surface; scope can also be filled via non-drag UI */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`flex-1 overflow-y-auto p-2 transition-colors ${
          isOver ? 'border-2 border-dashed border-stratosort-blue/30 bg-stratosort-blue/8' : ''
        }`}
      >
        {scope.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center p-4 text-system-gray-400">
            <FolderInput className="w-8 h-8 mb-2 opacity-20" />
            <Text variant="tiny" className="mb-2">
              Drag files or folders here to limit chat to specific documents.
            </Text>
            <Button variant="secondary" size="sm" onClick={handleAddClick}>
              <Plus className="w-3 h-3 mr-1" /> Add files
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex justify-end mb-2">
              <Button variant="ghost" size="xs" onClick={handleAddClick}>
                <Plus className="w-3 h-3 mr-1" /> Add more
              </Button>
            </div>
            {scope.map((item) => (
              <ScopeItem key={item.id} item={item} onRemove={onRemoveFromScope} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

DocumentScopePanel.propTypes = {
  scope: PropTypes.arrayOf(PropTypes.object).isRequired,
  onAddToScope: PropTypes.func.isRequired,
  onRemoveFromScope: PropTypes.func.isRequired,
  onClearScope: PropTypes.func.isRequired,
  onClose: PropTypes.func,
  className: PropTypes.string
};

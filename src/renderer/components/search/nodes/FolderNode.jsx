import React, { memo, useCallback } from 'react';
import PropTypes from 'prop-types';
import { Handle, Position, NodeToolbar } from '@xyflow/react';
import { Folder, FolderInput, FolderOpen } from 'lucide-react';
import { IconButton } from '../../ui';

const FolderNode = memo(({ data, selected }) => {
  const label = data?.label || 'Suggested folder';
  const memberCount = data?.memberCount || 0;
  const folderId = data?.id;

  const dispatchFolderAction = useCallback(
    (action) => {
      window.dispatchEvent(
        new CustomEvent('graph:folderAction', {
          detail: { action, folderId, folderPath: label }
        })
      );
    },
    [folderId, label]
  );

  const handleMoveFilesHere = useCallback(
    (e) => {
      e.stopPropagation();
      dispatchFolderAction('moveFilesHere');
    },
    [dispatchFolderAction]
  );

  const handleReveal = useCallback(
    (e) => {
      e.stopPropagation();
      dispatchFolderAction('reveal');
    },
    [dispatchFolderAction]
  );

  // Keyboard activation for non-pointer users. Enter triggers the primary
  // action (move files here); Shift+Enter falls back to revealing the folder
  // so power users can access both commands without the pointer toolbar.
  // Space is intentionally NOT trapped because React Flow uses it for panning.
  const handleKeyDown = useCallback(
    (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) {
        dispatchFolderAction('reveal');
      } else {
        dispatchFolderAction('moveFilesHere');
      }
    },
    [dispatchFolderAction]
  );

  const memberLabel = `${memberCount} file${memberCount === 1 ? '' : 's'}`;
  const ariaLabel = `Suggested folder ${label}, ${memberLabel}. Press Enter to move files here, Shift+Enter to reveal the folder.`;

  return (
    <>
      <NodeToolbar isVisible={selected} position={Position.Top}>
        <div className="flex items-center gap-1 bg-system-gray-100 border border-system-gray-200 rounded-lg shadow-md px-1.5 py-1">
          <IconButton
            icon={<FolderInput className="w-3 h-3" />}
            size="xs"
            variant="ghost"
            title="Move connected files here"
            aria-label="Move connected files here"
            onClick={handleMoveFilesHere}
          />
          <IconButton
            icon={<FolderOpen className="w-3 h-3" />}
            size="xs"
            variant="ghost"
            title="Reveal folder in Explorer"
            aria-label="Reveal folder in Explorer"
            onClick={handleReveal}
          />
        </div>
      </NodeToolbar>

      <div
        role="button"
        tabIndex={0}
        aria-label={ariaLabel}
        aria-pressed={Boolean(selected)}
        onKeyDown={handleKeyDown}
        className={`
          relative px-3 py-2 rounded-lg border-2 shadow-sm w-[220px] min-h-[84px] overflow-hidden
          transition-colors duration-200 cursor-pointer
          focus:outline-none focus-visible:ring-2 focus-visible:ring-stratosort-accent focus-visible:ring-offset-2
          ${
            selected
              ? 'border-stratosort-accent bg-stratosort-accent/10 shadow-md ring-2 ring-stratosort-accent/30'
              : 'border-stratosort-accent/50 bg-system-gray-100 hover:border-stratosort-accent/70 hover:shadow-md'
          }
        `}
        title={`Suggested folder: ${label} (${memberLabel})`}
      >
        <Handle
          type="target"
          position={Position.Left}
          className="!bg-stratosort-accent !w-2 !h-2"
        />
        <div className="flex items-start gap-compact">
          <Folder className="w-4 h-4 text-stratosort-accent shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium text-system-gray-900 clamp-2 break-all leading-snug">
              {label}
            </div>
            {memberCount > 0 && (
              <div className="text-xs text-system-gray-500 mt-0.5">
                {memberCount} file{memberCount === 1 ? '' : 's'} suggested
              </div>
            )}
            <div className="text-xs text-stratosort-accent/70 mt-0.5">Suggested folder</div>
          </div>
        </div>
        <Handle
          type="source"
          position={Position.Right}
          className="!bg-stratosort-accent !w-2 !h-2"
        />
      </div>
    </>
  );
});

FolderNode.displayName = 'FolderNode';

FolderNode.propTypes = {
  data: PropTypes.shape({
    id: PropTypes.string,
    label: PropTypes.string,
    memberCount: PropTypes.number
  }),
  selected: PropTypes.bool
};

export default FolderNode;

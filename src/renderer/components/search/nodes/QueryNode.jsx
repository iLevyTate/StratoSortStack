import React, { memo, useState, useCallback, useRef } from 'react';
import PropTypes from 'prop-types';
import { Handle, Position } from '@xyflow/react';
import { MessageSquare, Copy, Search } from 'lucide-react';
import { Button } from '../../ui';
import { useMenuAutoClose } from '../../../hooks';
import { useNotification } from '../../../contexts/NotificationContext';

const QueryNode = memo(({ data, selected }) => {
  const [contextMenu, setContextMenu] = useState({ open: false, x: 0, y: 0 });
  const menuRef = useRef(null);
  const queryText = data?.label || '';
  const { addNotification } = useNotification();

  // Close context menu when clicking outside or pressing Escape
  useMenuAutoClose(menuRef, contextMenu.open, () => setContextMenu({ open: false, x: 0, y: 0 }));

  const handleCopyQuery = useCallback(
    async (e) => {
      e?.stopPropagation?.();
      if (!queryText) return;
      try {
        await navigator.clipboard.writeText(queryText);
        addNotification?.('Query copied', 'success', 1500, 'copy-feedback');
      } catch {
        addNotification?.('Failed to copy query to clipboard', 'error', 3000, 'copy-feedback');
      }
    },
    [queryText, addNotification]
  );

  const handleSearchAgain = useCallback(
    (e) => {
      e?.stopPropagation?.();
      // Dispatch custom event that UnifiedSearchModal can listen for
      if (queryText) {
        const event = new CustomEvent('graph:searchAgain', {
          detail: { query: queryText }
        });
        window.dispatchEvent(event);
      }
    },
    [queryText]
  );

  const handleContextMenu = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setContextMenu({
      open: true,
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu({ open: false, x: 0, y: 0 });
  }, []);

  const handleMenuAction = useCallback(
    (action) => {
      closeContextMenu();
      action?.();
    },
    [closeContextMenu]
  );

  return (
    /* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- graph-canvas pointer affordance; keyboard path tracked as U-T14 */
    <div
      className={`
        relative px-3 py-2 rounded-lg border-2 shadow-sm w-[220px] min-h-[84px] overflow-visible
        transition-colors duration-200 cursor-pointer
        ${
          selected
            ? 'border-stratosort-indigo bg-stratosort-indigo/10 shadow-md ring-2 ring-stratosort-indigo/30'
            : 'border-stratosort-indigo/30 bg-stratosort-indigo/5 hover:border-stratosort-indigo/50'
        }
      `}
      onContextMenu={handleContextMenu}
      title="Right-click for options"
    >
      {/* Context menu */}
      {contextMenu.open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Query actions"
          className="absolute dropdown-menu z-50 w-40 animate-pop-in nodrag nopan"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <Button
            role="menuitem"
            variant="ghost"
            size="sm"
            leftIcon={<Copy className="w-4 h-4 text-system-gray-500" />}
            onClick={(e) => {
              e.stopPropagation();
              handleMenuAction(handleCopyQuery);
            }}
            className="w-full justify-start px-3 py-2 text-system-gray-700 hover:bg-stratosort-indigo/10"
          >
            Copy query
          </Button>
          <Button
            role="menuitem"
            variant="ghost"
            size="sm"
            leftIcon={<Search className="w-4 h-4 text-stratosort-indigo" />}
            onClick={(e) => {
              e.stopPropagation();
              handleMenuAction(handleSearchAgain);
            }}
            className="w-full justify-start px-3 py-2 text-system-gray-700 hover:bg-stratosort-indigo/10"
          >
            Search again
          </Button>
        </div>
      )}

      <div className="flex items-start gap-compact">
        <MessageSquare className="w-4 h-4 text-stratosort-indigo shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <div className="text-xs uppercase tracking-wider text-stratosort-indigo font-medium">
              Query
            </div>
            {data?.searchMode && (
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium leading-none ${
                  data.fallback
                    ? 'bg-stratosort-warning/15 text-stratosort-warning'
                    : 'bg-stratosort-indigo/10 text-stratosort-indigo/70'
                }`}
              >
                {data.searchMode}
              </span>
            )}
          </div>
          <div
            className="file-node-label text-xs font-medium text-[var(--color-system-gray-900)] clamp-2 break-all leading-snug"
            title={queryText}
          >
            {queryText}
          </div>
          {typeof data?.resultCount === 'number' && (
            <div className="text-[10px] text-system-gray-500 mt-0.5">
              {data.resultCount} {data.resultCount === 1 ? 'result' : 'results'}
              {data.corrections?.length > 0 && (
                <span className="ml-1 text-stratosort-accent">(corrected)</span>
              )}
            </div>
          )}
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="!bg-stratosort-indigo !w-2 !h-2" />
    </div>
  );
});

QueryNode.displayName = 'QueryNode';

QueryNode.propTypes = {
  data: PropTypes.shape({
    label: PropTypes.string,
    resultCount: PropTypes.number,
    searchMode: PropTypes.string,
    fallback: PropTypes.bool,
    corrections: PropTypes.array
  }),
  selected: PropTypes.bool
};

export default QueryNode;

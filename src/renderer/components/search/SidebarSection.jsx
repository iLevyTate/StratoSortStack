import React, { useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { ChevronDown } from 'lucide-react';
import { Button } from '../ui';
import { Text } from '../ui/Typography';

// Matches the inline `GRAPH_SIDEBAR_SECTION_TITLE` style used elsewhere in
// UnifiedSearchModal. Kept local rather than promoted to a shared tokens
// module because the styling is intentionally specific to the sidebar layout.
const SECTION_TITLE_CLASSES =
  'text-xs font-semibold text-system-gray-400 uppercase tracking-wider flex items-center gap-compact';

/**
 * Lightweight collapsible section header for the graph sidebar.
 * Provides consistent toggle UI with chevron, icon, title, and optional badge.
 */
function SidebarSection({ icon: Icon, title, isOpen, onToggle, badge, children }) {
  // Mount-once: children stay in DOM after first open for smooth CSS transitions,
  // but don't mount until actually needed (avoids ~150-300 unnecessary DOM nodes)
  const [hasBeenOpened, setHasBeenOpened] = useState(isOpen);
  useEffect(() => {
    if (isOpen && !hasBeenOpened) setHasBeenOpened(true);
  }, [isOpen, hasBeenOpened]);

  return (
    <section className="space-y-0">
      <Button
        type="button"
        onClick={onToggle}
        variant="ghost"
        size="xs"
        className="w-full h-auto !justify-between gap-compact rounded-md px-1 py-2 hover:bg-system-gray-100/80 group"
        aria-expanded={isOpen}
        aria-label={`${title} section`}
      >
        <span className={SECTION_TITLE_CLASSES}>
          {Icon && <Icon className="w-3.5 h-3.5" aria-hidden="true" />}
          <span>{title}</span>
          {badge != null && (
            <Text
              as="span"
              variant="tiny"
              className="ml-1 rounded-full border border-border-soft bg-system-gray-100 px-1.5 py-0.5 font-medium not-italic text-system-gray-500"
            >
              {badge}
            </Text>
          )}
        </span>
        <ChevronDown
          className={`w-3.5 h-3.5 text-system-gray-400 transition-transform [transition-duration:var(--motion-duration-fast)] [transition-timing-function:var(--motion-ease-standard)] ${isOpen ? '' : '-rotate-90'}`}
          aria-hidden="true"
        />
      </Button>
      <div
        className={
          isOpen
            ? 'pt-2'
            : 'max-h-0 overflow-hidden opacity-0 pt-0 transition-[max-height,opacity] [transition-duration:var(--motion-duration-standard)] [transition-timing-function:var(--motion-ease-standard)]'
        }
      >
        {hasBeenOpened && <div className="space-y-3">{children}</div>}
      </div>
    </section>
  );
}

SidebarSection.propTypes = {
  icon: PropTypes.elementType,
  title: PropTypes.string.isRequired,
  isOpen: PropTypes.bool.isRequired,
  onToggle: PropTypes.func.isRequired,
  badge: PropTypes.node,
  children: PropTypes.node
};
SidebarSection.displayName = 'SidebarSection';

export default SidebarSection;

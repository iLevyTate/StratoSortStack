import React, { memo, useState, useEffect, useCallback, useRef } from 'react';
import PropTypes from 'prop-types';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { Plus, MessageSquare, Trash2, Search, ChevronLeft } from 'lucide-react';
import { Button, IconButton } from '../ui';
import { ConfirmModal } from '../ui/Modal';
import { Text } from '../ui/Typography';
import Spinner from '../ui/Spinner';
import {
  listConversations,
  deleteConversation,
  searchConversations
} from '../../services/ipc/chatIpc';
import { useNotification } from '../../contexts/NotificationContext';
import { createLogger } from '../../../shared/logger';

const logger = createLogger('ConversationSidebar');

// Conversations fetched per page; matches the historical single-shot limit so
// the first render is unchanged and older conversations load on demand.
const PAGE_SIZE = 50;

const ConversationItem = memo(function ConversationItem({
  conversation,
  isSelected,
  onSelect,
  onDelete,
  reduceMotion
}) {
  const date = new Date(conversation.updatedAt || conversation.createdAt);
  const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  return (
    <motion.div
      layout={!reduceMotion}
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
      animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0, marginBottom: 0 }}
      transition={{ duration: reduceMotion ? 0.08 : 0.18, ease: [0.22, 1, 0.36, 1] }}
      className={`group flex items-center justify-between p-2 rounded-md cursor-pointer mb-1 transition-colors ${
        isSelected
          ? 'border border-stratosort-blue/20 bg-stratosort-blue/10 text-stratosort-blue'
          : 'border border-transparent text-system-gray-700 hover:bg-system-gray-100/80'
      }`}
      onClick={() => onSelect(conversation.id)}
    >
      <div className="flex items-center gap-compact min-w-0 flex-1">
        <MessageSquare
          className={`w-4 h-4 shrink-0 ${isSelected ? 'text-stratosort-blue' : 'text-system-gray-400'}`}
        />
        <div className="flex flex-col min-w-0">
          <Text as="span" variant="small" className="font-medium truncate">
            {conversation.title || 'New conversation'}
          </Text>
          <Text as="span" variant="tiny" className="text-system-gray-400">
            {dateStr}
          </Text>
        </div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className={`p-1 h-auto transition opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-system-gray-400 hover:text-stratosort-danger hover:bg-stratosort-danger/10 ${
          isSelected ? 'opacity-100' : ''
        }`}
        onClick={(e) => {
          e.stopPropagation();
          onDelete(conversation);
        }}
        title="Delete conversation"
        aria-label="Delete conversation"
      >
        <Trash2 className="w-3 h-3" />
      </Button>
    </motion.div>
  );
});

ConversationItem.propTypes = {
  conversation: PropTypes.object.isRequired,
  isSelected: PropTypes.bool,
  reduceMotion: PropTypes.bool,
  onSelect: PropTypes.func.isRequired,
  onDelete: PropTypes.func.isRequired
};

export default function ConversationSidebar({
  currentConversationId,
  onSelectConversation,
  onNewConversation,
  onClose,
  className = ''
}) {
  const [conversations, setConversations] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [loading, setLoading] = useState(false);
  // searchCapped is true when the user's history exceeds the decrypt-scan cap
  // and matches in encrypted columns of older conversations may have been
  // missed. The notice tells the user "showing recent N" so they understand
  // the result list is bounded, not authoritative across their whole history.
  const [searchCapNotice, setSearchCapNotice] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Standardized destructive flow: target object held in state and passed
  // to a ConfirmModal. Replaces the previous click-twice-pending-delete
  // pattern, which was inconsistent with the rest of the app's destructive
  // surfaces (backups, models, embeddings rebuild) and lacked keyboard
  // accessibility.
  const [pendingDeleteConversation, setPendingDeleteConversation] = useState(null);
  const { showError } = useNotification();
  const reduceMotion = useReducedMotion();
  // Monotonic request id: a slow earlier list/search response must not
  // overwrite the result of a later one (classic type-fast-then-clear race).
  const listRequestIdRef = useRef(0);

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedQuery(searchQuery), 300);
    return () => clearTimeout(handle);
  }, [searchQuery]);

  const loadConversations = useCallback(async () => {
    const requestId = ++listRequestIdRef.current;
    setLoading(true);
    try {
      let results;
      let more = false;
      let capNotice = null;
      if (debouncedQuery.trim()) {
        const envelope = await searchConversations(debouncedQuery);
        results = envelope.items;
        capNotice = envelope.capped
          ? `Showing matches within the most recent ${envelope.capLimit} conversations. Older history may contain additional matches in encrypted content.`
          : null;
      } else {
        results = await listConversations(PAGE_SIZE, 0);
        more = results.length === PAGE_SIZE;
      }
      if (requestId !== listRequestIdRef.current) return; // stale response
      setHasMore(more);
      setSearchCapNotice(capNotice);
      setConversations(results);
    } catch (err) {
      if (requestId !== listRequestIdRef.current) return;
      // Silent failure used to leave the sidebar mysteriously empty with no
      // recourse for the user. Surface the error so they at least know the
      // list isn't authoritative and can retry by editing the search.
      const message = err?.message || String(err);
      logger.warn('[ConversationSidebar] Failed to load conversations', { error: message });
      showError(`Couldn't load conversations: ${message}`, 5000);
    } finally {
      if (requestId === listRequestIdRef.current) setLoading(false);
    }
  }, [debouncedQuery, showError]);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  // Track the latest list without making it an effect dependency (which
  // would re-trigger loads on every list change).
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;

  // Reload when the active conversation changes ONLY if it isn't already
  // listed (e.g. the first send just created it). Reloading on every
  // selection would reset pagination to page 1 and scroll a "Load more"
  // selection out of view.
  useEffect(() => {
    if (!currentConversationId) return;
    if (conversationsRef.current.some((c) => c.id === currentConversationId)) return;
    loadConversations();
  }, [currentConversationId, loadConversations]);

  // Fetch the next page and append. Offset is the current list length so a
  // reload (which resets to page 1) keeps the two paths consistent. Dedupe by
  // id in case a conversation moved pages between requests (updated_at sort).
  const loadMore = useCallback(async () => {
    // A full reload in flight will replace the list this page would append
    // to — appending against the pre-reload length leaves holes.
    if (loading || loadingMore) return;
    const requestId = listRequestIdRef.current;
    setLoadingMore(true);
    try {
      const next = await listConversations(PAGE_SIZE, conversations.length);
      // A reload/search started while this page was in flight — appending
      // would mix pages from two different list states.
      if (requestId !== listRequestIdRef.current) return;
      setHasMore(next.length === PAGE_SIZE);
      setConversations((prev) => {
        const seen = new Set(prev.map((c) => c.id));
        return [...prev, ...next.filter((c) => !seen.has(c.id))];
      });
    } catch (err) {
      const message = err?.message || String(err);
      logger.warn('[ConversationSidebar] Failed to load more conversations', { error: message });
      showError(`Couldn't load more conversations: ${message}`, 5000);
    } finally {
      setLoadingMore(false);
    }
  }, [conversations.length, loading, loadingMore, showError]);

  const requestDelete = useCallback((conversation) => {
    setPendingDeleteConversation(conversation);
  }, []);

  const confirmDelete = useCallback(async () => {
    const target = pendingDeleteConversation;
    if (!target) return;
    try {
      await deleteConversation(target.id);
      if (target.id === currentConversationId) {
        onNewConversation();
      }
      loadConversations();
    } catch (err) {
      const message = err?.message || String(err);
      logger.warn('[ConversationSidebar] Failed to delete conversation', {
        id: target.id,
        error: message
      });
      showError(`Couldn't delete conversation: ${message}`, 5000);
      // Re-throw so ConfirmModal stays open and surfaces the error banner
      throw err;
    }
  }, [
    pendingDeleteConversation,
    currentConversationId,
    onNewConversation,
    loadConversations,
    showError
  ]);

  return (
    <div
      className={`flex h-full flex-col border-r border-system-gray-200/80 bg-system-gray-50/60 ${className}`}
    >
      <div className="space-y-3 border-b border-system-gray-200/80 bg-system-gray-50/50 p-3">
        <div className="flex items-center gap-compact">
          <Button
            variant="primary"
            className="flex-1 justify-center gap-compact"
            onClick={onNewConversation}
            aria-label="New chat"
          >
            <Plus className="w-4 h-4" />
            <span>New chat</span>
          </Button>
          {onClose && (
            <IconButton
              onClick={onClose}
              size="sm"
              variant="secondary"
              className="shrink-0 w-8 h-8"
              title="Collapse conversation sidebar"
              aria-label="Collapse conversation sidebar"
              icon={<ChevronLeft className="w-4 h-4 text-system-gray-500" />}
            />
          )}
        </div>

        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-system-gray-400" />
          <input
            type="text"
            placeholder="Search chats..."
            aria-label="Search chats"
            className="w-full rounded-md border border-border-soft bg-system-gray-100/90 py-1.5 pl-8 pr-3 text-sm focus:border-stratosort-blue focus:outline-none focus:ring-1 focus:ring-stratosort-blue"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {searchCapNotice ? (
          <div
            className="mb-2 mx-2 p-2 rounded bg-system-gray-100 text-system-gray-600"
            role="status"
            aria-live="polite"
          >
            <Text variant="tiny">{searchCapNotice}</Text>
          </div>
        ) : null}
        {loading && conversations.length === 0 ? (
          <div className="flex justify-center py-4 animate-loading-fade">
            <Spinner size="xs" label="Loading chats" />
          </div>
        ) : conversations.length === 0 ? (
          <div className="text-center py-8 text-system-gray-400">
            <MessageSquare className="w-8 h-8 mx-auto mb-2 opacity-20" />
            <Text variant="tiny">No conversations yet</Text>
          </div>
        ) : (
          <>
            <div className="mb-2 px-2">
              <Text
                variant="tiny"
                className="font-semibold text-system-gray-500 uppercase tracking-wide"
              >
                Recent
              </Text>
            </div>
            <AnimatePresence initial={false}>
              {conversations.map((conv) => (
                <ConversationItem
                  key={conv.id}
                  conversation={conv}
                  isSelected={conv.id === currentConversationId}
                  reduceMotion={reduceMotion}
                  onSelect={onSelectConversation}
                  onDelete={requestDelete}
                />
              ))}
            </AnimatePresence>
            {hasMore && !debouncedQuery.trim() && (
              <div className="px-2 pt-1 pb-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-center text-system-gray-500"
                  onClick={loadMore}
                  disabled={loadingMore}
                  aria-label="Load more conversations"
                >
                  {loadingMore ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      <ConfirmModal
        isOpen={Boolean(pendingDeleteConversation)}
        onClose={() => setPendingDeleteConversation(null)}
        onConfirm={confirmDelete}
        title="Delete this conversation?"
        message="The conversation history and all its messages will be removed permanently. This action cannot be undone."
        confirmText="Delete"
        cancelText="Cancel"
        variant="danger"
        fileName={pendingDeleteConversation?.title || 'New conversation'}
      />
    </div>
  );
}

ConversationSidebar.propTypes = {
  currentConversationId: PropTypes.string,
  onSelectConversation: PropTypes.func.isRequired,
  onNewConversation: PropTypes.func.isRequired,
  onClose: PropTypes.func,
  className: PropTypes.string
};

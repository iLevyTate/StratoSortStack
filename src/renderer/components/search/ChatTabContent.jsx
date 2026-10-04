/**
 * Chat tab content for the Unified Search modal (§I Phase 6).
 * Presentation only — state/handlers arrive via the  prop
 * (useChatTab's surface) plus modal-owned extras.
 */
import React from 'react';
import PropTypes from 'prop-types';
import { AlertTriangle, ChevronLeft, ChevronRight, FolderInput, MessageSquare } from 'lucide-react';
import { Button, IconButton } from '../ui';
import { Text } from '../ui/Typography';
import ChatPanel from './ChatPanel';
import ConversationSidebar from './ConversationSidebar';
import DocumentScopePanel from './DocumentScopePanel';

export default function ChatTabContent({
  chat,
  stats,
  statsUnavailable,
  handleUseSourcesInGraph,
  hasLoadedStats,
  isLoadingStats,
  isSearching,
  simpleMode,
  graphViewEnabled,
  handleOpenSettings
}) {
  const {
    chatMessages,
    currentConversationId,
    strictScope,
    setStrictScope,
    documentScope,
    isConvSidebarOpen,
    setIsConvSidebarOpen,
    isDocScopeOpen,
    setIsDocScopeOpen,
    isChatting,
    chatError,
    chatWarning,
    useSearchContext,
    setUseSearchContext,
    searchContextCount,
    responseMode,
    chatPersona,
    chatPersonaOptions,
    chatStatus,
    handleChatSend,
    handleResponseModeChange,
    handleChatPersonaChange,
    handleAddToScope,
    handleRemoveFromScope,
    handleClearScope,
    handleNewConversation,
    handleSelectConversation,
    handleStopGenerating,
    handleChatReset,
    handleRegenerate,
    handleChatOpenSource
  } = chat;

  return (
    <div className="flex-1 min-h-0 h-full surface-panel flex flex-col overflow-hidden">
      <div className="flex flex-1 min-h-0">
        {isConvSidebarOpen ? (
          <div className="relative shrink-0 flex">
            <ConversationSidebar
              currentConversationId={currentConversationId}
              onSelectConversation={handleSelectConversation}
              onNewConversation={handleNewConversation}
              onClose={() => setIsConvSidebarOpen(false)}
              className="w-56 shrink-0"
            />
          </div>
        ) : (
          <div className="shrink-0 flex flex-col items-center py-2 px-1 bg-system-gray-50 border-r border-system-gray-200 gap-compact">
            <IconButton
              onClick={() => setIsConvSidebarOpen(true)}
              size="sm"
              variant="secondary"
              className="w-7 h-7 rounded-md"
              title="Show conversations"
              aria-label="Show conversation sidebar"
              icon={<ChevronRight className="w-3.5 h-3.5 text-system-gray-500" />}
            />
            <MessageSquare className="w-4 h-4 text-system-gray-400" />
          </div>
        )}

        <div className="flex-1 flex flex-col min-w-0 min-h-0 border-l border-system-gray-200">
          {statsUnavailable ? (
            <div className="mx-4 mt-4 rounded-lg border border-stratosort-danger/30 bg-stratosort-danger/10 px-3 py-2 flex items-center justify-between gap-cozy">
              <div className="flex items-center gap-compact">
                <AlertTriangle className="h-4 w-4 text-stratosort-danger" />
                <Text as="span" variant="tiny" className="text-system-gray-700">
                  The local AI engine is currently unavailable. Chat will not work until it is
                  restored.
                </Text>
              </div>
              <Button variant="secondary" size="sm" onClick={handleOpenSettings}>
                Open Settings
              </Button>
            </div>
          ) : hasLoadedStats && (!stats || stats.files === 0) ? (
            <div className="mx-4 mt-4 rounded-lg border border-stratosort-warning/30 bg-stratosort-warning/10 px-3 py-2 flex items-center justify-between gap-cozy">
              <Text as="span" variant="tiny" className="text-system-gray-700">
                {simpleMode
                  ? 'Search indexing is not ready yet. Build your file index in Settings to enable document citations and sources.'
                  : 'Embeddings are not ready yet. Build your embeddings in Settings to enable document citations and sources.'}
              </Text>
              <Button variant="secondary" size="sm" onClick={handleOpenSettings}>
                Open Settings
              </Button>
            </div>
          ) : null}
          <ChatPanel
            messages={chatMessages}
            onSend={handleChatSend}
            onRegenerate={handleRegenerate}
            onReset={handleChatReset}
            onStopGenerating={handleStopGenerating}
            isSending={isChatting}
            statusMessage={chatStatus}
            error={chatError}
            warning={chatWarning}
            useSearchContext={useSearchContext}
            onToggleSearchContext={(next) => setUseSearchContext(next)}
            searchContextCount={searchContextCount}
            strictScope={strictScope}
            onToggleStrictScope={setStrictScope}
            onOpenSource={handleChatOpenSource}
            onUseSourcesInGraph={handleUseSourcesInGraph}
            showGraphActions={graphViewEnabled}
            isSearching={isSearching}
            isLoadingStats={isLoadingStats}
            responseMode={responseMode}
            onResponseModeChange={handleResponseModeChange}
            chatPersona={chatPersona}
            onChatPersonaChange={handleChatPersonaChange}
            chatPersonaOptions={chatPersonaOptions}
            disabled={statsUnavailable}
          />
        </div>
        {isDocScopeOpen ? (
          <div className="relative shrink-0 flex">
            <DocumentScopePanel
              scope={documentScope}
              onAddToScope={handleAddToScope}
              onRemoveFromScope={handleRemoveFromScope}
              onClearScope={handleClearScope}
              onClose={() => setIsDocScopeOpen(false)}
              className="w-56 shrink-0"
            />
          </div>
        ) : (
          <div className="shrink-0 flex flex-col items-center py-2 px-1 bg-system-gray-50 border-l border-system-gray-200 gap-compact">
            <IconButton
              onClick={() => setIsDocScopeOpen(true)}
              size="sm"
              variant="secondary"
              className="w-7 h-7 rounded-md"
              title="Show document scope"
              aria-label="Show document scope sidebar"
              icon={<ChevronLeft className="w-3.5 h-3.5 text-system-gray-500" />}
            />
            <FolderInput className="w-4 h-4 text-system-gray-400" />
            {documentScope.length > 0 && (
              <Text
                as="span"
                variant="tiny"
                className="font-medium text-stratosort-blue bg-stratosort-blue/10 rounded-full w-5 h-5 flex items-center justify-center"
              >
                {documentScope.length}
              </Text>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

ChatTabContent.propTypes = {
  chat: PropTypes.object.isRequired,
  stats: PropTypes.object,
  statsUnavailable: PropTypes.bool,
  handleUseSourcesInGraph: PropTypes.func
};

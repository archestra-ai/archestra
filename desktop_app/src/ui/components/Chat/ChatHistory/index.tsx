import { UIMessage } from 'ai';
import { ArrowDown } from 'lucide-react';
import { useRef } from 'react';

import { Button } from '@ui/components/ui/button';
import { ScrollArea } from '@ui/components/ui/scroll-area';
import config from '@ui/config';
import { cn } from '@ui/lib/utils/tailwind';
import { useToolsStore } from '@ui/stores';

import { useChatScrolling } from './ChatHistory.hooks';
import {
  AssistantMessage,
  ErrorMessage,
  MemoriesMessage,
  OtherMessage,
  ToolApprovalMessage,
  UserMessage,
} from './Messages';

const CHAT_SCROLL_AREA_ID = 'chat-scroll-area';

const { systemMemoriesMessageId } = config.chat;

interface ChatHistoryProps {
  messages: UIMessage[];
  chatId: number;
  sessionId: string;
  editingMessageId: string | null;
  editingContent: string;
  onEditStart: (messageId: string, content: string) => void;
  onEditCancel: () => void;
  onEditSave: (messageId: string, newText: string) => Promise<void>;
  onEditChange: (content: string) => void;
  onDeleteMessage: (messageId: string) => Promise<void>;
  onRegenerateMessage: (messageIndex: number) => void;
  isRegenerating?: boolean;
  regeneratingIndex?: number | null;
  isSubmitting?: boolean;
}

interface MessageProps {
  message: UIMessage;
  messageIndex: number;
  editingMessageId: string | null;
  editingContent: string;
  onEditStart: (messageId: string, content: string) => void;
  onEditCancel: () => void;
  onEditSave: (messageId: string, newText: string) => Promise<void>;
  onEditChange: (content: string) => void;
  onDeleteMessage: (messageId: string) => Promise<void>;
  onRegenerateMessage: (messageIndex: number) => void;
  isRegenerating?: boolean;
  regeneratingIndex?: number | null;
}

const Message = ({
  message,
  messageIndex,
  editingMessageId,
  editingContent,
  onEditStart,
  onEditCancel,
  onEditSave,
  onEditChange,
  onDeleteMessage,
  onRegenerateMessage,
  regeneratingIndex,
}: MessageProps) => {
  const isEditing = editingMessageId === message.id;

  // Extract text content for editing
  let textContent = '';
  if (message.parts) {
    textContent = message.parts
      .filter((part: any) => part.type === 'text')
      .map((part: any) => part.text)
      .join('');
  }

  const commonProps = {
    message,
    messageIndex,
    isEditing,
    defaultValue: isEditing ? editingContent : '',
    onEditStart: () => onEditStart(message.id, textContent),
    onEditCancel,
    onSave: (newText: string) => onEditSave(message.id, newText),
    onEditChange,
    onDelete: () => onDeleteMessage(message.id),
  };

  switch (message.role as string) {
    case 'user':
      return <UserMessage {...commonProps} />;
    case 'assistant':
      // Check if this is an error message (has error ID pattern)
      if (message.id.startsWith('error-')) {
        return <ErrorMessage message={message} />;
      }
      return (
        <AssistantMessage
          {...commonProps}
          onRegenerate={() => onRegenerateMessage(messageIndex)}
          isRegenerating={regeneratingIndex === messageIndex}
        />
      );
    case 'system':
      // Check if this is a memories message
      if (message.id === systemMemoriesMessageId) {
        return <MemoriesMessage message={message} />;
      }
      return <OtherMessage message={message} />;
    default:
      return <OtherMessage message={message} />;
  }
};

const getMessageClassName = (role: string) => {
  switch (role) {
    case 'user':
      return 'bg-primary border border-primary/20 ml-8 text-primary-foreground';
    case 'assistant':
      return 'bg-muted mr-8';
    case 'error':
      return 'bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 mr-8';
    case 'system':
      return 'bg-yellow-500/10 border border-yellow-500/20 text-yellow-600';
    default:
      return 'bg-muted border';
  }
};

export default function ChatHistory({
  messages,
  chatId,
  sessionId,
  editingMessageId,
  editingContent,
  onEditStart,
  onEditCancel,
  onEditSave,
  onEditChange,
  onDeleteMessage,
  onRegenerateMessage,
  isRegenerating,
  regeneratingIndex,
  isSubmitting,
}: ChatHistoryProps) {
  // Get pending approvals from the tools store
  const { pendingApprovals } = useToolsStore();
  const scrollAreaRef = useRef<HTMLDivElement | null>(null);

  const { showScrollButton, scrollToBottom } = useChatScrolling({ isSubmitting, messages, scrollAreaRef });

  // Filter out system messages except for special ones like system-memories
  const visibleMessages = messages.filter((message) => {
    if (message.role === 'system') {
      // Only show special system messages like memories
      return message.id === systemMemoriesMessageId;
    }
    return true;
  });

  // Filter pending approvals for this chat
  const chatPendingApprovals = Array.from(pendingApprovals.values()).filter((approval) => approval.chatId === chatId);

  return (
    <div className="relative h-full w-full">
      <ScrollArea
        id={CHAT_SCROLL_AREA_ID}
        className="h-full w-full border rounded-lg overflow-hidden"
        viewportRef={scrollAreaRef}
      >
        <div className="p-4 space-y-4 max-w-full overflow-hidden">
          {visibleMessages.map((message, index) => (
            <div
              key={message.id || `message-${index}`}
              className={cn(
                'rounded-lg overflow-hidden min-w-0',
                // Special handling for memories message
                message.id === systemMemoriesMessageId ? '' : 'p-3',
                message.id === systemMemoriesMessageId ? '' : getMessageClassName(message.role)
              )}
            >
              {message.id !== systemMemoriesMessageId && (
                <div className="text-xs font-medium mb-1 opacity-70 capitalize">{message.role}</div>
              )}
              <div className="overflow-hidden min-w-0">
                <Message
                  message={message}
                  messageIndex={index}
                  editingMessageId={editingMessageId}
                  editingContent={editingContent}
                  onEditStart={onEditStart}
                  onEditCancel={onEditCancel}
                  onEditSave={onEditSave}
                  onEditChange={onEditChange}
                  onDeleteMessage={onDeleteMessage}
                  onRegenerateMessage={onRegenerateMessage}
                  isRegenerating={isRegenerating}
                  regeneratingIndex={regeneratingIndex}
                />
              </div>
            </div>
          ))}

          {/* Render pending tool approvals for this chat */}
          {chatPendingApprovals.map((approval) => (
            <div key={approval.requestId} className="animate-in fade-in-0 slide-in-from-bottom-2">
              <ToolApprovalMessage
                requestId={approval.requestId}
                toolId={approval.toolId}
                toolName={approval.toolName}
                toolDescription={approval.toolDescription}
                args={approval.args}
                isWrite={approval.isWrite}
                sessionId={approval.sessionId}
                chatId={approval.chatId}
              />
            </div>
          ))}
        </div>
      </ScrollArea>

      {/* Scroll to bottom button */}
      {showScrollButton && (
        <Button
          onClick={scrollToBottom}
          className="absolute bottom-4 right-4 z-10 h-6 w-6 rounded-full p-0 shadow-lg cursor-pointer border border-border/40"
          size="sm"
        >
          <ArrowDown className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

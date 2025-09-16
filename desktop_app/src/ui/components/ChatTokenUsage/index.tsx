import { useEffect } from 'react';

import TokenUsageDisplay from '@ui/components/TokenUsageDisplay';
import websocketService from '@ui/lib/websocket';
import { useChatStore } from '@ui/stores';

export default function ChatTokenUsage() {
  const { getCurrentChat } = useChatStore();
  const currentChat = getCurrentChat();

  // Listen for token usage updates via WebSocket
  useEffect(() => {
    const unsubscribe = websocketService.subscribe('chat-token-usage-updated', (message) => {
      const { chatId, totalPromptTokens, totalCompletionTokens, totalTokens, lastModel, lastContextWindow } =
        message.payload;

      // Update the chat store with new token usage
      if (currentChat && currentChat.id === chatId) {
        useChatStore.setState((state) => ({
          chats: state.chats.map((chat) =>
            chat.id === chatId
              ? {
                  ...chat,
                  totalPromptTokens,
                  totalCompletionTokens,
                  totalTokens,
                  lastModel,
                  lastContextWindow,
                }
              : chat
          ),
        }));
      }
    });

    return () => {
      unsubscribe();
    };
  }, [currentChat]);

  if (!currentChat || !currentChat.totalTokens) {
    return null;
  }

  return (
    <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-muted/30 rounded-md">
      <TokenUsageDisplay
        promptTokens={currentChat.totalPromptTokens}
        completionTokens={currentChat.totalCompletionTokens}
        totalTokens={currentChat.totalTokens}
        model={currentChat.lastModel}
        contextWindow={currentChat.lastContextWindow}
        variant="inline"
      />
    </div>
  );
}
import { UIMessage } from 'ai';
import { useState } from 'react';

import { deleteChatMessage, updateChatMessage } from '@ui/lib/clients/archestra/api/gen';

interface UseMessageActionsProps {
  messages: UIMessage[];
  setMessages: (messages: UIMessage[]) => void;
  sendMessage: (message: { text: string }) => void;
  sessionId: string;
}

export function useMessageActions({ messages, setMessages, sendMessage, sessionId }: UseMessageActionsProps) {
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState<string>('');

  const startEdit = (messageId: string, currentContent: string) => {
    setEditingMessageId(messageId);
    setEditingContent(currentContent);
  };

  const cancelEdit = () => {
    setEditingMessageId(null);
    setEditingContent('');
  };

  const saveEdit = async (messageId: string) => {
    if (!editingContent.trim()) return;

    let updatedMessage: UIMessage | null = null;
    const updatedMessages = messages.map((msg) => {
      if (msg.id === messageId) {
        updatedMessage = {
          ...msg,
          parts: [{ type: 'text', text: editingContent }],
        } as UIMessage;
        return updatedMessage;
      }
      return msg;
    });

    setMessages(updatedMessages);
    setEditingMessageId(null);
    setEditingContent('');

    // Save to database
    if (sessionId && updatedMessage) {
      await updateChatMessage({
        path: { id: messageId },
        body: {
          content: updatedMessage,
        },
      });
    }
  };

  const deleteMessage = async (messageId: string) => {
    const updatedMessages = messages.filter((msg) => msg.id !== messageId);
    setMessages(updatedMessages);

    // Save to database
    if (sessionId) {
      await deleteChatMessage({
        path: { id: messageId },
      });
    }
  };

  return {
    editingMessageId,
    editingContent,
    setEditingContent,
    startEdit,
    cancelEdit,
    saveEdit,
    deleteMessage,
  };
}

import { UIMessage } from 'ai';
import { useState } from 'react';

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

    const updatedMessages = messages.map((msg) => {
      if (msg.id === messageId) {
        // Update the message content
        if (msg.role === 'user') {
          return {
            ...msg,
            parts: [{ type: 'text', text: editingContent }],
          } as UIMessage;
        } else if (msg.role === 'assistant') {
          return {
            ...msg,
            parts: [{ type: 'text', text: editingContent }],
          } as UIMessage;
        }
      }
      return msg;
    });

    setMessages(updatedMessages);
    setEditingMessageId(null);
    setEditingContent('');

    // Save to database
    if (sessionId) {
      await saveMessagesToDatabase(sessionId, updatedMessages);
    }
  };

  const deleteMessage = async (messageId: string) => {
    const updatedMessages = messages.filter((msg) => msg.id !== messageId);
    setMessages(updatedMessages);

    // Save to database
    if (sessionId) {
      await saveMessagesToDatabase(sessionId, updatedMessages);
    }
  };

  const saveMessagesToDatabase = async (sessionId: string, messages: UIMessage[]) => {
    // For now, we'll rely on the automatic saving that happens after streaming completes
    // The backend saves messages via the onFinish callback in the streaming response
    // We could add a dedicated endpoint later if needed for immediate saves
    console.log('Messages updated locally, will be saved on next interaction');
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

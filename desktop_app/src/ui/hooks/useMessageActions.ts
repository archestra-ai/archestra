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

  const regenerateMessage = async (messageIndex: number) => {
    // Get all messages up to (but not including) the assistant message to regenerate
    const contextMessages = messages.slice(0, messageIndex);

    // Get the last user message before this assistant message
    let lastUserMessage: UIMessage | null = null;
    for (let i = messageIndex - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        lastUserMessage = messages[i];
        break;
      }
    }

    if (!lastUserMessage) {
      console.error('No user message found before assistant message');
      return;
    }

    // Extract text content from the last user message
    let userText = '';
    if (lastUserMessage.parts) {
      userText = lastUserMessage.parts
        .filter((part) => part.type === 'text')
        .map((part) => (part as any).text)
        .join('');
    }

    // Remove the current assistant message temporarily
    const messagesWithoutCurrent = [...messages.slice(0, messageIndex), ...messages.slice(messageIndex + 1)];
    setMessages(messagesWithoutCurrent);

    // Set context messages for regeneration
    setMessages(contextMessages);

    // Trigger regeneration with the last user message
    sendMessage({ text: userText });

    // After regeneration completes, we'll need to restore following messages
    // This will be handled by the streaming completion callback
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
    regenerateMessage,
  };
}

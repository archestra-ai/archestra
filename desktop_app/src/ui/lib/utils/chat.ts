import {
  type ChatWithMessages,
  type ParsedContent,
  type ServerChatWithMessagesRepresentation,
  type ServerToolCallRepresentation,
  type ToolCall,
  ToolCallStatus,
} from '@ui/types';

import { convertArchestraToolNameToServerAndToolName } from './tools';

export function parseThinkingContent(content: string): ParsedContent {
  if (!content) {
    return { thinking: '', response: '', isThinkingStreaming: false };
  }

  const thinkRegex = /<think>([\s\S]*?)<\/think>/g;

  let thinking = '';
  let response = content;
  let isThinkingStreaming = false;

  const completedMatches = [...content.matchAll(thinkRegex)];
  const completedThinking = completedMatches.map((match) => match[1]).join('\n\n');

  let contentWithoutCompleted = content.replace(thinkRegex, '');

  const incompleteMatch = contentWithoutCompleted.match(/<think>([\s\S]*)$/);

  if (incompleteMatch) {
    const incompleteThinking = incompleteMatch[1];
    const beforeIncomplete = contentWithoutCompleted.substring(0, contentWithoutCompleted.indexOf('<think>'));

    thinking = completedThinking ? `${completedThinking}\n\n${incompleteThinking}` : incompleteThinking;
    response = beforeIncomplete.trim();
    isThinkingStreaming = true;
  } else {
    thinking = completedThinking;
    response = contentWithoutCompleted.trim();
    isThinkingStreaming = false;
  }

  return {
    thinking,
    response,
    isThinkingStreaming,
  };
}

const generateNewToolCallId = () => crypto.randomUUID();

export const initializeToolCalls = (toolCalls: ServerToolCallRepresentation[]): ToolCall[] => {
  return toolCalls.map((toolCall) => {
    const [serverName, toolName] = convertArchestraToolNameToServerAndToolName(toolCall.function.name);
    return {
      ...toolCall,
      id: generateNewToolCallId(),
      serverName,
      name: toolName,
      arguments: toolCall.function.arguments as Record<string, any>,
      result: '',
      error: '',
      status: ToolCallStatus.Pending,
      executionTime: 0,
      startTime: null,
      endTime: null,
    };
  });
};

export const initializeChat = (chat: ServerChatWithMessagesRepresentation): ChatWithMessages => {
  return {
    ...chat,
    messages: chat.messages.map((message) => message.content as any), // Content is already a UIMessage from the backend
    // Token usage fields will be included from the chat object
  };
};

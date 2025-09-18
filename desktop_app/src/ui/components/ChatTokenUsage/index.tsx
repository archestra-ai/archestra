import TokenUsageDisplay from '@ui/components/TokenUsageDisplay';
import { useChatStore } from '@ui/stores';

export default function ChatTokenUsage() {
  const { getCurrentChat } = useChatStore();
  const currentChat = getCurrentChat();

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

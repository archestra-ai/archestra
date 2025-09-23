import PromptCollection from '@ui/components/Chat/PromptCollection';
import { useChatStore } from '@ui/stores';

interface EmptyChatStateProps {
  onPromptSelect: (prompt: string) => void;
}

export default function EmptyChatState({ onPromptSelect }: EmptyChatStateProps) {
  const { selectedModel } = useChatStore();
  const hasSelectedModel = !!(selectedModel && selectedModel !== '');

  if (!hasSelectedModel) {
    return (
      <div className="flex items-center justify-center h-full p-8">
        <div className="text-muted-foreground">Please select a model to get started</div>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-center h-full p-8">
      <PromptCollection onPromptSelect={onPromptSelect} />
    </div>
  );
}

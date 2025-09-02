import PromptCollection from '@ui/components/Chat/PromptCollection';

interface EmptyChatStateProps {
  onPromptSelect: (prompt: string) => void;
}

export default function EmptyChatState({ onPromptSelect }: EmptyChatStateProps) {
  return (
    <div className="flex items-center justify-center h-full p-8">
      <PromptCollection onPromptSelect={onPromptSelect} />
    </div>
  );
}

import { MessageSquare } from 'lucide-react';

import PromptCollection from '@ui/components/Chat/PromptCollection';

interface EmptyChatStateProps {
  onPromptSelect: (prompt: string) => void;
}

export default function EmptyChatState({ onPromptSelect }: EmptyChatStateProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full p-8">
      <div className="mb-8 text-center">
        <div className="inline-flex p-4 rounded-full bg-primary/10 mb-4">
          <MessageSquare className="h-10 w-10 text-primary" />
        </div>
        <h1 className="text-3xl font-bold mb-2">Welcome to Archestra Chat</h1>
        <p className="text-lg text-muted-foreground">Start a conversation or choose from our templates below</p>
      </div>

      <PromptCollection onPromptSelect={onPromptSelect} />
    </div>
  );
}

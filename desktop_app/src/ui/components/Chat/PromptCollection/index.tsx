import { useEffect } from 'react';

import PromptCard from '@ui/components/Chat/PromptCard';
import { promptTemplates } from '@ui/data/prompt-templates';
import { useMemoryStore } from '@ui/stores';

interface PromptCollectionProps {
  onPromptSelect: (prompt: string) => void;
}

export default function PromptCollection({ onPromptSelect }: PromptCollectionProps) {
  const { memories, isLoading, fetchMemories } = useMemoryStore();

  // Ensure memory is fetched on mount
  useEffect(() => {
    if (memories.length === 0 && !isLoading) {
      fetchMemories();
    }
  }, []);

  // Check if memory is empty
  const isMemoryEmpty = memories.length === 0;

  // Filter templates based on memory state
  // If no memories exist, show ONLY the Personal Assistant Setup
  // If memories exist, show all templates EXCEPT the Personal Assistant Setup
  const templatesToShow = isMemoryEmpty
    ? promptTemplates.filter((template) => template.id === 'initial-setup')
    : promptTemplates.filter((template) => template.id !== 'initial-setup');

  // Show loading state if memory is still being fetched
  if (isLoading && memories.length === 0) {
    return (
      <div className="w-full max-w-5xl mx-auto flex justify-center items-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-5xl mx-auto">
      <div className={isMemoryEmpty ? 'flex justify-center' : 'grid grid-cols-1 md:grid-cols-2 gap-4'}>
        {templatesToShow.map((template) => (
          <PromptCard key={template.id} template={template} onClick={onPromptSelect} />
        ))}
      </div>
    </div>
  );
}

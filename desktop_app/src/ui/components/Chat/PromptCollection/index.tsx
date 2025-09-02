import PromptCard from '@ui/components/Chat/PromptCard';
import { promptTemplates } from '@ui/data/prompt-templates';

interface PromptCollectionProps {
  onPromptSelect: (prompt: string) => void;
}

export default function PromptCollection({ onPromptSelect }: PromptCollectionProps) {
  return (
    <div className="w-full max-w-5xl mx-auto">
      <div className="text-center mb-8">
        <h2 className="text-2xl font-bold mb-2">Start with a Template</h2>
        <p className="text-muted-foreground">Choose a pre-built prompt to get started quickly</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {promptTemplates.map((template) => (
          <PromptCard key={template.id} template={template} onClick={onPromptSelect} />
        ))}
      </div>
    </div>
  );
}

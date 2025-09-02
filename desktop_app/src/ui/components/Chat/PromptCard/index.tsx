import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ui/components/ui/card';
import { type PromptTemplate } from '@ui/data/prompt-templates';
import { cn } from '@ui/lib/utils/tailwind';

interface PromptCardProps {
  template: PromptTemplate;
  onClick: (prompt: string) => void;
  className?: string;
}

export default function PromptCard({ template, onClick, className }: PromptCardProps) {
  const Icon = template.icon;

  return (
    <Card
      className={cn(
        'cursor-pointer transition-all hover:shadow-lg hover:scale-[1.02] hover:border-primary/50',
        'bg-card/50 backdrop-blur-sm',
        className
      )}
      onClick={() => onClick(template.prompt)}
    >
      <CardHeader className="pb-3">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-primary/10">
            <Icon className="h-5 w-5 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <CardTitle className="text-base font-semibold leading-tight">{template.title}</CardTitle>
            <div className="text-xs text-muted-foreground mt-1">{template.category}</div>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <CardDescription className="text-sm line-clamp-2">{template.description}</CardDescription>
      </CardContent>
    </Card>
  );
}

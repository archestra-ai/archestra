import { Card, CardContent } from "@/components/ui/card";

interface PromptSuggestion {
  title: string;
  prompt: string;
}

const DEFAULT_PROMPTS: PromptSuggestion[] = [
  {
    title: "Check n8n Connectivity",
    prompt: "Check n8n connectivity by running healthcheck tool",
  },
  {
    title: "Create Demo AI Agent Workflow",
    prompt:
      "Create an n8n workflow that includes the default AI Agent node. It should be a simple default node. Use node names instead of IDs in the connections. Use n8n mcp to create flow",
  },
];

interface PromptSuggestionsProps {
  onSelectPrompt: (prompt: string) => void;
}

export function PromptSuggestions({ onSelectPrompt }: PromptSuggestionsProps) {
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="max-w-2xl w-full space-y-6">
        <div className="text-center space-y-2">
          <h2 className="text-2xl font-semibold">Start a Conversation</h2>
          <p className="text-muted-foreground">
            Choose a prompt below or type your own message
          </p>
        </div>

        <div className="grid gap-3">
          {DEFAULT_PROMPTS.map((suggestion, index) => (
            <Card
              key={suggestion.prompt}
              className="cursor-pointer hover:bg-accent transition-colors"
              onClick={() => onSelectPrompt(suggestion.prompt)}
            >
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                    <span className="text-sm font-medium text-primary">
                      {index + 1}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-medium mb-1">{suggestion.title}</h3>
                    <p className="text-sm text-muted-foreground">
                      {suggestion.prompt}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}

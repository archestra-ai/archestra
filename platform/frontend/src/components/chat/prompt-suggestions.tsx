import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAgentPrompts } from "@/lib/agent-prompts.query";

interface PromptSuggestionsProps {
  agentId?: string;
  agentName?: string;
  onSelectPrompt: (prompt: string) => void;
}

export function PromptSuggestions({
  agentId,
  agentName,
  onSelectPrompt,
}: PromptSuggestionsProps) {
  // Fetch prompts assigned to the agent (hook must be called before any returns)
  const { data: agentPrompts } = useAgentPrompts(agentId ?? "", {
    initialData: [],
  });

  // If no agentId, show empty state
  if (!agentId) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="max-w-2xl w-full space-y-6">
          <div className="text-center space-y-2">
            <h2 className="text-2xl font-semibold">Start a Conversation</h2>
            <p className="text-muted-foreground">
              Select an agent to see prompt suggestions
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Extract system and regular prompts
  const systemPrompt = agentPrompts.find(
    (ap) => ap.prompt.type === "system",
  )?.prompt;
  const regularPrompts = agentPrompts
    .filter((ap) => ap.prompt.type === "regular")
    .map((ap) => ap.prompt);

  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="max-w-2xl w-full space-y-6">
        <div className="text-center space-y-2">
          <h2 className="text-2xl font-semibold">Start a Conversation</h2>
          {systemPrompt && (
            <TooltipProvider>
              <p className="text-muted-foreground">
                System prompt:{" "}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="font-medium underline decoration-dotted cursor-help">
                      {systemPrompt.name}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent
                    side="bottom"
                    className="max-w-md max-h-96 overflow-y-auto"
                  >
                    <div className="whitespace-pre-wrap text-xs">
                      {systemPrompt.content}
                    </div>
                  </TooltipContent>
                </Tooltip>
              </p>
            </TooltipProvider>
          )}
          <p className="text-muted-foreground">
            Choose a prompt below or type your own message
          </p>
        </div>

        <div className="grid gap-3">
          {regularPrompts && regularPrompts.length > 0 ? (
            regularPrompts.map((prompt, index) => (
              <Card
                key={prompt.id}
                className="cursor-pointer hover:bg-accent transition-colors"
                onClick={() => onSelectPrompt(prompt.content)}
              >
                <CardContent className="p-4">
                  <div className="flex items-start gap-3">
                    <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                      <span className="text-sm font-medium text-primary">
                        {index + 1}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="font-medium mb-1">{prompt.name}</h3>
                      <p className="text-sm text-muted-foreground">
                        {prompt.content}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))
          ) : (
            <p className="text-center text-muted-foreground">
              No prompt suggestions available
            </p>
          )}
        </div>

        {agentId && agentName && (
          <div className="text-center pt-2">
            <Link
              href={`/agents?agentId=${agentId}`}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              + Add more prompts to {agentName}
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

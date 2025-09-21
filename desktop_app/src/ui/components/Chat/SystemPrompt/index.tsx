import { DEFAULT_SYSTEM_PROMPT } from '@constants';
import { Button } from '@ui/components/ui/button';
import { Label } from '@ui/components/ui/label';
import { Textarea } from '@ui/components/ui/textarea';
import { useDeveloperModeStore } from '@ui/stores';

interface SystemPromptProps {}

export default function SystemPrompt(_props: SystemPromptProps) {
  const { isDeveloperMode, getSystemPrompt, setCustomSystemPrompt } = useDeveloperModeStore();
  const systemPrompt = getSystemPrompt();

  if (!isDeveloperMode) {
    return null;
  }

  return (
    <div className="flex-shrink-0">
      <div className="space-y-2 p-3 bg-muted/30 rounded-md border border-muted">
        <div className="flex items-center justify-between">
          <Label htmlFor="system-prompt" className="text-sm font-medium text-muted-foreground">
            System Prompt
          </Label>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setCustomSystemPrompt(DEFAULT_SYSTEM_PROMPT)}
            className="h-6 px-2 text-xs"
          >
            Reset
          </Button>
        </div>
        <Textarea
          id="system-prompt"
          value={systemPrompt}
          onChange={(e) => setCustomSystemPrompt(e.target.value)}
          placeholder="Enter system prompt for the AI assistant..."
          className="min-h-20 resize-none"
        />
      </div>
    </div>
  );
}

import { ExternalLink, KeyRound } from "lucide-react";
import { Tool, ToolContent, ToolHeader } from "@/components/ai-elements/tool";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

interface AuthRequiredToolProps {
  toolName: string;
  catalogName: string;
  installUrl: string;
}

export function AuthRequiredTool({
  toolName,
  catalogName,
  installUrl,
}: AuthRequiredToolProps) {
  return (
    <Tool defaultOpen={true}>
      <ToolHeader
        type={`tool-${toolName}`}
        state="output-error"
        isCollapsible={true}
      />
      <ToolContent>
        <div className="p-4 pt-0">
          <Alert variant="warning">
            <KeyRound />
            <AlertTitle>Authentication Required</AlertTitle>
            <AlertDescription>
              <p>
                No credentials found for &ldquo;{catalogName}&rdquo;. Set up
                your credentials to use this tool.
              </p>
              <Button variant="default" size="sm" asChild>
                <a href={installUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="size-3.5" />
                  Set up credentials
                </a>
              </Button>
            </AlertDescription>
          </Alert>
        </div>
      </ToolContent>
    </Tool>
  );
}

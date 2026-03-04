import { ExternalLink, KeyRound } from "lucide-react";
import type { ReactNode } from "react";
import { Tool, ToolContent, ToolHeader } from "@/components/ai-elements/tool";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

interface AuthErrorToolProps {
  toolName: string;
  title: string;
  description: ReactNode;
  buttonText: string;
  buttonUrl: string;
}

export function AuthErrorTool({
  toolName,
  title,
  description,
  buttonText,
  buttonUrl,
}: AuthErrorToolProps) {
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
            <AlertTitle>{title}</AlertTitle>
            <AlertDescription>
              <p>{description}</p>
              <Button variant="default" size="sm" asChild>
                <a href={buttonUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="size-3.5" />
                  {buttonText}
                </a>
              </Button>
            </AlertDescription>
          </Alert>
        </div>
      </ToolContent>
    </Tool>
  );
}

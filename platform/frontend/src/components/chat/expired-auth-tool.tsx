import { ExternalLink, ShieldAlert } from "lucide-react";
import { Tool, ToolContent, ToolHeader } from "@/components/ai-elements/tool";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

interface ExpiredAuthToolProps {
  toolName: string;
  catalogName: string;
  manageUrl: string;
}

export function ExpiredAuthTool({
  toolName,
  catalogName,
  manageUrl,
}: ExpiredAuthToolProps) {
  return (
    <Tool defaultOpen={true}>
      <ToolHeader
        type={`tool-${toolName}`}
        state="output-error"
        isCollapsible={true}
      />
      <ToolContent>
        <div className="p-4 pt-0">
          <Alert variant="destructive">
            <ShieldAlert />
            <AlertTitle>Expired / Invalid Authentication</AlertTitle>
            <AlertDescription>
              <p>
                Your credentials for &ldquo;{catalogName}&rdquo; have expired or
                are invalid. Revoke the old credentials and re-authenticate to
                continue using this tool.
              </p>
              <Button variant="default" size="sm" asChild>
                <a href={manageUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="size-3.5" />
                  Manage credentials
                </a>
              </Button>
            </AlertDescription>
          </Alert>
        </div>
      </ToolContent>
    </Tool>
  );
}

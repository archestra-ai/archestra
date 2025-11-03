"use client";

import { Info } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export function N8nConnectionDialog() {
  const [open, setOpen] = useState(false);

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Info className="h-4 w-4" />
          How to connect n8n
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>How to Connect n8n</DialogTitle>
          <DialogDescription>
            This chat works best as n8n assistant. Follow these steps to connect
            the n8n MCP server
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 mt-4">
          <div className="space-y-3">
            <h3 className="font-semibold text-sm">1. Create Agent</h3>
            <p className="text-sm text-muted-foreground">
              Navigate to Agents page and create a new agent for n8n assistance.
            </p>
          </div>

          <div className="space-y-3">
            <h3 className="font-semibold text-sm">2. Connect n8n MCP Server</h3>
            <p className="text-sm text-muted-foreground mb-2">
              Go to <strong>MCP Registry → Add MCP Server → Local</strong> and
              configure:
            </p>
            <div className="space-y-2">
              <div className="border rounded-lg p-3 bg-muted/50">
                <div className="text-xs font-medium text-muted-foreground mb-1">
                  Name
                </div>
                <code className="text-sm">n8n</code>
              </div>

              <div className="border rounded-lg p-3 bg-muted/50">
                <div className="text-xs font-medium text-muted-foreground mb-1">
                  Command
                </div>
                <code className="text-sm">npx</code>
              </div>

              <div className="border rounded-lg p-3 bg-muted/50">
                <div className="text-xs font-medium text-muted-foreground mb-1">
                  Arguments
                </div>
                <code className="text-sm">n8n-mcp</code>
              </div>

              <div className="border rounded-lg p-3 bg-muted/50">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    Environment Variables
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() =>
                      copyToClipboard(`MCP_MODE=stdio
LOG_LEVEL=error
N8N_API_KEY=<your-n8n-api-key>
N8N_API_URL=<your-n8n-url>
DISABLE_CONSOLE_OUTPUT=true`)
                    }
                  >
                    Copy
                  </Button>
                </div>
                <pre className="text-xs overflow-x-auto">
                  {`MCP_MODE=stdio
LOG_LEVEL=error
N8N_API_KEY=<your-n8n-api-key>
N8N_API_URL=<your-n8n-url>
DISABLE_CONSOLE_OUTPUT=true`}
                </pre>
                <p className="text-xs text-muted-foreground mt-2">
                  Get your N8N_API_KEY from:{" "}
                  <code className="bg-muted px-1 py-0.5 rounded">
                    Profile → Settings → n8n API
                  </code>
                </p>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="font-semibold text-sm">3. Install the MCP Server</h3>
            <p className="text-sm text-muted-foreground">
              Click the <strong>Install</strong> button to add the n8n MCP
              server to your system.
            </p>
          </div>

          <div className="space-y-3">
            <h3 className="font-semibold text-sm">
              4. Assign MCP Server Tools to Agent
            </h3>
            <p className="text-sm text-muted-foreground">
              Assign all available n8n MCP server tools to your newly created
              agent.
            </p>
          </div>

          <div className="space-y-3">
            <h3 className="font-semibold text-sm">
              5. Set Archestra Environment Variables
            </h3>
            <p className="text-sm text-muted-foreground mb-2">
              Add these environment variables to your Archestra configuration:
            </p>
            <div className="border rounded-lg p-3 bg-muted/50 relative">
              <Button
                variant="ghost"
                size="sm"
                className="absolute top-2 right-2 h-6 px-2 text-xs"
                onClick={() =>
                  copyToClipboard(`ARCHESTRA_CHAT_MCP_SERVER_URL=http://localhost:9000/v1/mcp
ARCHESTRA_CHAT_MCP_SERVER_HEADERS={"Authorization":"Bearer 70c089bf-ba18-4a86-9eca-ba78aa46cc38","Accept":"application/json, text/event-stream"}
ARCHESTRA_CHAT_ANTHROPIC_API_KEY=<your-anthropic-api-key>`)
                }
              >
                Copy
              </Button>
              <pre className="text-xs overflow-x-auto pr-16">
                {`ARCHESTRA_CHAT_MCP_SERVER_URL=http://localhost:9000/v1/mcp
ARCHESTRA_CHAT_MCP_SERVER_HEADERS={"Authorization":"Bearer 70c089bf-ba18-4a86-9eca-ba78aa46cc38","Accept":"application/json, text/event-stream"}
ARCHESTRA_CHAT_ANTHROPIC_API_KEY=<your-anthropic-api-key>`}
              </pre>
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="font-semibold text-sm">6. Restart Archestra</h3>
            <p className="text-sm text-muted-foreground">
              Restart your Archestra instance to apply the environment variable
              changes.
            </p>
          </div>

          <div className="border-l-4 border-blue-500 bg-blue-50 dark:bg-blue-950/20 p-3 rounded">
            <p className="text-sm font-medium mb-1">💡 Note</p>
            <p className="text-sm text-muted-foreground">
              After completing these steps, your chat will be ready to work as
              an n8n assistant with full access to n8n workflows and operations.
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

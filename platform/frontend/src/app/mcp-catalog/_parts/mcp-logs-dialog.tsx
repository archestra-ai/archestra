"use client";

import { Copy, Terminal } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";

interface McpLogsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverName: string;
  logs: string;
  command: string;
  isLoading: boolean;
  error?: Error | null;
}

export function McpLogsDialog({
  open,
  onOpenChange,
  serverName,
  logs,
  command,
  isLoading,
  error,
}: McpLogsDialogProps) {
  const [copied, setCopied] = useState(false);
  const [commandCopied, setCommandCopied] = useState(false);

  const handleCopyLogs = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(logs);
      setCopied(true);
      toast.success("Logs copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch (_error) {
      toast.error("Failed to copy logs");
    }
  }, [logs]);

  const handleCopyCommand = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCommandCopied(true);
      toast.success("Command copied to clipboard");
      setTimeout(() => setCommandCopied(false), 2000);
    } catch (_error) {
      toast.error("Failed to copy command");
    }
  }, [command]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Terminal className="h-5 w-5" />
            Logs: {serverName}
          </DialogTitle>
          <DialogDescription>
            View the recent logs from the MCP server container
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 flex-1 min-h-0">
          {/* Logs section */}
          <div className="flex flex-col gap-2 flex-1 min-h-0">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Container Logs</h3>
              <Button
                variant="outline"
                size="sm"
                onClick={handleCopyLogs}
                disabled={isLoading || !!error || !logs}
              >
                <Copy className="mr-2 h-3 w-3" />
                {copied ? "Copied!" : "Copy"}
              </Button>
            </div>

            <div className="h-[450px] rounded-md border bg-slate-950 overflow-y-scroll">
              <div className="p-4">
                {isLoading ? (
                  <div className="text-slate-400 font-mono text-sm">
                    Loading logs...
                  </div>
                ) : error ? (
                  <div className="text-red-400 font-mono text-sm">
                    Error loading logs: {error.message}
                  </div>
                ) : logs ? (
                  <pre className="text-slate-200 font-mono text-xs whitespace-pre-wrap">
                    {logs}
                  </pre>
                ) : (
                  <div className="text-slate-400 font-mono text-sm">
                    No logs available
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Command section */}
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">Manual Command</h3>
            <div className="relative">
              <ScrollArea className="rounded-md border bg-slate-950 p-3 pr-16">
                <code className="text-slate-200 font-mono text-xs break-all">
                  {command}
                </code>
              </ScrollArea>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCopyCommand}
                className="absolute top-1 right-1"
              >
                <Copy className="h-3 w-3" />
                {commandCopied ? "Copied!" : ""}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Run this command from your terminal to fetch the logs manually
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

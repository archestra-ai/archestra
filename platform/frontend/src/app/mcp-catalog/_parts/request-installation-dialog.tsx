"use client";

import type { archestraCatalogTypes } from "@shared";
import { Loader2 } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useCreateMcpServerInstallationRequest } from "@/lib/mcp-server-installation-request.query";

export function RequestInstallationDialog({
  server,
  onClose,
}: {
  server: archestraCatalogTypes.ArchestraMcpServerManifest | null;
  onClose: () => void;
}) {
  const [requestReason, setRequestReason] = useState("");
  const createRequest = useCreateMcpServerInstallationRequest();

  const handleSubmit = useCallback(async () => {
    if (!server) return;

    await createRequest.mutateAsync({
      externalCatalogId: server.name,
      requestReason,
      customServerConfig: null,
    });

    setRequestReason("");
    onClose();
  }, [server, requestReason, createRequest, onClose]);

  return (
    <Dialog open={!!server} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Request MCP Server Installation</DialogTitle>
          <DialogDescription>
            Request this MCP server to be added to your organization's internal
            registry. An admin will review your request.
          </DialogDescription>
        </DialogHeader>

        {server && (
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label className="text-sm font-medium">Server</Label>
              <div className="p-3 border rounded-md bg-muted/50">
                <div className="flex items-center gap-2">
                  {server.icon && (
                    <img
                      src={server.icon}
                      alt={`${server.name} icon`}
                      className="w-6 h-6 rounded"
                    />
                  )}
                  <span className="font-medium">
                    {server.display_name || server.name}
                  </span>
                </div>
                {server.description && (
                  <p className="text-sm text-muted-foreground mt-2">
                    {server.description}
                  </p>
                )}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="reason">
                Reason for Request{" "}
                <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Textarea
                id="reason"
                placeholder="Explain why your team needs this MCP server..."
                value={requestReason}
                onChange={(e) => setRequestReason(e.target.value)}
                rows={4}
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={createRequest.isPending || !server}
          >
            {createRequest.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Submit Request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

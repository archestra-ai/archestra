"use client";

import type { archestraCatalogTypes } from "@shared";
import { Loader2 } from "lucide-react";
import { useCallback, useState } from "react";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
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
    <StandardFormDialog
      open={!!server}
      onOpenChange={(open) => !open && onClose()}
      title="Request MCP Server Installation"
      description="Request this MCP server to be added to your organization's internal registry. An admin will review your request."
      size="small"
      bodyClassName="space-y-4"
      onSubmit={handleSubmit}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={createRequest.isPending || !server}>
            {createRequest.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Submit Request
          </Button>
        </>
      }
    >
      {server ? (
        <>
          <div className="space-y-2">
            <Label className="text-sm font-medium">Server</Label>
            <div className="rounded-md border bg-muted/50 p-3">
              <div className="flex items-center gap-2">
                {server.icon && (
                  <img
                    src={server.icon}
                    alt={`${server.name} icon`}
                    className="h-6 w-6 rounded"
                  />
                )}
                <span className="font-medium">
                  {server.display_name || server.name}
                </span>
              </div>
              {server.description ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  {server.description}
                </p>
              ) : null}
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
        </>
      ) : null}
    </StandardFormDialog>
  );
}

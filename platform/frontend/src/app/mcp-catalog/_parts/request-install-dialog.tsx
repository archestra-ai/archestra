"use client";

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
import type { GetInternalMcpCatalogResponses } from "@/lib/clients/api";

interface RequestInstallDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onRequest: (
    catalogItem: GetInternalMcpCatalogResponses["200"][number],
    requestNotes: string,
  ) => Promise<void>;
  catalogItem: GetInternalMcpCatalogResponses["200"][number] | null;
  isRequesting: boolean;
}

export function RequestInstallDialog({
  isOpen,
  onClose,
  onRequest,
  catalogItem,
  isRequesting,
}: RequestInstallDialogProps) {
  const [requestNotes, setRequestNotes] = useState("");

  const handleRequest = useCallback(async () => {
    if (!catalogItem) {
      return;
    }

    try {
      await onRequest(catalogItem, requestNotes);
      setRequestNotes("");
      onClose();
    } catch (_error) {
      // Error handling is done in the parent component
    }
  }, [catalogItem, requestNotes, onRequest, onClose]);

  const handleClose = useCallback(() => {
    setRequestNotes("");
    onClose();
  }, [onClose]);

  if (!catalogItem) {
    return null;
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Request MCP Server Installation</DialogTitle>
          <DialogDescription>
            Submit a request to add {catalogItem.label || catalogItem.name} to
            the internal registry. An administrator will review your request.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="request-notes">Request Notes (Optional)</Label>
            <Textarea
              id="request-notes"
              placeholder="Explain why you need this MCP server..."
              value={requestNotes}
              onChange={(e) => setRequestNotes(e.target.value)}
              rows={4}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={isRequesting}>
            Cancel
          </Button>
          <Button onClick={handleRequest} disabled={isRequesting}>
            {isRequesting ? "Submitting..." : "Submit Request"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

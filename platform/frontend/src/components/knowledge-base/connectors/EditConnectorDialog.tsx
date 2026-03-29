"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { NotionConnectorFields } from "./NotionConnectorFields";
import { CONNECTOR_LABELS } from "@archestra/shared/knowledge-base";

export type ConnectorType = (typeof CONNECTOR_LABELS)[number];

interface Connector {
  id: string;
  type: ConnectorType;
  name: string;
  config: Record<string, unknown>;
}

interface EditConnectorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connector: Connector | null;
  onSubmit: (data: {
    id: string;
    name: string;
    config: Record<string, unknown>;
  }) => Promise<void> | void;
}

export function EditConnectorDialog({
  open,
  onOpenChange,
  connector,
  onSubmit,
}: EditConnectorDialogProps) {
  const [name, setName] = useState("");
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync state when connector prop changes
  useEffect(() => {
    if (connector) {
      setName(connector.name);
      setConfig(connector.config);
      setError(null);
    }
  }, [connector]);

  function handleClose(value: boolean) {
    if (!value) {
      setError(null);
    }
    onOpenChange(value);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!connector) return;
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit({ id: connector.id, name, config });
      handleClose(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setSubmitting(false);
    }
  }

  function renderConfigFields() {
    switch (connector?.type) {
      case "notion":
        return (
          <NotionConnectorFields
            name={name}
            onNameChange={setName}
            config={config}
            onConfigChange={setConfig}
          />
        );
      default:
        return null;
    }
  }

  if (!connector) return null;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit Connector</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {renderConfigFields()}

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleClose(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Saving…" : "Save Changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

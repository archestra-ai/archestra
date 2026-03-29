"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ConnectorTypeSelector } from "./ConnectorTypeSelector";
import { NotionConnectorFields } from "./NotionConnectorFields";
import { CONNECTOR_LABELS } from "@archestra/shared/knowledge-base";

export type ConnectorType = (typeof CONNECTOR_LABELS)[number];

interface CreateConnectorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: {
    type: ConnectorType;
    name: string;
    config: Record<string, unknown>;
  }) => Promise<void> | void;
}

export function CreateConnectorDialog({
  open,
  onOpenChange,
  onSubmit,
}: CreateConnectorDialogProps) {
  const [step, setStep] = useState<"select" | "configure">("select");
  const [selectedType, setSelectedType] = useState<ConnectorType | null>(null);
  const [name, setName] = useState("");
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleClose(value: boolean) {
    if (!value) {
      // Reset state on close
      setStep("select");
      setSelectedType(null);
      setName("");
      setConfig({});
      setError(null);
    }
    onOpenChange(value);
  }

  function handleTypeSelect(type: ConnectorType) {
    setSelectedType(type);
    setStep("configure");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedType) return;
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit({ type: selectedType, name, config });
      handleClose(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setSubmitting(false);
    }
  }

  function renderConfigFields() {
    switch (selectedType) {
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

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {step === "select" ? "Select Connector Type" : "Configure Connector"}
          </DialogTitle>
        </DialogHeader>

        {step === "select" ? (
          <ConnectorTypeSelector onSelect={handleTypeSelect} />
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {renderConfigFields()}

            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}

            <DialogFooter className="gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setStep("select")}
                disabled={submitting}
              >
                Back
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? "Creating…" : "Create Connector"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

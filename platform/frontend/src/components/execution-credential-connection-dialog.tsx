"use client";

import { useState } from "react";
import { toast } from "sonner";
import { ExecutionCredentialIcon } from "@/components/execution-credential-icon";
import { ExternalSecretReferenceDialog } from "@/components/external-secret-reference-dialog";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { SecretInput } from "@/components/ui/secret-input";
import {
  type ExecutionCredentialDefinition,
  useSetExecutionCredentialConnection,
} from "@/lib/execution-credentials.query";

export function ExecutionCredentialConnectionDialog({
  definition,
  scope,
  useExternalSecretsManager = false,
  onClose,
  onConnected,
}: {
  definition: ExecutionCredentialDefinition;
  scope: "personal" | "organization";
  useExternalSecretsManager?: boolean;
  onClose: () => void;
  onConnected?: () => void;
}) {
  const [value, setValue] = useState("");
  const connect = useSetExecutionCredentialConnection();

  const save = (nextValue: string) => {
    connect.mutate(
      { key: definition.key, scope, value: nextValue },
      {
        onSuccess: () => {
          toast.success(`${definition.name} connected`);
          onConnected?.();
          onClose();
        },
      },
    );
  };

  if (useExternalSecretsManager) {
    return (
      <ExternalSecretReferenceDialog
        fieldLabel={definition.name}
        description={`Select the Vault value for this ${scope} connection.`}
        onClose={onClose}
        onConfirm={save}
      />
    );
  }

  return (
    <StandardFormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="small"
      title={
        <span className="flex items-center gap-2">
          <ExecutionCredentialIcon icon={definition.icon} />
          Connect {definition.name}
        </span>
      }
      description={
        scope === "personal"
          ? "This value is private to you and works with every Agent that requests this credential."
          : "This value is available to everyone who runs an Agent bound to this organization connection."
      }
      onSubmit={(event) => {
        event.preventDefault();
        save(value);
      }}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!value.trim() || connect.isPending}>
            {connect.isPending ? "Connecting…" : "Connect"}
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <Label htmlFor="execution-credential-value">Secret value</Label>
        <CredentialConnectionHelp definition={definition} />
        <SecretInput
          id="execution-credential-value"
          autoFocus
          revealable
          autoComplete="off"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Paste secret"
        />
      </div>
    </StandardFormDialog>
  );
}

function CredentialConnectionHelp({
  definition,
}: {
  definition: ExecutionCredentialDefinition;
}) {
  if (definition.key === "claude-code") {
    return (
      <p className="text-xs text-muted-foreground">
        A personal subscription token created by the official Claude Code
        client. Run{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em] text-foreground">
          claude setup-token
        </code>{" "}
        on your machine to get the value.
      </p>
    );
  }

  if (definition.key === "github") {
    return (
      <p className="text-xs text-muted-foreground">
        A GitHub personal access token for repository access. Create one in{" "}
        <a
          href="https://github.com/settings/personal-access-tokens/new"
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2"
        >
          GitHub Developer settings
        </a>
        .
      </p>
    );
  }

  if (!definition.description) return null;
  return (
    <p className="text-xs text-muted-foreground">{definition.description}</p>
  );
}

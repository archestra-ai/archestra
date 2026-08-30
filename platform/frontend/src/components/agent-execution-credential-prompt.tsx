"use client";

import { KeyRound } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { ExecutionCredentialConnectionDialog } from "@/components/execution-credential-connection-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useFeature } from "@/lib/config/config.query";
import {
  type ExecutionCredentialDefinition,
  useExecutionCredentials,
} from "@/lib/execution-credentials.query";

type MissingCredential = {
  key: string;
  credentialId?: string;
  label: string;
  description?: string;
};

type CredentialDeclaration = MissingCredential & {
  scope: "shared" | "per_user";
  required: boolean;
};

export function AgentExecutionCredentialPrompt({
  agentId,
  missing,
  declarations,
  onConnected,
}: {
  agentId: string;
  missing: MissingCredential[];
  declarations: CredentialDeclaration[];
  onConnected: () => void;
}) {
  const definitions = useExecutionCredentials();
  const byosEnabled = useFeature("byosEnabled");
  const [connecting, setConnecting] =
    useState<ExecutionCredentialDefinition | null>(null);
  const personalMissing = useMemo(
    () =>
      missing.find((credential) => {
        const declaration = declarations.find(
          (candidate) => candidate.key === credential.key,
        );
        return declaration?.scope === "per_user" && credential.credentialId;
      }),
    [declarations, missing],
  );
  const definition = definitions.data?.find(
    (candidate) => candidate.key === personalMissing?.credentialId,
  );
  const firstDeclaration = declarations.find(
    (candidate) => candidate.key === missing[0]?.key,
  );
  const helperText = definition
    ? "Connect it once to use it with every compatible Agent."
    : firstDeclaration?.scope === "shared"
      ? "An admin must configure this organization connection."
      : "Add this personal secret from the Agent details page.";

  return (
    <Alert variant="warning" className="mt-3">
      <KeyRound />
      <AlertTitle>
        {missing.length === 1
          ? `${missing[0].label} is required`
          : `${missing.length} connections are required`}
      </AlertTitle>
      <AlertDescription className="flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
        <p>{helperText}</p>
        {definition ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 shrink-0 bg-background"
            onClick={() => setConnecting(definition)}
          >
            Connect
          </Button>
        ) : (
          <Button asChild size="sm" variant="outline" className="h-8 shrink-0">
            <Link
              href={`/agents/${agentId}?tab=overview#background-execution-credentials`}
            >
              Agent details
            </Link>
          </Button>
        )}
      </AlertDescription>
      {connecting && (
        <ExecutionCredentialConnectionDialog
          definition={connecting}
          scope="personal"
          useExternalSecretsManager={byosEnabled}
          onConnected={onConnected}
          onClose={() => setConnecting(null)}
        />
      )}
    </Alert>
  );
}

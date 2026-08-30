"use client";

import { KeyRound } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { ExecutionCredentialConnectionDialog } from "@/components/execution-credential-connection-dialog";
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
    <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-amber-500/25 bg-amber-500/[0.04] px-3 py-2.5 text-xs">
      <div className="flex min-w-0 items-start gap-2.5">
        <KeyRound className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div>
          <p className="font-medium text-foreground">
            {missing.length === 1
              ? `${missing[0].label} is required`
              : `${missing.length} connections are required`}
          </p>
          <p className="mt-0.5 text-muted-foreground">{helperText}</p>
        </div>
      </div>
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
      {connecting && (
        <ExecutionCredentialConnectionDialog
          definition={connecting}
          scope="personal"
          useExternalSecretsManager={byosEnabled}
          onConnected={onConnected}
          onClose={() => setConnecting(null)}
        />
      )}
    </div>
  );
}

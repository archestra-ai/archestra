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
    <>
      {/* Deliberately slimmer than an <Alert>: this sits directly under the
          composer, where a full padded alert block dwarfs the input row. */}
      <div
        role="alert"
        className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-amber-500/50 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/50 dark:text-amber-200"
      >
        <KeyRound className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="font-medium">
          {missing.length === 1
            ? `${missing[0].label} is required`
            : `${missing.length} connections are required`}
        </span>
        <span className="text-amber-800 dark:text-amber-300">{helperText}</span>
        {definition ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="ml-auto h-6 shrink-0 bg-background px-2 text-xs"
            onClick={() => setConnecting(definition)}
          >
            Connect
          </Button>
        ) : (
          <Button
            asChild
            size="sm"
            variant="outline"
            className="ml-auto h-6 shrink-0 px-2 text-xs"
          >
            <Link
              href={`/agents/${agentId}?tab=overview#background-execution-credentials`}
            >
              Agent details
            </Link>
          </Button>
        )}
      </div>
      {connecting && (
        <ExecutionCredentialConnectionDialog
          definition={connecting}
          scope="personal"
          useExternalSecretsManager={byosEnabled}
          onConnected={onConnected}
          onClose={() => setConnecting(null)}
        />
      )}
    </>
  );
}

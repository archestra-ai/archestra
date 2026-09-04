"use client";

import { KeyRound } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { RuntimeCredentialConnectionDialog } from "@/components/runtime-credential-connection-dialog";
import { Button } from "@/components/ui/button";
import {
  CompactWarning,
  CompactWarningText,
} from "@/components/ui/compact-warning";
import { useFeature } from "@/lib/config/config.query";
import {
  type RuntimeCredentialDefinition,
  useRuntimeCredentials,
} from "@/lib/runtime-credentials.query";

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

export function AgentRuntimeCredentialPrompt({
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
  const definitions = useRuntimeCredentials();
  const byosEnabled = useFeature("byosEnabled");
  const [connecting, setConnecting] =
    useState<RuntimeCredentialDefinition | null>(null);
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
      <CompactWarning className="mt-2">
        <KeyRound />
        <span className="font-medium">
          {missing.length === 1
            ? `${missing[0].label} is required`
            : `${missing.length} connections are required`}
        </span>
        <CompactWarningText>{helperText}</CompactWarningText>
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
            <Link href={`/agents/${agentId}?tab=overview#runtime-credentials`}>
              Agent details
            </Link>
          </Button>
        )}
      </CompactWarning>
      {connecting && (
        <RuntimeCredentialConnectionDialog
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

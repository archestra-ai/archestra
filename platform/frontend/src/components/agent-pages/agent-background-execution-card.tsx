"use client";

import {
  CheckCircle2,
  KeyRound,
  Plug,
  RefreshCw,
  Trash2,
  Unplug,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ExecutionCredentialConnectionDialog } from "@/components/execution-credential-connection-dialog";
import { ExecutionCredentialIcon } from "@/components/execution-credential-icon";
import { ExternalSecretReferenceDialog } from "@/components/external-secret-reference-dialog";
import { WithPermissions } from "@/components/roles/with-permissions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  useAgentBackgroundExecutionPreflight,
  useDeleteAgentBackgroundExecutionCredential,
  useSetAgentBackgroundExecutionCredential,
} from "@/lib/agent-background-execution.query";
import { useFeature } from "@/lib/config/config.query";
import {
  type ExecutionCredentialDefinition,
  useDeleteExecutionCredentialConnection,
  useExecutionCredentials,
} from "@/lib/execution-credentials.query";

type CredentialDeclaration = {
  key: string;
  credentialId?: string;
  label: string;
  description?: string;
  scope: "shared" | "per_user";
  required: boolean;
};

export function AgentBackgroundExecutionCard({
  agentId,
  credentials,
}: {
  agentId: string;
  credentials: CredentialDeclaration[];
}) {
  const { data: preflight, refetch: refetchPreflight } =
    useAgentBackgroundExecutionPreflight(agentId);
  const setCredential = useSetAgentBackgroundExecutionCredential(agentId);
  const deleteCredential = useDeleteAgentBackgroundExecutionCredential(agentId);
  const deleteConnection = useDeleteExecutionCredentialConnection();
  const definitions = useExecutionCredentials();
  const byosEnabled = useFeature("byosEnabled");
  const [values, setValues] = useState<Record<string, string>>({});
  const [vaultCredentialKey, setVaultCredentialKey] = useState<string | null>(
    null,
  );
  const [credentialToDelete, setCredentialToDelete] =
    useState<CredentialDeclaration | null>(null);
  const [connectionDialog, setConnectionDialog] = useState<{
    credential: CredentialDeclaration;
    definition: ExecutionCredentialDefinition;
  } | null>(null);

  if (credentials.length === 0) return null;

  return (
    <section
      id="background-execution-credentials"
      className="scroll-mt-24 rounded-lg border bg-card p-4"
    >
      <div className="mb-4 space-y-1">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4" />
          <h2 className="font-medium">Execution connections</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Connect the credentials this Agent requests before starting a
          background execution.
        </p>
      </div>
      <div className="divide-y rounded-lg border">
        {credentials.map((credential) => {
          const configured = preflight?.configured.includes(credential.key);
          const definition = definitions.data?.find(
            (candidate) => candidate.key === credential.credentialId,
          );
          return (
            <div key={credential.key} className="flex items-center gap-3 p-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-background">
                <ExecutionCredentialIcon icon={definition?.icon ?? null} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <Label
                    htmlFor={`credential-${credential.key}`}
                    className="truncate"
                  >
                    {credential.label}
                  </Label>
                  {configured ? (
                    <span className="flex shrink-0 items-center gap-1 text-xs text-emerald-600">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Configured
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {credential.scope === "shared" ? "Organization" : "Personal"}{" "}
                  connection
                  {credential.credentialId ? (
                    <>
                      {" "}
                      · <code>{credential.credentialId}</code> →{" "}
                      <code>{credential.key}</code>
                    </>
                  ) : (
                    <>
                      {" "}
                      · <code>{credential.key}</code>
                    </>
                  )}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <WithPermissions
                  permissions={
                    definition && credential.scope === "shared"
                      ? { agentSettings: ["update"] }
                      : { agent: ["read"] }
                  }
                  noPermissionHandle="tooltip"
                >
                  {({ hasPermission }) =>
                    definition ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="outline"
                            size="icon-sm"
                            aria-label={
                              configured
                                ? `Replace ${credential.label}`
                                : `Connect ${credential.label}`
                            }
                            disabled={!hasPermission}
                            onClick={() =>
                              setConnectionDialog({ credential, definition })
                            }
                          >
                            {configured ? (
                              <RefreshCw className="size-4" />
                            ) : (
                              <Plug className="size-4" />
                            )}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          {configured ? "Replace" : "Connect"}
                        </TooltipContent>
                      </Tooltip>
                    ) : byosEnabled ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="outline"
                            size="icon-sm"
                            aria-label={
                              configured
                                ? `Replace ${credential.label}`
                                : `Set ${credential.label}`
                            }
                            disabled={!hasPermission || setCredential.isPending}
                            onClick={() =>
                              setVaultCredentialKey(credential.key)
                            }
                          >
                            {configured ? (
                              <RefreshCw className="size-4" />
                            ) : (
                              <Plug className="size-4" />
                            )}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          {configured ? "Replace secret" : "Set secret"}
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      <>
                        <Input
                          id={`credential-${credential.key}`}
                          type="password"
                          autoComplete="off"
                          disabled={!hasPermission}
                          value={values[credential.key] ?? ""}
                          className="h-8 w-56"
                          placeholder={
                            configured ? "Replace stored value" : "Enter value"
                          }
                          onChange={(event) =>
                            setValues((current) => ({
                              ...current,
                              [credential.key]: event.target.value,
                            }))
                          }
                        />
                        <Button
                          type="button"
                          size="sm"
                          disabled={
                            !hasPermission ||
                            !values[credential.key] ||
                            setCredential.isPending
                          }
                          onClick={() =>
                            setCredential.mutate(
                              {
                                key: credential.key,
                                value: values[credential.key],
                              },
                              {
                                onSuccess: () => {
                                  setValues((current) => ({
                                    ...current,
                                    [credential.key]: "",
                                  }));
                                  toast.success(`${credential.label} saved`);
                                },
                              },
                            )
                          }
                        >
                          Save
                        </Button>
                      </>
                    )
                  }
                </WithPermissions>
                {configured && (
                  <WithPermissions
                    permissions={
                      definition && credential.scope === "shared"
                        ? { agentSettings: ["update"] }
                        : { agent: ["read"] }
                    }
                    noPermissionHandle="tooltip"
                  >
                    {({ hasPermission }) => (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="outline"
                            size="icon-sm"
                            aria-label={`Disconnect ${credential.label}`}
                            className="text-destructive hover:text-destructive"
                            disabled={
                              !hasPermission ||
                              deleteCredential.isPending ||
                              deleteConnection.isPending
                            }
                            onClick={() => setCredentialToDelete(credential)}
                          >
                            {credential.credentialId ? (
                              <Unplug className="h-4 w-4" />
                            ) : (
                              <Trash2 className="h-4 w-4" />
                            )}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Disconnect</TooltipContent>
                      </Tooltip>
                    )}
                  </WithPermissions>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {vaultCredentialKey && (
        <ExternalSecretReferenceDialog
          fieldLabel={vaultCredentialKey}
          description="Select the Vault secret injected into this Agent's Background execution deployment."
          onClose={() => setVaultCredentialKey(null)}
          onConfirm={(value) =>
            setCredential.mutate(
              { key: vaultCredentialKey, value },
              {
                onSuccess: () => {
                  toast.success("Credential saved");
                  setVaultCredentialKey(null);
                },
              },
            )
          }
        />
      )}
      {connectionDialog && (
        <ExecutionCredentialConnectionDialog
          definition={connectionDialog.definition}
          scope={
            connectionDialog.credential.scope === "per_user"
              ? "personal"
              : "organization"
          }
          useExternalSecretsManager={byosEnabled}
          onConnected={() => void refetchPreflight()}
          onClose={() => setConnectionDialog(null)}
        />
      )}
      <DeleteConfirmDialog
        open={credentialToDelete !== null}
        onOpenChange={(open) => {
          if (!open) setCredentialToDelete(null);
        }}
        title="Remove execution connection?"
        description={
          credentialToDelete?.credentialId
            ? `${credentialToDelete.label} will stop working for every Agent that uses the “${credentialToDelete.credentialId}” connection.`
            : `The stored value for ${credentialToDelete?.label ?? "this credential"} will be removed from the secret manager.`
        }
        isPending={deleteCredential.isPending || deleteConnection.isPending}
        onConfirm={() => {
          if (!credentialToDelete) return;
          const label = credentialToDelete.label;
          const onSuccess = () => {
            toast.success(`${label} deleted`);
            setCredentialToDelete(null);
            void refetchPreflight();
          };
          if (credentialToDelete.credentialId) {
            deleteConnection.mutate(
              {
                key: credentialToDelete.credentialId,
                scope:
                  credentialToDelete.scope === "per_user"
                    ? "personal"
                    : "organization",
              },
              { onSuccess },
            );
            return;
          }
          deleteCredential.mutate(credentialToDelete.key, { onSuccess });
        }}
      />
    </section>
  );
}

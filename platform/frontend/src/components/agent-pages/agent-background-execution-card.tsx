"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { KeyRound, Plug, RefreshCw, Trash2, Unplug } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ExecutionCredentialConnectionDialog } from "@/components/execution-credential-connection-dialog";
import { ExecutionCredentialIcon } from "@/components/execution-credential-icon";
import { ExternalSecretReferenceDialog } from "@/components/external-secret-reference-dialog";
import { WithPermissions } from "@/components/roles/with-permissions";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { SecretInput } from "@/components/ui/secret-input";
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
  const [manualCredential, setManualCredential] =
    useState<CredentialDeclaration | null>(null);
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
            <div
              key={credential.key}
              className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center"
            >
              <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-background">
                <ExecutionCredentialIcon icon={definition?.icon ?? null} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <h3 className="truncate text-sm font-medium">
                    {credential.label}
                  </h3>
                  {configured ? (
                    <Badge variant="secondary" className="font-normal">
                      Configured
                    </Badge>
                  ) : null}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {credential.description ||
                    `${credential.scope === "shared" ? "Organization" : "Personal"} connection${definition ? ` using ${definition.name}` : ""}`}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
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
                    ) : (
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
                            onClick={() => setManualCredential(credential)}
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
      {manualCredential && (
        <AgentCredentialValueDialog
          credential={manualCredential}
          useExternalSecretsManager={byosEnabled === true}
          isPending={setCredential.isPending}
          onClose={() => setManualCredential(null)}
          onSave={(value) =>
            setCredential.mutate(
              { key: manualCredential.key, value },
              {
                onSuccess: () => {
                  toast.success(`${manualCredential.label} saved`);
                  setManualCredential(null);
                  void refetchPreflight();
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
            ? `${credentialToDelete.label} will stop working for every Agent that uses this ${credentialToDelete.scope === "shared" ? "organization" : "personal"} connection.`
            : `The stored value for ${credentialToDelete?.label ?? "this credential"} will be removed from the secret manager.`
        }
        isPending={deleteCredential.isPending || deleteConnection.isPending}
        onConfirm={() => {
          if (!credentialToDelete) return;
          const label = credentialToDelete.label;
          const finish = () => {
            setCredentialToDelete(null);
            void refetchPreflight();
          };
          if (credentialToDelete.credentialId) {
            deleteConnection.mutate(
              {
                key: credentialToDelete.credentialId,
                name: label,
                scope:
                  credentialToDelete.scope === "per_user"
                    ? "personal"
                    : "organization",
              },
              { onSuccess: finish },
            );
            return;
          }
          deleteCredential.mutate(credentialToDelete.key, {
            onSuccess: () => {
              toast.success(`${label} deleted`);
              finish();
            },
          });
        }}
      />
    </section>
  );
}

function AgentCredentialValueDialog({
  credential,
  useExternalSecretsManager,
  isPending,
  onClose,
  onSave,
}: {
  credential: CredentialDeclaration;
  useExternalSecretsManager: boolean;
  isPending: boolean;
  onClose: () => void;
  onSave: (value: string) => void;
}) {
  const form = useForm<CredentialValueForm>({
    resolver: zodResolver(CredentialValueSchema),
    defaultValues: { value: "" },
  });

  if (useExternalSecretsManager) {
    return (
      <ExternalSecretReferenceDialog
        fieldLabel={credential.label}
        description="Select the Vault secret for this Agent's Background execution."
        onClose={onClose}
        onConfirm={onSave}
      />
    );
  }

  return (
    <StandardFormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Set ${credential.label}`}
      description="The value is stored in the secret manager and injected only when this Agent runs."
      size="small"
      onSubmit={form.handleSubmit(({ value }) => onSave(value))}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={isPending}>
            {isPending ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <Form {...form}>
        <FormField
          control={form.control}
          name="value"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Secret value</FormLabel>
              <FormControl>
                <SecretInput
                  {...field}
                  autoFocus
                  revealable
                  autoComplete="off"
                  placeholder="Paste secret"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </Form>
    </StandardFormDialog>
  );
}

const CredentialValueSchema = z.object({
  value: z.string().trim().min(1, "Secret value is required").max(20_000),
});

type CredentialValueForm = z.infer<typeof CredentialValueSchema>;

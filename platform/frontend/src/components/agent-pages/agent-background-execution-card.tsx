"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  Circle,
  CircleAlert,
  CircleCheck,
  Plug,
  RefreshCw,
  Trash2,
  Unplug,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ExecutionCredentialConnectionDialog } from "@/components/execution-credential-connection-dialog";
import { ExecutionCredentialIcon } from "@/components/execution-credential-icon";
import { ExternalSecretReferenceDialog } from "@/components/external-secret-reference-dialog";
import { StandardFormDialog } from "@/components/standard-dialog";
import { TableRowActions } from "@/components/table-row-actions";
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
  readOnly = false,
  editHref,
}: {
  agentId: string;
  credentials: CredentialDeclaration[];
  readOnly?: boolean;
  editHref?: string;
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
      className="scroll-mt-24 overflow-hidden rounded-lg border bg-card"
    >
      <div className="flex items-start justify-between gap-3 p-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Execution credentials</h2>
          <p className="text-sm text-muted-foreground">
            {readOnly
              ? "Credential requirements and setup status for this agent's background tasks."
              : "Manage the credentials this agent can use during background tasks."}
          </p>
        </div>
        {readOnly && editHref && (
          <Button asChild type="button" variant="outline" size="sm">
            <Link href={editHref}>Edit credentials</Link>
          </Button>
        )}
      </div>
      <div className="divide-y border-t">
        {credentials.map((credential) => {
          const configured = preflight?.configured.includes(credential.key);
          const definition = definitions.data?.find(
            (candidate) => candidate.key === credential.credentialId,
          );
          return (
            <div
              key={credential.key}
              className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center"
            >
              <div className="flex min-w-0 flex-1 items-start gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-background">
                  <ExecutionCredentialIcon icon={definition?.icon ?? null} />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-sm font-medium">
                    {credential.label}
                  </h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {credential.description ||
                      `${credential.scope === "shared" ? "Organization" : "Personal"} connection${definition ? ` using ${definition.name}` : ""}`}
                  </p>
                  <CredentialConnectionStatus
                    configured={configured === true}
                    required={credential.required}
                    scope={credential.scope}
                  />
                </div>
              </div>
              {!readOnly && (
                <div className="shrink-0 self-end sm:self-auto">
                  <TableRowActions
                    itemName={credential.label}
                    actions={[
                      {
                        icon: configured ? (
                          <RefreshCw className="size-4" />
                        ) : (
                          <Plug className="size-4" />
                        ),
                        label: configured
                          ? "Replace"
                          : definition
                            ? "Connect"
                            : "Set secret",
                        permissions:
                          definition && credential.scope === "shared"
                            ? { agentSettings: ["update"] }
                            : { agent: ["read"] },
                        disabled: !definition && setCredential.isPending,
                        disabledTooltip:
                          "A credential update is already in progress.",
                        onClick: () => {
                          if (definition) {
                            setConnectionDialog({ credential, definition });
                          } else {
                            setManualCredential(credential);
                          }
                        },
                      },
                    ]}
                    dropdownActions={
                      configured
                        ? [
                            {
                              icon: credential.credentialId ? (
                                <Unplug className="size-4" />
                              ) : (
                                <Trash2 className="size-4" />
                              ),
                              label: credential.credentialId
                                ? "Disconnect"
                                : "Delete secret",
                              permissions:
                                definition && credential.scope === "shared"
                                  ? { agentSettings: ["update"] }
                                  : { agent: ["read"] },
                              disabled:
                                deleteCredential.isPending ||
                                deleteConnection.isPending,
                              disabledTooltip:
                                "A credential update is already in progress.",
                              variant: "destructive",
                              onClick: () => setCredentialToDelete(credential),
                            },
                          ]
                        : []
                    }
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
      {!readOnly && manualCredential && (
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
      {!readOnly && connectionDialog && (
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
      {!readOnly && (
        <DeleteConfirmDialog
          open={credentialToDelete !== null}
          onOpenChange={(open) => {
            if (!open) setCredentialToDelete(null);
          }}
          title={
            credentialToDelete?.credentialId
              ? "Disconnect credential?"
              : "Delete saved secret?"
          }
          description={
            credentialToDelete?.credentialId
              ? credentialToDelete.scope === "shared"
                ? `This disconnects ${credentialToDelete.label} for the organization. Every Agent that uses it will lose access.`
                : `This disconnects ${credentialToDelete.label} from your account. Every Agent that uses it will lose access.`
              : `The saved value for ${credentialToDelete?.label ?? "this credential"} will be deleted.`
          }
          isPending={deleteCredential.isPending || deleteConnection.isPending}
          confirmLabel={
            credentialToDelete?.credentialId ? "Disconnect" : "Delete"
          }
          pendingLabel={
            credentialToDelete?.credentialId
              ? "Disconnecting..."
              : "Deleting..."
          }
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
      )}
    </section>
  );
}

function CredentialConnectionStatus({
  configured,
  required,
  scope,
}: {
  configured: boolean;
  required: boolean;
  scope: CredentialDeclaration["scope"];
}) {
  if (configured) {
    return (
      <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <CircleCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" />
        <span>
          {scope === "shared"
            ? "Connected for the organization"
            : "Connected for you"}
        </span>
      </p>
    );
  }

  if (required) {
    return (
      <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <CircleAlert className="size-3.5 text-amber-600 dark:text-amber-400" />
        <span>Required before background tasks can start</span>
      </p>
    );
  }

  return (
    <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
      <Circle className="size-3.5" />
      <span>Optional connection not set</span>
    </p>
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

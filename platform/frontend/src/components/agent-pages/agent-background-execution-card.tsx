"use client";

import { CheckCircle2, KeyRound, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ExternalSecretReferenceDialog } from "@/components/external-secret-reference-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useAgentBackgroundExecutionPreflight,
  useDeleteAgentBackgroundExecutionCredential,
  useSetAgentBackgroundExecutionCredential,
} from "@/lib/agent-background-execution.query";
import { useFeature } from "@/lib/config/config.query";

type CredentialDeclaration = {
  key: string;
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
  const { data: preflight } = useAgentBackgroundExecutionPreflight(agentId);
  const setCredential = useSetAgentBackgroundExecutionCredential(agentId);
  const deleteCredential = useDeleteAgentBackgroundExecutionCredential(agentId);
  const byosEnabled = useFeature("byosEnabled");
  const [values, setValues] = useState<Record<string, string>>({});
  const [vaultCredentialKey, setVaultCredentialKey] = useState<string | null>(
    null,
  );
  const [credentialToDelete, setCredentialToDelete] =
    useState<CredentialDeclaration | null>(null);

  if (credentials.length === 0) return null;

  return (
    <section
      id="background-execution-credentials"
      className="scroll-mt-24 rounded-lg border bg-card p-4"
    >
      <div className="mb-4 space-y-1">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4" />
          <h2 className="font-medium">Background execution credentials</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Values are stored in the configured secret manager and injected only
          into this Agent&apos;s background runs.
        </p>
      </div>
      <div className="space-y-4">
        {credentials.map((credential) => {
          const configured = preflight?.configured.includes(credential.key);
          return (
            <div
              key={credential.key}
              className="space-y-2 rounded-md border p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <Label htmlFor={`credential-${credential.key}`}>
                    {credential.label}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {credential.description || credential.key} ·{" "}
                    {credential.scope === "shared" ? "Shared" : "Personal"}
                  </p>
                </div>
                {configured && (
                  <span className="flex items-center gap-1 text-xs text-emerald-600">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Configured
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                {byosEnabled ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={setCredential.isPending}
                    onClick={() => setVaultCredentialKey(credential.key)}
                  >
                    {configured ? "Replace secret" : "Set secret"}
                  </Button>
                ) : (
                  <>
                    <Input
                      id={`credential-${credential.key}`}
                      type="password"
                      autoComplete="off"
                      value={values[credential.key] ?? ""}
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
                      disabled={
                        !values[credential.key] || setCredential.isPending
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
                )}
                {configured && (
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label={`Delete ${credential.label}`}
                    disabled={deleteCredential.isPending}
                    onClick={() => setCredentialToDelete(credential)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
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
      <DeleteConfirmDialog
        open={credentialToDelete !== null}
        onOpenChange={(open) => {
          if (!open) setCredentialToDelete(null);
        }}
        title="Delete background credential?"
        description={`The stored value for ${credentialToDelete?.label ?? "this credential"} will be removed from the secret manager.`}
        isPending={deleteCredential.isPending}
        onConfirm={() => {
          if (!credentialToDelete) return;
          const label = credentialToDelete.label;
          deleteCredential.mutate(credentialToDelete.key, {
            onSuccess: () => {
              toast.success(`${label} deleted`);
              setCredentialToDelete(null);
            },
          });
        }}
      />
    </section>
  );
}

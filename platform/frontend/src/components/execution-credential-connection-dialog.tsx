"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { ExecutionCredentialIcon } from "@/components/execution-credential-icon";
import { ExecutionCredentialDescription } from "@/components/execution-credential-row-content";
import { ExternalSecretReferenceDialog } from "@/components/external-secret-reference-dialog";
import { StandardFormDialog } from "@/components/standard-dialog";
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
  const connect = useSetExecutionCredentialConnection();
  const form = useForm<ConnectionFormValues>({
    resolver: zodResolver(ConnectionFormSchema),
    defaultValues: { value: "" },
  });

  const save = (nextValue: string) => {
    connect.mutate(
      {
        key: definition.key,
        name: definition.name,
        scope,
        value: nextValue,
      },
      {
        onSuccess: () => {
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
      onSubmit={form.handleSubmit(({ value }) => save(value))}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={connect.isPending}>
            {connect.isPending ? "Connecting…" : "Connect"}
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
              <ExecutionCredentialDescription
                definition={definition}
                className=""
              />
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

const ConnectionFormSchema = z.object({
  value: z.string().trim().min(1, "Secret value is required").max(20_000),
});

type ConnectionFormValues = z.infer<typeof ConnectionFormSchema>;

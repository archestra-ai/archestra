"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { ConnectionSignInDialog } from "@/components/connection-sign-in-dialog";
import { ExternalSecretReferenceDialog } from "@/components/external-secret-reference-dialog";
import { GitHubConnectButton } from "@/components/github-connect-button";
import { RuntimeCredentialIcon } from "@/components/runtime-credential-icon";
import { RuntimeCredentialDescription } from "@/components/runtime-credential-row-content";
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
import { SecretInput, SecretTextarea } from "@/components/ui/secret-input";
import {
  type RuntimeCredentialDefinition,
  useSetRuntimeCredentialConnection,
  useStartGitHubUserConnection,
} from "@/lib/runtime-credentials.query";

export function RuntimeCredentialConnectionDialog({
  definition,
  scope,
  useExternalSecretsManager = false,
  onClose,
  onConnected,
}: {
  definition: RuntimeCredentialDefinition;
  scope: "personal" | "organization";
  useExternalSecretsManager?: boolean;
  onClose: () => void;
  onConnected?: () => void;
}) {
  const connect = useSetRuntimeCredentialConnection();
  const startGitHub = useStartGitHubUserConnection();
  const form = useForm<ConnectionFormValues>({
    resolver: zodResolver(ConnectionFormSchema),
    defaultValues: { value: "", clientSecret: "" },
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

  if (definition.kind === "github_app_user")
    return (
      <ConnectionSignInDialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title="Connect GitHub"
        description={
          <span className="whitespace-pre-wrap break-words">
            {definition.description?.trim() ||
              "Connect your GitHub account to use it with your agents."}
          </span>
        }
        action={
          <GitHubConnectButton
            pending={startGitHub.isPending}
            onClick={() => startGitHub.mutate(definition.key)}
          />
        }
      />
    );

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
          <RuntimeCredentialIcon icon={definition.icon} />
          Connect {definition.name}
        </span>
      }
      description={
        scope === "personal"
          ? "This value is private to you. Your agents and personal MCP connections reuse it."
          : "This value is shared by resources using this organization credential."
      }
      onSubmit={form.handleSubmit(({ value, clientSecret }) => {
        if (definition.kind === "github_app" && definition.githubClientId) {
          if (!clientSecret.trim()) {
            form.setError("clientSecret", {
              message: "OAuth client secret is required",
            });
            return;
          }
          save(JSON.stringify({ privateKey: value, clientSecret }));
        } else save(value);
      })}
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
              <FormLabel>
                {definition.kind === "github_app"
                  ? "Private key (PEM)"
                  : "Secret value"}
              </FormLabel>
              <RuntimeCredentialDescription
                definition={definition}
                className=""
              />
              <FormControl>
                {definition.kind === "github_app" ? (
                  <SecretTextarea
                    {...field}
                    autoComplete="off"
                    placeholder="Paste private key"
                  />
                ) : (
                  <SecretInput
                    {...field}
                    autoFocus
                    revealable
                    autoComplete="off"
                    placeholder="Paste secret"
                  />
                )}
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        {definition.kind === "github_app" && definition.githubClientId && (
          <FormField
            control={form.control}
            name="clientSecret"
            render={({ field }) => (
              <FormItem>
                <FormLabel>OAuth client secret</FormLabel>
                <FormControl>
                  <SecretInput {...field} autoComplete="off" revealable />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        )}
      </Form>
    </StandardFormDialog>
  );
}

const ConnectionFormSchema = z.object({
  clientSecret: z.string(),
  value: z.string().trim().min(1, "Secret value is required").max(20_000),
});

type ConnectionFormValues = z.infer<typeof ConnectionFormSchema>;

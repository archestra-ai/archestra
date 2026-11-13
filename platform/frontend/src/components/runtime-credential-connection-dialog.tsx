"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { ConnectionSignInDialog } from "@/components/connection-sign-in-dialog";
import { ExternalSecretReferenceDialog } from "@/components/external-secret-reference-dialog";
import { PrivateKeyDrop } from "@/components/github-app-setup/private-key-drop";
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
import { SecretInput } from "@/components/ui/secret-input";
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
  silent = false,
  create,
}: {
  definition: Pick<
    RuntimeCredentialDefinition,
    "key" | "name" | "kind" | "icon" | "description" | "githubClientId"
  >;
  scope: "personal" | "organization";
  useExternalSecretsManager?: boolean;
  onClose: () => void;
  onConnected?: () => void;
  /** Skips the "connected" toast, for a caller that shows the result itself. */
  silent?: boolean;
  /**
   * Makes the credential when the value is submitted, for a definition that
   * does not exist yet, so a dialog closed without a value leaves nothing.
   */
  create?: () => Promise<unknown>;
}) {
  const connect = useSetRuntimeCredentialConnection({ silent });
  const [creating, setCreating] = useState(false);
  const startGitHub = useStartGitHubUserConnection();
  const form = useForm<ConnectionFormValues>({
    resolver: zodResolver(connectionFormSchema(definition.kind)),
    defaultValues: { value: "", clientSecret: "" },
  });

  const save = async (nextValue: string) => {
    if (create) {
      setCreating(true);
      try {
        await create();
      } catch {
        // The create mutation already reported the error.
        return;
      } finally {
        setCreating(false);
      }
    }
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
      size={definition.kind === "github_app" ? "medium" : "small"}
      bodyClassName="space-y-4"
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
          void save(JSON.stringify({ privateKey: value, clientSecret }));
        } else void save(value);
      })}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={creating || connect.isPending}>
            {creating || connect.isPending ? "Connecting…" : "Connect"}
          </Button>
        </>
      }
    >
      <Form {...form}>
        <FormField
          control={form.control}
          name="value"
          render={({ field }) =>
            definition.kind === "github_app" ? (
              <FormItem>
                <PrivateKeyDrop
                  id={PRIVATE_KEY_INPUT_ID}
                  describedBy={PRIVATE_KEY_HINT_ID}
                  onKey={(key) => {
                    if (!isPemPrivateKey(key)) {
                      // Without validating, so the resolver's "required"
                      // message does not replace this one.
                      form.setValue("value", "");
                      form.setError("value", {
                        message: "That file is not a PEM private key",
                      });
                      return;
                    }
                    field.onChange(key);
                    form.clearErrors("value");
                  }}
                />
                <p
                  id={PRIVATE_KEY_HINT_ID}
                  className="text-sm text-muted-foreground"
                >
                  The .pem file downloaded from your GitHub App settings.
                </p>
                <FormMessage />
              </FormItem>
            ) : (
              <FormItem>
                <FormLabel>Secret value</FormLabel>
                <RuntimeCredentialDescription
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
            )
          }
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

function connectionFormSchema(kind: RuntimeCredentialDefinition["kind"]) {
  return z.object({
    clientSecret: z.string(),
    value: z
      .string()
      .trim()
      .min(
        1,
        kind === "github_app"
          ? "Choose the private key file"
          : "Secret value is required",
      )
      .max(20_000),
  });
}

type ConnectionFormValues = z.infer<ReturnType<typeof connectionFormSchema>>;

/** GitHub issues PKCS#1 (`RSA PRIVATE KEY`); PKCS#8 also signs App JWTs. */
function isPemPrivateKey(text: string): boolean {
  return /-----BEGIN (RSA )?PRIVATE KEY-----/.test(text);
}

const PRIVATE_KEY_INPUT_ID = "runtime-credential-private-key";
const PRIVATE_KEY_HINT_ID = "runtime-credential-private-key-hint";

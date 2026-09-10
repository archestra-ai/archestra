"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import type { AgentRuntimeConfig } from "@/components/agent-runtime-fields";
import { ExternalSecretReferenceDialog } from "@/components/external-secret-reference-dialog";
import { QueryLoadError } from "@/components/query-load-error";
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
  useAgentRuntimePreflight,
  useSetMissingAgentRuntimeCredentials,
} from "@/lib/agent-runtime.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useConfig } from "@/lib/config/config.query";
import { useRuntimeCredentials } from "@/lib/runtime-credentials.query";

/** Accept both new setup links and credential anchors already sent to users. */
export function AgentRuntimeCredentialsDeepLink(props: {
  agentId: string;
  declarations: NonNullable<AgentRuntimeConfig["credentials"]>;
  canEditAgent: boolean;
}) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const [legacyLink, setLegacyLink] = useState(false);
  useEffect(() => {
    const readHash = () =>
      setLegacyLink(window.location.hash === "#runtime-credentials");
    readHash();
    window.addEventListener("hashchange", readHash);
    return () => window.removeEventListener("hashchange", readHash);
  }, []);

  if (searchParams.get("setup") !== "credentials" && !legacyLink) return null;

  return (
    <MissingCredentialsDialog
      {...props}
      onClose={() => {
        setLegacyLink(false);
        const params = new URLSearchParams(searchParams.toString());
        params.delete("setup");
        params.delete("tab");
        const query = params.toString();
        router.replace(`${pathname}${query ? `?${query}` : ""}`, {
          scroll: false,
        });
      }}
    />
  );
}

function MissingCredentialsDialog({
  agentId,
  declarations,
  canEditAgent,
  onClose,
}: {
  agentId: string;
  declarations: NonNullable<AgentRuntimeConfig["credentials"]>;
  canEditAgent: boolean;
  onClose: () => void;
}) {
  const preflight = useAgentRuntimePreflight(agentId);
  const definitions = useRuntimeCredentials();
  const { data: canManageOrganization, isPending: permissionsPending } =
    useHasPermissions({ agentSettings: ["update"] });
  const config = useConfig();
  const byosEnabled = config.data?.features.byosEnabled;
  const save = useSetMissingAgentRuntimeCredentials(agentId);
  const form = useForm<{ values: Record<string, string> }>({
    defaultValues: { values: {} },
  });
  const [externalKey, setExternalKey] = useState<string | null>(null);
  const [failedKeys, setFailedKeys] = useState<string[]>([]);
  const missingKeys = new Set(
    [
      ...(preflight.data?.missing ?? []),
      ...(preflight.data?.misconfigured ?? []),
    ].map(({ key }) => key),
  );
  const missing = declarations.filter((credential) =>
    missingKeys.has(credential.key),
  );
  const canSet = (credential: (typeof declarations)[number]) =>
    credential.scope === "per_user" ||
    (credential.credentialId ? canManageOrganization : canEditAgent);
  const editable = missing.filter(canSet);
  const loading =
    preflight.isPending ||
    definitions.isPending ||
    config.isPending ||
    permissionsPending;
  const loadFailed = preflight.isError || definitions.isError || config.isError;
  const complete = !loading && !loadFailed && missing.length === 0;

  return (
    <StandardFormDialog
      open
      title="Set up runtime credentials"
      description="Add the missing credentials for this Agent. Personal credentials belong to your account."
      size="medium"
      isDirty={form.formState.isDirty}
      onOpenChange={(open) => {
        if (!open && !save.isPending) onClose();
      }}
      onSubmit={form.handleSubmit(({ values }) => {
        save.mutate(
          editable.map(({ key }) => ({ key, value: values[key].trim() })),
          {
            onSuccess: ({ saved, failed }) => {
              setFailedKeys(failed);
              for (const key of saved)
                form.resetField(`values.${key}`, { defaultValue: "" });
            },
          },
        );
      })}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            disabled={save.isPending}
            onClick={onClose}
          >
            {complete ? "Done" : "Cancel"}
          </Button>
          {!complete && (
            <Button
              type="submit"
              disabled={
                loading || loadFailed || save.isPending || editable.length === 0
              }
            >
              {save.isPending ? "Saving…" : "Save credentials"}
            </Button>
          )}
        </>
      }
    >
      {loading ? (
        <output>Checking missing credentials…</output>
      ) : loadFailed ? (
        <QueryLoadError
          title="Could not load runtime credentials"
          onRetry={() => {
            void preflight.refetch();
            void definitions.refetch();
            void config.refetch();
          }}
        />
      ) : complete ? (
        <output>
          All required credentials are configured. Return to your conversation
          and retry the request.
        </output>
      ) : (
        <Form {...form}>
          <div className="space-y-6">
            {missing.map((credential) => {
              const definition = definitions.data?.find(
                ({ key }) => key === credential.credentialId,
              );
              return (
                <FormField
                  key={credential.key}
                  control={form.control}
                  name={`values.${credential.key}`}
                  defaultValue=""
                  rules={{
                    validate: (value) =>
                      !canSet(credential) ||
                      !!value?.trim() ||
                      "Secret value is required",
                    maxLength: {
                      value: 20_000,
                      message: "Secret value is too long",
                    },
                  }}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{credential.label}</FormLabel>
                      <p className="text-xs text-muted-foreground">
                        {credential.key} ·{" "}
                        {credential.scope === "per_user"
                          ? "Personal"
                          : "Organization"}
                      </p>
                      {[
                        ...new Set([
                          credential.description?.trim(),
                          definition?.description.trim(),
                        ]),
                      ]
                        .filter(Boolean)
                        .map((description) => (
                          <p
                            key={description}
                            className="whitespace-pre-wrap break-words text-sm text-muted-foreground"
                          >
                            {description}
                          </p>
                        ))}
                      {!canSet(credential) ? (
                        <p className="text-sm text-muted-foreground">
                          An administrator must configure this organization
                          credential.
                        </p>
                      ) : byosEnabled ? (
                        <FormControl>
                          <Button
                            type="button"
                            variant="outline"
                            disabled={save.isPending}
                            onClick={() => setExternalKey(credential.key)}
                          >
                            {field.value
                              ? "Change Vault secret"
                              : "Select Vault secret"}
                          </Button>
                        </FormControl>
                      ) : (
                        <FormControl>
                          <SecretInput
                            {...field}
                            disabled={save.isPending}
                            autoFocus={credential.key === editable[0]?.key}
                            autoComplete="off"
                            revealable
                            placeholder="Paste secret"
                          />
                        </FormControl>
                      )}
                      <FormMessage />
                      {failedKeys.includes(credential.key) && (
                        <p role="alert" className="text-sm text-destructive">
                          Could not save this credential. Try again.
                        </p>
                      )}
                    </FormItem>
                  )}
                />
              );
            })}
          </div>
        </Form>
      )}
      {preflight.data?.incompatible && (
        <p role="alert" className="mt-4 text-sm text-muted-foreground">
          {preflight.data.incompatible}
        </p>
      )}
      {externalKey && (
        <ExternalSecretReferenceDialog
          fieldLabel={
            declarations.find(({ key }) => key === externalKey)?.label ??
            externalKey
          }
          initialValue={form.getValues(`values.${externalKey}`)}
          onClose={() => setExternalKey(null)}
          onConfirm={(reference) => {
            form.setValue(`values.${externalKey}`, reference, {
              shouldDirty: true,
              shouldValidate: true,
            });
            setExternalKey(null);
          }}
        />
      )}
    </StandardFormDialog>
  );
}

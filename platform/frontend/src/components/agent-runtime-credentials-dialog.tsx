"use client";

import { Check, CircleCheck, Info, Lock } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import type { AgentRuntimeConfig } from "@/components/agent-runtime-fields";
import { ClaudeCodeAccount } from "@/components/claude-code-account";
import { ExternalSecretReferenceDialog } from "@/components/external-secret-reference-dialog";

import { GitHubConnectButton } from "@/components/github-connect-button";
import { QueryLoadError } from "@/components/query-load-error";
import { RuntimeCredentialConnectionDialog } from "@/components/runtime-credential-connection-dialog";
import { RuntimeCredentialIcon } from "@/components/runtime-credential-icon";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { FieldDescription } from "@/components/ui/field-description";
import {
  Form,
  FormControl,
  FormDescription,
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
import { UnstyledButton } from "@/components/ui/unstyled-button";
import {
  useAgentRuntimePreflight,
  useSetMissingAgentRuntimeCredentials,
} from "@/lib/agent-runtime.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useConfig } from "@/lib/config/config.query";
import {
  type RuntimeCredentialDefinition,
  useRuntimeCredentials,
} from "@/lib/runtime-credentials.query";
import { cn } from "@/lib/utils/tailwind";

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
    <AgentRuntimeCredentialsDialog
      {...props}
      githubConnected={searchParams.get("github") === "connected"}
      requestedKeys={(searchParams.get("keys") ?? "")
        .split(",")
        .map((key) => key.trim())
        .filter(Boolean)}
      onClose={() => {
        setLegacyLink(false);
        const params = new URLSearchParams(searchParams.toString());
        params.delete("setup");
        params.delete("github");
        params.delete("tab");
        params.delete("keys");
        const query = params.toString();
        router.replace(`${pathname}${query ? `?${query}` : ""}`, {
          scroll: false,
        });
      }}
    />
  );
}

export function AgentRuntimeCredentialsDialog({
  agentId,
  declarations,
  canEditAgent,
  githubConnected = false,
  requestedKeys = [],
  onlyKeys,
  onClose,
}: {
  agentId: string;
  declarations: NonNullable<AgentRuntimeConfig["credentials"]>;
  canEditAgent: boolean;
  githubConnected?: boolean;
  /**
   * Keys the link asked for by name, shown even when preflight calls them
   * optional. `transfer_credential` declares a credential as `required: false`
   * so it never blocks anyone's run, and preflight only reports a required key
   * as missing — without this the dialog would open on an empty list.
   */
  requestedKeys?: string[];
  /**
   * Ask for these credentials alone, for a page that offers Set up per
   * credential. Without it the dialog gathers everything still missing.
   */
  onlyKeys?: string[];
  onClose: () => void;
}) {
  const preflight = useAgentRuntimePreflight(agentId);
  const definitions = useRuntimeCredentials();
  const [connecting, setConnecting] =
    useState<RuntimeCredentialDefinition | null>(null);
  const { data: canManageOrganization, isPending: permissionsPending } =
    useHasPermissions({ organizationSettings: ["update"] });
  const config = useConfig();
  const byosEnabled = config.data?.features.byosEnabled;
  const save = useSetMissingAgentRuntimeCredentials(agentId);
  const form = useForm<{ values: Record<string, string> }>({
    defaultValues: { values: {} },
  });
  const [externalKey, setExternalKey] = useState<string | null>(null);
  const [failedKeys, setFailedKeys] = useState<string[]>([]);
  const configuredKeys = new Set(preflight.data?.configured ?? []);
  const missingKeys = new Set(
    [
      ...(preflight.data?.missing ?? []),
      ...(preflight.data?.misconfigured ?? []),
    ].map(({ key }) => key),
  );
  // A requested key still has to be declared on this Agent, so a hand-edited
  // URL cannot conjure a field. One already filled in stays out: the person
  // followed the link to supply what is empty, not to overwrite what is set.
  for (const key of requestedKeys) {
    if (!configuredKeys.has(key)) missingKeys.add(key);
  }
  if (onlyKeys) {
    for (const key of missingKeys) {
      if (!onlyKeys.includes(key)) missingKeys.delete(key);
    }
  }
  const missing = declarations.filter((credential) =>
    missingKeys.has(credential.key),
  );
  // A saved credential the caller may not use cannot take their value: an
  // admin has to share it first, so it gets no field.
  const noAccessKeys = new Set(
    (preflight.data?.missing ?? [])
      .filter((entry) => entry.canConnect === false)
      .map(({ key }) => key),
  );
  const canSet = (credential: (typeof declarations)[number]) =>
    !noAccessKeys.has(credential.key) &&
    (credential.scope === "per_user" ||
      (credential.credentialId ? canManageOrganization : canEditAgent));
  const isGitHubUserConnection = (credential: (typeof declarations)[number]) =>
    definitions.data?.some(
      (definition) =>
        definition.key === credential.credentialId &&
        definition.kind === "github_app_user",
    );
  const editable = missing.filter(
    (credential) => canSet(credential) && !isGitHubUserConnection(credential),
  );
  const loading =
    preflight.isPending ||
    definitions.isPending ||
    config.isPending ||
    permissionsPending;
  const loadFailed = preflight.isError || definitions.isError || config.isError;
  const needsClaudeCodeAccount = missingKeys.has("CLAUDE_CODE_ACCOUNT");
  const complete =
    !loading && !loadFailed && missing.length === 0 && !needsClaudeCodeAccount;

  // One credential asked for by name: the dialog is about it, so its name is
  // the title and its field needs no second label.
  const single =
    onlyKeys?.length === 1 &&
    missing.length === 1 &&
    editable[0]?.key === missing[0].key
      ? missing[0]
      : undefined;

  const singleGitHubConnection =
    !loading &&
    !loadFailed &&
    !needsClaudeCodeAccount &&
    missing.length === 1 &&
    canSet(missing[0])
      ? definitions.data?.find(
          (definition) =>
            definition.key === missing[0].credentialId &&
            definition.kind === "github_app_user",
        )
      : undefined;
  const connectionDefinition = connecting ?? singleGitHubConnection;
  if (connectionDefinition) {
    return (
      <RuntimeCredentialConnectionDialog
        definition={connectionDefinition}
        scope="personal"
        onClose={connecting ? () => setConnecting(null) : onClose}
      />
    );
  }

  const descriptionOf = (credential: (typeof declarations)[number]) => {
    const definition = definitions.data?.find(
      ({ key }) => key === credential.credentialId,
    );
    return (
      (definition ? definition.description : credential.description)?.trim() ||
      undefined
    );
  };
  const signIns = missing.flatMap((credential) => {
    if (!canSet(credential)) return [];
    const definition = definitions.data?.find(
      (entry) =>
        entry.key === credential.credentialId &&
        entry.kind === "github_app_user",
    );
    return definition ? [{ credential, definition }] : [];
  });
  const unavailable = missing.filter((credential) => !canSet(credential));
  const values = form.watch("values");
  const filledCount = editable.filter(({ key }) =>
    values?.[key]?.trim(),
  ).length;
  const renderSecretField = (credential: (typeof declarations)[number]) => {
    const description = descriptionOf(credential);
    return (
      <FormField
        key={credential.key}
        control={form.control}
        name={`values.${credential.key}`}
        defaultValue=""
        rules={{
          validate: (value) => !!value?.trim() || "Secret value is required",
          maxLength: { value: 20_000, message: "Secret value is too long" },
        }}
        render={({ field }) => (
          <FormItem className={cn(!single && "content-start gap-1.5")}>
            {single ? (
              <>
                <FormLabel className="sr-only">{credential.label}</FormLabel>
                {description && (
                  <FormDescription className="whitespace-pre-wrap break-words">
                    {description}
                  </FormDescription>
                )}
              </>
            ) : (
              <div className="flex min-w-0 items-center gap-1.5">
                <FormLabel className="truncate text-xs">
                  {credential.label}
                </FormLabel>
                {description && (
                  <DescriptionHint
                    label={credential.label}
                    description={description}
                  />
                )}
                {field.value?.trim() && (
                  <Check
                    aria-hidden
                    className="ml-auto size-3.5 shrink-0 text-green-600 dark:text-green-400"
                  />
                )}
              </div>
            )}
            <FormControl>
              {byosEnabled ? (
                <Button
                  type="button"
                  variant="outline"
                  className={cn(!single && "h-8")}
                  disabled={save.isPending}
                  onClick={() => setExternalKey(credential.key)}
                >
                  {field.value ? "Change Vault secret" : "Select Vault secret"}
                </Button>
              ) : (
                <SecretInput
                  {...field}
                  className={cn(!single && "h-8")}
                  disabled={save.isPending}
                  autoFocus={credential.key === editable[0]?.key}
                  autoComplete="off"
                  revealable
                  placeholder="Paste secret"
                />
              )}
            </FormControl>
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
  };

  return (
    <StandardFormDialog
      open
      title={single ? `Set up ${single.label}` : "Set up runtime credentials"}
      description={
        single
          ? single.scope === "per_user"
            ? "This Agent needs it to run. It belongs to your account."
            : "This Agent needs it to run."
          : "Add the missing credentials for this Agent. Personal credentials belong to your account."
      }
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
          {!complete && editable.length > 0 && (
            <Button
              type="submit"
              disabled={
                loading || loadFailed || save.isPending || editable.length === 0
              }
            >
              {save.isPending
                ? "Saving…"
                : single
                  ? "Save"
                  : "Save credentials"}
            </Button>
          )}
        </>
      }
    >
      {githubConnected && (
        <output className="mb-5 flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
          <CircleCheck
            className="size-4 shrink-0 text-green-600 dark:text-green-400"
            aria-hidden="true"
          />
          <span>GitHub connected</span>
        </output>
      )}
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
          {single ? (
            renderSecretField(single)
          ) : (
            // Grouped by what the person does: sign in, paste a secret, or
            // nothing, because someone else has to provide it.
            <div className="grid gap-6">
              {(needsClaudeCodeAccount || signIns.length > 0) && (
                <CredentialGroup heading="Sign in">
                  {needsClaudeCodeAccount && (
                    <div className="rounded-md border bg-muted/30 p-3 dark:bg-muted/15">
                      <ClaudeCodeAccount agentId={agentId} variant="inline" />
                    </div>
                  )}
                  {signIns.map(({ credential, definition }) => (
                    <div
                      key={credential.key}
                      className="flex flex-wrap items-center gap-2.5 rounded-md border bg-muted/30 p-3 dark:bg-muted/15"
                    >
                      <RuntimeCredentialIcon
                        icon={definition.icon ?? "logo:github"}
                        className="size-4 shrink-0"
                        size={16}
                      />
                      <span className="text-sm font-medium">
                        {credential.label}
                      </span>
                      <DescriptionHint
                        label={credential.label}
                        description={definition.description}
                      />
                      <GitHubConnectButton
                        className="ml-auto"
                        disabled={save.isPending}
                        onClick={() => setConnecting(definition)}
                      />
                    </div>
                  ))}
                </CredentialGroup>
              )}
              {editable.length > 0 && (
                <CredentialGroup
                  heading="Paste secrets"
                  meta={
                    editable.length > 1
                      ? `${filledCount} of ${editable.length} filled`
                      : undefined
                  }
                >
                  <div
                    className={cn(
                      "grid gap-x-4 gap-y-3",
                      editable.length > 1 && "sm:grid-cols-2",
                    )}
                  >
                    {editable.map((credential) =>
                      renderSecretField(credential),
                    )}
                  </div>
                </CredentialGroup>
              )}
              {unavailable.length > 0 && (
                <CredentialGroup heading="Not available to you">
                  <ul className="grid gap-2">
                    {unavailable.map((credential) => (
                      <li key={credential.key} className="grid gap-0.5">
                        <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                          <Lock className="size-3.5 shrink-0" aria-hidden />
                          <span>{credential.label}</span>
                        </span>
                        <FieldDescription className="pl-5">
                          {noAccessKeys.has(credential.key)
                            ? "You don't have access to it. Ask an admin to share it with you."
                            : "An administrator must configure this organization credential."}
                        </FieldDescription>
                      </li>
                    ))}
                  </ul>
                </CredentialGroup>
              )}
            </div>
          )}
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

// ===

function CredentialGroup({
  heading,
  meta,
  children,
}: {
  heading: string;
  meta?: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={heading} className="grid gap-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
          {heading}
        </h3>
        {meta && (
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {meta}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

function DescriptionHint({
  label,
  description,
}: {
  label: string;
  description: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton
          aria-label={`About ${label}`}
          className="shrink-0 rounded-sm text-muted-foreground/70 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <Info className="size-3.5" />
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 whitespace-pre-wrap">
        {description}
      </TooltipContent>
    </Tooltip>
  );
}

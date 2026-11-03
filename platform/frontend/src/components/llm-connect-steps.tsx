"use client";

import {
  type archestraApiTypes,
  isModelRouterSupportedProvider,
  LLM_PROXY_OAUTH_SCOPE,
  type SupportedProvider,
  VIRTUAL_KEY_HEADER,
} from "@archestra/shared";
import { Check, Eye, EyeOff, Loader2 } from "lucide-react";
import Link from "next/link";
import { Fragment, type ReactNode, useId, useState } from "react";
import type { ProxyEndpointProvider } from "@/app/connection/connection-flow.utils";
import {
  ConnectStep,
  type ConnectStepProps,
  CreateNewLink,
  CredentialSelect,
  OauthTokenRequest,
} from "@/components/connect-rail";
import { CreateLlmProviderApiKeyDialog } from "@/components/create-llm-provider-api-key-dialog";
import { CreateManagedOAuthClientDialog } from "@/components/create-managed-oauth-client-dialog";
import {
  type CreatedVirtualKey,
  CreateVirtualKeyDialogWithData,
  type VirtualKeyType,
} from "@/components/create-virtual-key-dialog";
import { primaryKeyMappings } from "@/components/credential-billing/provider-key-data";
import {
  type CreatedCredentials,
  OAuthClientCreatedDialog,
} from "@/components/oauth-client-created-dialog";
import { ProviderIcon } from "@/components/provider-icon";
import type { ProviderApiKeyMappings } from "@/components/provider-key-mappings-field";
import { SecretCopyButton } from "@/components/secret-copy-button";
import {
  TerminalCard,
  terminalActionClass,
  terminalCodeClass,
} from "@/components/terminal-surface";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import {
  RequestExample,
  type RevealableSecret,
} from "@/components/virtual-key-connection-guide";
import type {
  RequestCredential,
  RequestTarget,
} from "@/components/virtual-key-request-example";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useIdentityProviders } from "@/lib/auth/identity-provider-read.query";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import { useLlmOauthClients } from "@/lib/llm-oauth-clients.query";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { useLlmProxy, useUpdateLlmProxy } from "@/lib/llm-proxy.query";
import {
  useCreateOauthClient,
  useOauthClients,
} from "@/lib/oauth-clients.query";
import { useOrganization } from "@/lib/organization.query";
import { cn } from "@/lib/utils/tailwind";
import {
  useAllVirtualApiKeys,
  useFetchVirtualApiKeyValue,
} from "@/lib/virtual-api-keys.query";

type LlmOauthClient =
  archestraApiTypes.GetLlmOauthClientsResponses["200"]["data"][number];

/** How callers authenticate to the LLM Proxy. */
export type LlmAuthMethod = "standard" | "passthrough" | "oauth" | "idp";

/**
 * What the steps need of a model pool to connect to it: a listed pool and one
 * just created both have it.
 */
export type ConnectablePoolDetails = {
  id: string;
  name: string;
  members: Array<{ provider: SupportedProvider; providerApiKeyId: string }>;
  /** Virtual keys that may call the pool by its name. */
  virtualApiKeyIds: string[];
};

/**
 * The steps for one endpoint and auth method, each showing what exists:
 * the provider keys behind the endpoint, the credential to connect with
 * (create one, or pick an existing one), and the request to send. The LLM
 * Proxy page and a model pool's Connect dialog both render it.
 */
export function LlmConnectSteps({
  firstNumber,
  baseUrl,
  selected,
  auth,
  targetLabel,
  pool,
  usableProviderKeyIds,
}: {
  /** The rail's number for the first of these steps. */
  firstNumber: number;
  baseUrl: string;
  selected: "model-router" | ProxyEndpointProvider;
  auth: LlmAuthMethod;
  targetLabel: string;
  /**
   * Connecting to a model pool: only credentials that may call it are
   * offered, a new one starts mapped to the members' keys, and the request
   * asks for the pool by name.
   */
  pool?: ConnectablePoolDetails;
  /** With a pool: provider keys the reader may use, so a new one may map. */
  usableProviderKeyIds?: string[];
}) {
  const providerCatalog = useModelProviderCatalog({ fresh: true });
  const isRouter = selected === "model-router";
  const servesTarget = (provider: SupportedProvider) =>
    isRouter ? isModelRouterSupportedProvider(provider) : provider === selected;

  const { data: providerApiKeys = [], isPending: providerKeysPending } =
    useLlmProviderApiKeys();
  const targetProviderKeys = providerApiKeys.filter((key) =>
    servesTarget(key.provider),
  );

  const { data: organization } = useOrganization();
  const { data: canManageLlmSettings } = useHasPermissions({
    organizationSettings: ["update"],
  });
  const allowsUnauthenticated =
    organization?.allowUnauthenticatedLlmProxyRequests ?? false;

  const { data: virtualKeys } = useAllVirtualApiKeys({
    keyType: auth === "passthrough" ? "passthrough" : "standard",
    limit: 100,
    offset: 0,
    enabled: auth === "standard" || auth === "passthrough",
    toastOnError: false,
  });
  const { data: llmOauthClients } = useLlmOauthClients({
    limit: 100,
    enabled: auth === "oauth" && !pool,
    toastOnError: false,
  });
  // This list also says which pools each client is granted outright.
  const { data: poolOauthClients } = useOauthClients({
    capability: "llm:proxy",
    limit: 100,
    enabled: auth === "oauth" && !!pool,
    toastOnError: false,
  });
  const oauthClients: Array<LlmOauthClient & { modelPoolIds?: string[] }> =
    (pool ? poolOauthClients : llmOauthClients)?.data ?? [];
  const { data: session } = useSession();
  const { data: canCreateKey } = useHasPermissions({
    llmVirtualKey: ["create"],
  });
  const { data: canCreateOauth } = useHasPermissions({
    oauthClient: ["create"],
  });

  const [createKeyType, setCreateKeyType] = useState<VirtualKeyType | null>(
    null,
  );
  const [oauthCreateOpen, setOauthCreateOpen] = useState(false);
  const [created, setCreated] = useState<CreatedVirtualKey | null>(null);
  // undefined: nothing picked yet; null: "None" picked.
  const [pickedId, setPickedId] = useState<string | null | undefined>();

  // A standard key or OAuth client is usable here only if it maps a provider
  // key behind this endpoint; a passthrough key carries none and always fits.
  // For a pool, the credential must map a member's key, or the pool must list
  // the virtual key (or grant the client). A virtual key with a key of this
  // endpoint's provider reaches the pool through that key alone; otherwise
  // any member's key will do.
  const poolMappings = pool
    ? poolKeyMappings(pool, new Set(usableProviderKeyIds))
    : undefined;
  const memberKeyIds = new Set(
    (pool?.members ?? []).map((member) => member.providerApiKeyId),
  );
  const reaches = (
    credential: { providerApiKeys: ProviderApiKeyMappings },
    listedByPool: boolean,
    viaEndpointKey: boolean,
  ) => {
    if (!pool) {
      return credential.providerApiKeys.some((mapping) =>
        servesTarget(mapping.provider),
      );
    }
    const endpointKeys = viaEndpointKey
      ? credential.providerApiKeys.filter((mapping) =>
          servesTarget(mapping.provider),
        )
      : [];
    return (
      listedByPool ||
      (endpointKeys.length > 0
        ? endpointKeys
        : credential.providerApiKeys
      ).some((mapping) => memberKeyIds.has(mapping.providerApiKeyId))
    );
  };
  const keyOptions = (virtualKeys?.data ?? []).filter(
    (key) =>
      auth === "passthrough" ||
      reaches(key, pool?.virtualApiKeyIds.includes(key.id) ?? false, !isRouter),
  );
  const clientOptions = oauthClients.filter((client) =>
    reaches(client, !!pool && !!client.modelPoolIds?.includes(pool.id), false),
  );
  const allOptions =
    auth === "oauth"
      ? clientOptions.map((client) => ({
          id: client.id,
          authorId: client.authorId,
          tokenStart: null,
          name: client.name,
          label: client.name,
          mappings: client.providerApiKeys,
          oauth: { clientId: client.clientId, grantType: client.grantType },
        }))
      : keyOptions.map((key) => ({
          id: key.id,
          authorId: key.authorId,
          tokenStart: key.tokenStart,
          name: key.name,
          // The key's start shows in the key field; the picker stays short.
          label: key.name,
          mappings: key.providerApiKeys,
          oauth: null,
        }));
  // The reader's own credentials come first, so the default pick is one they
  // can reveal; anyone else's follow under their own heading.
  const noun = auth === "oauth" ? "clients" : "keys";
  const isOwn = (option: { authorId: string | null }) =>
    !!session?.user && option.authorId === session.user.id;
  const options = [
    ...allOptions
      .filter(isOwn)
      .map((option) => ({ ...option, group: `Your ${noun}` })),
    ...allOptions
      .filter((option) => !isOwn(option))
      .map((option) => ({ ...option, group: `Other ${noun}` })),
  ];
  // Like a standard key, the first fits until another is picked. Passthrough
  // attribution is optional, so "None" (an explicit null) stays none.
  const picked =
    pickedId === null
      ? undefined
      : (options.find((option) => option.id === pickedId) ?? options[0]);
  // The chosen key goes into the request masked, revealed or copied on
  // request — but only for keys the reader may read (their own, or one just
  // created here); anyone else's key is read from an env var.
  const isVirtualKey = auth === "standard" || auth === "passthrough";
  const fetchKeyValue = useFetchVirtualApiKeyValue();
  const createdHere = created && picked?.id === created.id ? created : null;
  const [revealed, setRevealed] = useState<string | null>(null);
  const secret: RevealableSecret | undefined =
    isVirtualKey &&
    picked &&
    (createdHere || (session?.user && picked.authorId === session.user.id))
      ? {
          resolve: async () =>
            createdHere
              ? createdHere.value
              : await fetchKeyValue.mutateAsync(picked.id),
          revealed,
          onRevealedChange: setRevealed,
        }
      : undefined;
  const pickKey = (id: string | null) => {
    setPickedId(id);
    setRevealed(null);
  };
  const keyField = picked && isVirtualKey && (
    <KeyField
      masked={`${picked.tokenStart ?? "arch_"}••••••••••••`}
      secret={secret}
    />
  );

  // A pool's members are the provider keys behind it.
  const hasProviderKey = !!pool || targetProviderKeys.length > 0;
  const [addProviderKeyOpen, setAddProviderKeyOpen] = useState(false);
  // A new key starts with the primary key of each provider this target
  // serves; the create dialog shows and changes them.
  const primaryKeyPerProvider = primaryKeyMappings(targetProviderKeys);
  const idpStep = useIdentityProviderStep();

  // Which provider key a request uses belongs to the credential, so the
  // provider-key step only appears when there is none to use yet.
  const providerKeyStep: ConnectStepProps | null =
    hasProviderKey || providerKeysPending
      ? null
      : {
          done: false,
          title: `${isRouter ? "Provider" : targetLabel} key`,
          detail: `No ${isRouter ? "provider" : targetLabel} key yet. The proxy needs one to call the provider.`,
          actions: (
            <Button size="sm" onClick={() => setAddProviderKeyOpen(true)}>
              Add {isRouter ? "provider" : targetLabel} key
            </Button>
          ),
        };
  const blockedDetail = "Add the provider key first.";
  const emptyDetail =
    pool && options.length === 0
      ? `Nothing here can call ${pool.name} yet. Create one.`
      : "Create one, or pick one you already have.";
  const mappingChips = (
    mappings: Array<{
      provider: SupportedProvider;
      providerApiKeyId: string;
      providerApiKeyName: string;
    }>,
  ) => (
    <span className="flex flex-wrap gap-1.5">
      {mappings
        .filter((mapping) =>
          pool
            ? memberKeyIds.has(mapping.providerApiKeyId)
            : servesTarget(mapping.provider),
        )
        .map((mapping) => (
          <span
            key={mapping.providerApiKeyId}
            className="inline-flex items-center gap-1.5 rounded-full border bg-muted py-0.5 pr-2 pl-1.5 text-xs text-foreground"
          >
            <span aria-hidden className="shrink-0">
              <ProviderIcon provider={mapping.provider} size={14} />
            </span>
            <span>
              {providerCatalog.label(mapping.provider)} ·{" "}
              {mapping.providerApiKeyName}
            </span>
          </span>
        ))}
    </span>
  );
  const target: RequestTarget = isRouter
    ? { kind: "model-router" }
    : { kind: "provider", provider: selected };

  let credentialSteps: RailRow[];
  let credential: RequestCredential;
  let credentialEnvVar: string;
  let ready: boolean;
  let mappedProviderKeys: Array<{
    provider: SupportedProvider;
    providerApiKeyId: string;
  }> = [];

  if (auth === "standard") {
    credential = "standard";
    credentialEnvVar = "ARCHESTRA_LLM_VIRTUAL_KEY";
    ready = hasProviderKey && !!picked;
    mappedProviderKeys = picked?.mappings ?? [];
    credentialSteps = [
      {
        done: !!picked,
        title: "Set up virtual key",
        titleAction: hasProviderKey && options.length > 0 && canCreateKey && (
          <CreateNewLink
            label="Create new virtual key"
            onCreate={() => setCreateKeyType("standard")}
          />
        ),
        detail: !hasProviderKey
          ? blockedDetail
          : picked
            ? mappingChips(picked.mappings)
            : emptyDetail,
        actions: hasProviderKey && (
          <CredentialSelect
            label="Virtual key"
            createLabel="Create new virtual key"
            canCreate={!!canCreateKey}
            onCreate={() => setCreateKeyType("standard")}
            options={options}
            value={picked?.id}
            onChange={pickKey}
          />
        ),
        children: keyField,
      },
    ];
  } else if (auth === "passthrough") {
    credential = "passthrough";
    credentialEnvVar = "ARCHESTRA_LLM_VIRTUAL_KEY";
    // Requests need a passthrough key unless the org allows unauthenticated
    // LLM proxy requests, so the step is only complete once one is picked.
    ready = allowsUnauthenticated || !!picked;
    credentialSteps = [
      {
        done: !!picked,
        title: "Passthrough key",
        render: (number) => (
          <PassthroughKeyStep
            number={number}
            targetLabel={targetLabel}
            picked={picked}
            options={options}
            required={!allowsUnauthenticated}
            canCreate={!!canCreateKey}
            canManageLlmSettings={!!canManageLlmSettings}
            onPick={pickKey}
            onCreate={() => setCreateKeyType("passthrough")}
          />
        ),
      },
    ];
  } else if (auth === "oauth") {
    credential = "token";
    credentialEnvVar = "ARCHESTRA_LLM_ACCESS_TOKEN";
    ready = hasProviderKey && !!picked;
    mappedProviderKeys = picked?.mappings ?? [];
    credentialSteps = [
      {
        done: !!picked,
        title: "OAuth client",
        titleAction: hasProviderKey && options.length > 0 && canCreateOauth && (
          <CreateNewLink
            label="Create new OAuth client"
            onCreate={() => setOauthCreateOpen(true)}
          />
        ),
        detail: !hasProviderKey
          ? blockedDetail
          : picked
            ? mappingChips(picked.mappings)
            : emptyDetail,
        actions: hasProviderKey && (
          <CredentialSelect
            label="OAuth client"
            createLabel="Create new OAuth client"
            canCreate={!!canCreateOauth}
            onCreate={() => setOauthCreateOpen(true)}
            options={options}
            value={picked?.id}
            onChange={pickKey}
          />
        ),
        children: picked?.oauth && (
          <OauthTokenRequest {...picked.oauth} scope={LLM_PROXY_OAUTH_SCOPE} />
        ),
      },
    ];
  } else {
    credential = "token";
    credentialEnvVar = "ARCHESTRA_LLM_IDP_TOKEN";
    ready = hasProviderKey && idpStep.configured;
    credentialSteps = [idpStep.row];
  }

  const request = ready && (
    <RequestExample
      key={`${picked?.id ?? "none"}:${secret ? "secret" : "env"}`}
      connectionBaseUrl={baseUrl}
      target={target}
      keyType={credential}
      secret={secret}
      // Passthrough with "None": the request carries only the provider key.
      keyValue={auth === "passthrough" && !picked ? "" : undefined}
      // A virtual key shows in its own step above, so no env-var hint here.
      credentialField={
        isVirtualKey ? (
          false
        ) : auth === "oauth" ? (
          <p className="text-sm text-muted-foreground">
            <code className="font-mono text-xs">
              $ARCHESTRA_LLM_ACCESS_TOKEN
            </code>{" "}
            is the <code className="font-mono text-xs">access_token</code> from
            the token request above.
          </p>
        ) : undefined
      }
      credentialEnvVar={credentialEnvVar}
      routerProviders={
        mappedProviderKeys.length > 0
          ? mappedProviderKeys
              .map((mapping) => mapping.provider)
              .filter(isModelRouterSupportedProvider)
          : targetProviderKeys
              .map((key) => key.provider)
              .filter(isModelRouterSupportedProvider)
      }
      mappedProviderKeys={mappedProviderKeys}
      model={pool?.name}
    />
  );

  const rows: RailRow[] = [
    // Passthrough calls the provider with the caller's own key.
    ...(providerKeyStep && auth !== "passthrough" ? [providerKeyStep] : []),
    ...credentialSteps,
    {
      done: false,
      title: "Send a request",
      detail: ready
        ? undefined
        : "The request appears here once the steps above are done.",
      children: request,
    },
  ];

  return (
    <>
      {rows.map(({ render, ...row }, index) =>
        render ? (
          <Fragment key={row.title}>{render(firstNumber + index)}</Fragment>
        ) : (
          <ConnectStep key={row.title} number={firstNumber + index} {...row} />
        ),
      )}

      <CreateVirtualKeyDialogWithData
        open={createKeyType !== null}
        onOpenChange={(open) => {
          if (!open) setCreateKeyType(null);
        }}
        keyType={createKeyType ?? "standard"}
        initialProviderApiKeys={poolMappings ?? primaryKeyPerProvider}
        targetLabel={targetLabel}
        onCreated={(key) => {
          setCreated(key);
          pickKey(key.id);
        }}
      />
      <OauthClientCreateFlow
        open={oauthCreateOpen}
        onOpenChange={setOauthCreateOpen}
        defaultProviderApiKeys={poolMappings}
      />
      <CreateLlmProviderApiKeyDialog
        open={addProviderKeyOpen}
        onOpenChange={setAddProviderKeyOpen}
        title={`Add ${isRouter ? "provider" : targetLabel} key`}
        description="The proxy uses this key to call the provider."
        allowedProviders={isRouter ? undefined : [selected]}
        credentialMode="api-key"
        showConsoleLink
      />
    </>
  );
}

/**
 * The passthrough key picker as a card: "None" and each key as a row, the
 * chosen one checked, with create at the foot. Replaces the native dropdown.
 */
function PassthroughKeyPicker({
  options,
  selectedId,
  allowNone,
  canCreate,
  onSelect,
  onCreate,
  onCancel,
}: {
  options: Array<{
    id: string;
    label: string;
    group?: string;
    tokenStart?: string | null;
  }>;
  selectedId: string | null;
  /** Offer "No passthrough key"; false when the organization requires one. */
  allowNone: boolean;
  canCreate: boolean;
  onSelect: (id: string | null) => void;
  onCreate: () => void;
  onCancel: () => void;
}) {
  const rowClass = (selected: boolean) =>
    cn(
      "flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-muted",
      selected && "bg-primary/5",
    );

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          Choose a passthrough key
        </span>
        <UnstyledButton
          type="button"
          onClick={onCancel}
          className="text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          Cancel
        </UnstyledButton>
      </div>
      {allowNone && (
        <UnstyledButton
          type="button"
          onClick={() => onSelect(null)}
          className={rowClass(selectedId === null)}
        >
          <span className="flex flex-col gap-0.5">
            <span className="text-[13px] font-semibold text-foreground">
              No passthrough key
            </span>
            <span className="text-xs text-muted-foreground">
              Requests aren't linked to a user
            </span>
          </span>
          {selectedId === null && (
            <Check className="size-4 shrink-0 text-primary" aria-hidden />
          )}
        </UnstyledButton>
      )}
      {options.map((option, index) => {
        const selected = option.id === selectedId;
        return (
          <UnstyledButton
            key={option.id}
            type="button"
            onClick={() => onSelect(option.id)}
            className={cn(
              rowClass(selected),
              (allowNone || index > 0) && "border-t border-border",
            )}
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-[13px] font-semibold text-foreground">
                {option.label}
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                {`${option.tokenStart ?? "arch_"}••••••••••••`}
              </span>
            </span>
            {selected && (
              <Check className="size-4 shrink-0 text-primary" aria-hidden />
            )}
          </UnstyledButton>
        );
      })}
      {canCreate && (
        <div className="border-t border-border px-4 py-2.5">
          <UnstyledButton
            type="button"
            onClick={onCreate}
            className="text-[13px] font-medium text-primary hover:text-primary/80"
          >
            + Create new key
          </UnstyledButton>
        </div>
      )}
    </div>
  );
}

/** A step row that renders itself, instead of the shared rail's layout. */
type RailRow = ConnectStepProps & { render?: (number: number) => ReactNode };

/**
 * The passthrough step as the design draws it: the header name, a required or
 * optional badge, the chosen key as a card, or an empty state that offers to
 * create one. Choosing another key opens the picker in place.
 */
function PassthroughKeyStep({
  number,
  targetLabel,
  picked,
  options,
  required,
  canCreate,
  canManageLlmSettings,
  onPick,
  onCreate,
}: {
  number: number;
  targetLabel: string;
  picked: { id: string; label: string; tokenStart?: string | null } | undefined;
  options: Array<{ id: string; label: string; group?: string }>;
  required: boolean;
  canCreate: boolean;
  canManageLlmSettings: boolean;
  onPick: (id: string | null) => void;
  onCreate: () => void;
}) {
  const [changing, setChanging] = useState(false);
  const chooseLabel = options.length > 0 ? "Choose existing" : null;

  return (
    <li className="relative flex gap-5 pb-10 before:absolute before:top-8 before:bottom-1 before:left-4 before:w-px before:bg-border last:pb-0 last:before:hidden">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-muted-foreground/40 bg-card text-[13px] font-semibold text-muted-foreground tabular-nums">
        {number}
      </span>
      <section className="min-w-0 flex-1 space-y-4">
        <div className="flex items-center gap-2.5">
          <h2 className="text-lg font-semibold text-foreground">
            Passthrough key
          </h2>
          <span
            className={
              required
                ? "rounded-full bg-amber-100 dark:bg-amber-950 px-2.5 py-[3px] text-xs font-semibold text-amber-800 dark:text-amber-300"
                : "rounded-full bg-muted px-2.5 py-[3px] text-xs font-semibold text-muted-foreground"
            }
          >
            {required ? "Required" : "Optional"}
          </span>
        </div>
        <p className="text-sm leading-[22px] text-muted-foreground">
          Send your own {targetLabel} key, and this passthrough key in the{" "}
          <code className="rounded-md border border-border bg-card px-1.5 py-0.5 font-mono text-xs text-foreground">
            {VIRTUAL_KEY_HEADER}
          </code>{" "}
          header.
        </p>

        {changing ? (
          <PassthroughKeyPicker
            options={options}
            selectedId={picked?.id ?? null}
            allowNone={!required}
            canCreate={canCreate}
            onSelect={(id) => {
              onPick(id);
              setChanging(false);
            }}
            onCreate={onCreate}
            onCancel={() => setChanging(false)}
          />
        ) : picked ? (
          <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-card px-4 py-3.5">
            <div className="flex min-w-0 flex-col gap-1">
              <span className="truncate text-[13px] font-semibold text-foreground">
                {picked.label}
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                {`${picked.tokenStart ?? "arch_"}••••••••••••`}
              </span>
            </div>
            <UnstyledButton
              type="button"
              onClick={() => setChanging(true)}
              className="shrink-0 text-[13px] font-medium text-foreground underline underline-offset-2 hover:text-primary"
            >
              Change
            </UnstyledButton>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2.5 rounded-xl border border-dashed border-border bg-card p-6 text-center">
            <span className="text-sm font-semibold text-foreground">
              No passthrough key yet
            </span>
            <span className="max-w-[400px] text-[13px] leading-5 text-muted-foreground">
              {required
                ? "Create one, then send it in the"
                : "Without one, requests aren't linked to a user. Create one, then send it in the"}{" "}
              <code className="font-mono text-xs">{VIRTUAL_KEY_HEADER}</code>{" "}
              header with your provider key.
            </span>
            <div className="mt-1.5 flex items-center gap-2">
              {canCreate && (
                <Button type="button" size="sm" onClick={onCreate}>
                  + Create new key
                </Button>
              )}
              {chooseLabel && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setChanging(true)}
                >
                  {chooseLabel}
                </Button>
              )}
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs leading-[18px] text-muted-foreground">
            {required
              ? "Requests without a passthrough key are rejected."
              : "Requests without a passthrough key are accepted, but not linked to a user."}
            {canManageLlmSettings && (
              <>
                {" "}
                Admins can change this in{" "}
                <Link
                  href="/settings/llm"
                  className="underline hover:text-foreground"
                >
                  LLM settings
                </Link>
                .
              </>
            )}
          </p>
          {picked && canCreate && (
            <Button type="button" size="sm" onClick={onCreate}>
              + Create new key
            </Button>
          )}
        </div>
      </section>
    </li>
  );
}

/**
 * The chosen key on its own line, masked like the MCP gateway's token: the eye
 * reveals it (with the request below), and copying is an explicit choice
 * between the real key and a placeholder. Someone else's key stays masked —
 * only its author can read it.
 */
function KeyField({
  masked,
  secret,
}: {
  masked: string;
  secret: RevealableSecret | undefined;
}) {
  const [isRevealing, setIsRevealing] = useState(false);
  const revealed = secret?.revealed ?? null;
  return (
    <TerminalCard className="relative">
      {secret && (
        <div className="absolute top-1.5 right-1.5 flex items-center gap-1">
          <UnstyledButton
            type="button"
            disabled={isRevealing}
            aria-label={revealed ? "Hide key" : "Show key"}
            aria-pressed={revealed !== null}
            className={cn(terminalActionClass, "size-7")}
            onClick={async () => {
              if (revealed) {
                secret.onRevealedChange(null);
                return;
              }
              setIsRevealing(true);
              try {
                secret.onRevealedChange(await secret.resolve());
              } finally {
                setIsRevealing(false);
              }
            }}
          >
            {isRevealing ? (
              <Loader2 className="animate-spin" />
            ) : revealed ? (
              <EyeOff />
            ) : (
              <Eye />
            )}
          </UnstyledButton>
          <SecretCopyButton
            variant="terminal"
            getSecretText={async () => revealed ?? (await secret.resolve())}
            placeholderText="$ARCHESTRA_LLM_VIRTUAL_KEY"
          />
        </div>
      )}
      <pre
        className={cn(
          "m-0 overflow-x-auto px-4 py-2.5 pr-20 text-xs",
          terminalCodeClass,
        )}
      >
        {revealed ?? masked}
      </pre>
      {!secret && (
        <p className="px-4 pb-2.5 text-xs text-terminal-muted">
          Only its author can reveal this key.
        </p>
      )}
    </TerminalCard>
  );
}

/**
 * The identity provider the proxy trusts for JWTs. The roster is an enterprise
 * feature — `useIdentityProviders` stays disabled without it, so only the setup
 * link shows.
 */
const NONE_VALUE = "__none__";

function useIdentityProviderStep(): {
  configured: boolean;
  row: ConnectStepProps;
} {
  const { data: proxy } = useLlmProxy();
  const { data: identityProviders } = useIdentityProviders();
  const { data: canUpdate } = useHasPermissions({ llmProxy: ["update"] });
  const updateProxy = useUpdateLlmProxy();
  const selectId = useId();

  const idpId = proxy?.identityProviderId ?? null;
  const idpName = identityProviders?.find((idp) => idp.id === idpId)?.issuer;
  const orgHasIdps = (identityProviders?.length ?? 0) > 0;

  return {
    configured: !!idpId,
    row: {
      done: !!idpId,
      title: "Identity provider",
      detail: idpId
        ? `Trusting ${idpName ?? "the selected identity provider"}. Send its JWT as the bearer token.`
        : "Not configured.",
      actions: !canUpdate ? null : orgHasIdps ? (
        <>
          <Label htmlFor={selectId} className="sr-only">
            Identity provider
          </Label>
          <Select
            value={idpId ?? NONE_VALUE}
            disabled={updateProxy.isPending}
            onValueChange={(value) =>
              updateProxy.mutate({
                identityProviderId: value === NONE_VALUE ? null : value,
              })
            }
          >
            <SelectTrigger id={selectId} className="w-64">
              <SelectValue placeholder="No identity provider" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE_VALUE}>No identity provider</SelectItem>
              {identityProviders?.map((provider) => (
                <SelectItem key={provider.id} value={provider.id}>
                  {provider.providerId} ({provider.issuer})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      ) : (
        <Button asChild size="sm">
          <Link href="/settings/identity-providers">
            Set up identity provider
          </Link>
        </Button>
      ),
    },
  };
}

/**
 * The shared create dialog preset to an LLM client, followed by the one-time
 * credentials reveal.
 */
function OauthClientCreateFlow({
  open,
  onOpenChange,
  defaultProviderApiKeys,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultProviderApiKeys?: ProviderApiKeyMappings;
}) {
  const { data: providerApiKeys = [] } = useLlmProviderApiKeys({
    enabled: open,
  });
  const llmCreate = useCreateOauthClient();
  const [createdCredentials, setCreatedCredentials] =
    useState<CreatedCredentials | null>(null);

  return (
    <>
      <CreateManagedOAuthClientDialog
        open={open}
        onOpenChange={onOpenChange}
        defaultClientType="llm"
        defaultProviderApiKeys={defaultProviderApiKeys}
        providerApiKeys={providerApiKeys}
        onSubmit={async (values) => {
          const result = await llmCreate.mutateAsync(values);
          if (result) {
            setCreatedCredentials({
              clientId: result.clientId,
              clientSecret: result.clientSecret,
              grantType: result.grantType,
              oauthScope: result.scopes.join(" "),
            });
            onOpenChange(false);
          }
        }}
        isSubmitting={llmCreate.isPending}
      />
      <OAuthClientCreatedDialog
        open={!!createdCredentials}
        onOpenChange={(open) => {
          if (!open) setCreatedCredentials(null);
        }}
        title="OAuth Client Created"
        credentials={createdCredentials}
      />
    </>
  );
}

/**
 * The members' provider keys, one per provider, as a new credential's
 * starting mapping: a credential mapping any of them can call the pool by
 * name, on any endpoint. Only keys the reader may use, since creating a
 * credential with anyone else's fails.
 */
function poolKeyMappings(
  pool: ConnectablePoolDetails,
  usableKeyIds: Set<string>,
): ProviderApiKeyMappings {
  const mappings: ProviderApiKeyMappings = [];
  for (const member of pool.members) {
    if (!usableKeyIds.has(member.providerApiKeyId)) continue;
    if (mappings.some((mapping) => mapping.provider === member.provider)) {
      continue;
    }
    mappings.push({
      provider: member.provider,
      providerApiKeyId: member.providerApiKeyId,
    });
  }
  return mappings;
}

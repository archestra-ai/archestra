"use client";

import {
  isModelRouterSupportedProvider,
  LLM_PROXY_OAUTH_SCOPE,
  type SupportedProvider,
  VIRTUAL_KEY_HEADER,
} from "@archestra/shared";
import { Eye, EyeOff, Loader2, Waypoints } from "lucide-react";
import Link from "next/link";
import { useId, useMemo, useState } from "react";
import {
  getProxyEndpointProviders,
  type ProxyEndpointProvider,
  resolveAdminDefaultBaseUrl,
  resolveCandidateBaseUrls,
} from "@/app/connection/connection-flow.utils";
import { TerminalBlock } from "@/app/connection/terminal-block";
import {
  type AuthMethodOption,
  AuthMethodPicker,
  ConnectStep,
  type ConnectStepProps,
  CreateNewLink,
  CredentialSelect,
  OauthTokenRequest,
} from "@/components/connect-rail";
import { CreateLlmProviderApiKeyDialog } from "@/components/create-llm-provider-api-key-dialog";
import { CreateOAuthClientDialog } from "@/components/create-oauth-client-dialog";
import {
  type CreatedVirtualKey,
  CreateVirtualKeyDialogWithData,
  type VirtualKeyType,
} from "@/components/create-virtual-key-dialog";
import { PROVIDER_CONFIG } from "@/components/llm-provider-api-key-form";
import { LlmProviderOptionLabel } from "@/components/llm-provider-select-items";
import {
  type CreatedCredentials,
  OAuthClientCreatedDialog,
} from "@/components/oauth-client-created-dialog";
import { SecretCopyButton } from "@/components/secret-copy-button";
import {
  TerminalCard,
  terminalActionClass,
  terminalCodeClass,
} from "@/components/terminal-surface";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
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
import config from "@/lib/config/config";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import {
  useCreateLlmOauthClient,
  useLlmOauthClients,
} from "@/lib/llm-oauth-clients.query";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { useLlmProxy, useUpdateLlmProxy } from "@/lib/llm-proxy.query";
import { useOrganization } from "@/lib/organization.query";
import { cn } from "@/lib/utils/tailwind";
import {
  useAllVirtualApiKeys,
  useFetchVirtualApiKeyValue,
} from "@/lib/virtual-api-keys.query";

/**
 * The LLM Proxy connection page, read top to bottom: pick the endpoint, pick
 * how requests authenticate, then follow the steps for that pair. Each step
 * shows what already exists — provider keys, virtual keys, OAuth clients — so
 * the request at the end is the one this deployment can actually serve.
 */
export default function LlmProxyPage() {
  const { baseUrl, organization } = useConnectionBaseUrl();
  const providerCatalog = useModelProviderCatalog();
  const [selected, setSelected] = useState<
    "model-router" | ProxyEndpointProvider
  >("model-router");
  const [auth, setAuth] = useState<AuthMethod>("standard");
  const providers = getProxyEndpointProviders(organization);
  // Passthrough has no Model Router route; picking the router falls back to
  // a standard key, and the choice returns when a provider is picked again.
  const effectiveAuth =
    selected === "model-router" && auth === "passthrough" ? "standard" : auth;
  const targetLabel =
    selected === "model-router"
      ? "Model Router"
      : providerCatalog.label(selected);

  return (
    // No inner cap: the page column is PageLayout's band, which is centred.
    // A narrower wrapper inside it is not centred in turn, so the steps sat
    // against the band's left edge with the leftover stranded on the right.
    <ol>
      <ConnectStep number={1} title="Endpoint">
        <ProxyEndpointCard
          baseUrl={baseUrl}
          providers={[...providers]}
          selected={selected}
          onSelect={setSelected}
        />
        <p className="text-sm text-muted-foreground">
          {endpointHint(selected, targetLabel)}
        </p>
      </ConnectStep>
      <ConnectStep number={2} title="Authentication">
        <AuthMethodPicker
          methods={AUTH_METHODS}
          value={effectiveAuth}
          onChange={setAuth}
          unavailable={
            selected === "model-router"
              ? { passthrough: PASSTHROUGH_ROUTER_REASON }
              : undefined
          }
        />
      </ConnectStep>
      <ConnectSteps
        // Selections belong to one endpoint and auth method; start over
        // when either changes.
        key={`${selected}:${effectiveAuth}`}
        firstNumber={3}
        baseUrl={baseUrl}
        selected={selected}
        auth={effectiveAuth}
        targetLabel={targetLabel}
      />
    </ol>
  );
}

// =========================================================================
// 1 · Endpoint
// =========================================================================

const PRIMARY_PROVIDERS: ProxyEndpointProvider[] = [
  "openai",
  "anthropic",
  "gemini",
  "bedrock",
  "groq",
];

/** Tab button in the endpoint terminal card. */
function endpointTabClass(active: boolean) {
  return cn(
    "flex items-center gap-2 rounded-md px-3 py-1.5 text-xs transition-colors",
    active
      ? "bg-terminal-emphasis/10 font-semibold text-terminal-foreground shadow-sm"
      : "text-terminal-muted hover:text-terminal-emphasis",
  );
}

/**
 * A terminal block with a Model Router tab and per-provider tabs (primary
 * providers inline, the rest behind a searchable "More providers"). URLs are
 * id-less — the proxy is a singleton, so the path is just `/v1/<provider>` or
 * `/v1/model-router`.
 */
function ProxyEndpointCard({
  baseUrl,
  providers,
  selected,
  onSelect,
}: {
  baseUrl: string;
  providers: ProxyEndpointProvider[];
  selected: "model-router" | ProxyEndpointProvider;
  onSelect: (target: "model-router" | ProxyEndpointProvider) => void;
}) {
  const providerCatalog = useModelProviderCatalog();
  const { data: providerApiKeys = [] } = useLlmProviderApiKeys();
  // Providers with a key are the ones a client can reach, so they lead; the
  // usual defaults fill the row up to its minimum width.
  const configured = providers.filter((p) =>
    providerApiKeys.some((key) => key.provider === p),
  );
  const primary = [
    ...configured,
    ...PRIMARY_PROVIDERS.filter(
      (p) => providers.includes(p) && !configured.includes(p),
    ),
  ].slice(0, Math.max(PRIMARY_PROVIDERS.length, configured.length));
  const rest = providers.filter((p) => !primary.includes(p));
  const selectedFromRest =
    selected !== "model-router" && rest.includes(selected) ? selected : null;
  const tabProviders = selectedFromRest
    ? [...primary, selectedFromRest]
    : primary;
  const moreCount = rest.length - (selectedFromRest ? 1 : 0);

  const url = endpointUrl(baseUrl, selected);

  // Jev's URL is the endpoint itself; every other one is a base URL clients
  // append paths to. Bedrock exposes two, as labeled rows in the same card.
  const badge = selected === "jev" ? "POST" : "BASE URL";
  const rows =
    selected === "bedrock"
      ? [
          {
            comment: "Bedrock Converse API",
            badge,
            code: `${baseUrl}/bedrock`,
          },
          {
            comment: "OpenAI Completions API compatible clients",
            badge,
            code: `${baseUrl}/bedrock/openai`,
          },
        ]
      : [{ badge, code: url }];

  return (
    <TerminalBlock
      rows={rows}
      header={
        <div className="flex flex-wrap items-center gap-1 border-b border-terminal-edge p-1.5">
          <UnstyledButton
            type="button"
            onClick={() => onSelect("model-router")}
            className={endpointTabClass(selected === "model-router")}
          >
            <Waypoints className="size-3.5" />
            Model Router
          </UnstyledButton>
          {tabProviders.map((provider) => (
            <UnstyledButton
              key={provider}
              type="button"
              onClick={() => onSelect(provider)}
              className={endpointTabClass(selected === provider)}
            >
              <img
                src={PROVIDER_CONFIG[provider].icon}
                alt=""
                className="size-3.5 rounded-sm"
              />
              {providerCatalog.label(provider)}
            </UnstyledButton>
          ))}
          {moreCount > 0 && (
            <SearchableSelect
              value=""
              onValueChange={(value) =>
                onSelect(value as ProxyEndpointProvider)
              }
              placeholder={`More providers (${moreCount})`}
              ariaLabel="More providers"
              searchPlaceholder="Search providers..."
              emptyMessage="No providers found."
              items={rest.map((provider) => {
                const label = providerCatalog.label(provider);
                return {
                  value: provider,
                  label,
                  content: (
                    <LlmProviderOptionLabel
                      icon={PROVIDER_CONFIG[provider].icon}
                      name={label}
                    />
                  ),
                };
              })}
              className="ml-1 h-auto w-auto min-w-0 justify-start gap-2 rounded-full border border-dashed border-terminal-edge bg-transparent px-3 py-1.5 font-normal text-terminal-muted text-xs shadow-none hover:bg-transparent hover:text-terminal-emphasis"
              contentClassName="w-64"
            />
          )}
        </div>
      }
    />
  );
}

// =========================================================================
// 2 · Authentication
// =========================================================================

type AuthMethod = "standard" | "passthrough" | "oauth" | "idp";

const AUTH_METHODS: AuthMethodOption<AuthMethod>[] = [
  {
    value: "standard",
    title: "Standard virtual key",
    description:
      "One key for your app. The proxy maps it to your provider keys.",
    manage: {
      label: "Manage virtual keys",
      href: "/llm/proxy/virtual-keys?keyType=standard",
    },
  },
  {
    value: "passthrough",
    title: "Passthrough",
    description:
      "Send your own provider key. A header can link requests to a user.",
    manage: {
      label: "Manage passthrough keys",
      href: "/llm/proxy/virtual-keys?keyType=passthrough",
    },
  },
  {
    value: "oauth",
    title: "OAuth client",
    description: "Apps call the proxy as themselves or for signed-in users.",
    manage: {
      label: "Manage OAuth clients",
      href: "/settings/oauth-clients?type=llm",
    },
  },
  {
    value: "idp",
    title: "Identity provider",
    description:
      "Use a JWT from your identity provider. Requests run with that user's access.",
    manage: {
      label: "Manage identity providers",
      href: "/settings/identity-providers",
    },
  },
];

const PASSTHROUGH_ROUTER_REASON =
  "The Model Router calls providers with your organization's provider keys, so it can't take your own. Pick a provider endpoint to use passthrough.";

// =========================================================================
// 3 · Connect
// =========================================================================

/**
 * The steps for one endpoint and auth method, each showing what exists:
 * the provider keys behind the endpoint, the credential to connect with
 * (create one, or pick an existing one), and the request to send.
 */
function ConnectSteps({
  firstNumber,
  baseUrl,
  selected,
  auth,
  targetLabel,
}: {
  /** The page rail's number for the first of these steps. */
  firstNumber: number;
  baseUrl: string;
  selected: "model-router" | ProxyEndpointProvider;
  auth: AuthMethod;
  targetLabel: string;
}) {
  const providerCatalog = useModelProviderCatalog();
  const isRouter = selected === "model-router";
  const servesTarget = (provider: SupportedProvider) =>
    isRouter ? isModelRouterSupportedProvider(provider) : provider === selected;

  const { data: providerApiKeys = [], isPending: providerKeysPending } =
    useLlmProviderApiKeys();
  const targetProviderKeys = providerApiKeys.filter((key) =>
    servesTarget(key.provider),
  );

  const { data: virtualKeys } = useAllVirtualApiKeys({
    keyType: auth === "passthrough" ? "passthrough" : "standard",
    limit: 100,
    offset: 0,
    enabled: auth === "standard" || auth === "passthrough",
    toastOnError: false,
  });
  const { data: oauthClients } = useLlmOauthClients({
    limit: 100,
    enabled: auth === "oauth",
    toastOnError: false,
  });
  const { data: session } = useSession();
  const { data: canCreateKey } = useHasPermissions({
    llmVirtualKey: ["create"],
  });
  const { data: canCreateOauth } = useHasPermissions({
    llmOauthClient: ["create"],
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
  const keyOptions = (virtualKeys?.data ?? []).filter(
    (key) =>
      auth === "passthrough" ||
      key.providerApiKeys.some((mapping) => servesTarget(mapping.provider)),
  );
  const clientOptions = (oauthClients?.data ?? []).filter((client) =>
    client.providerApiKeys.some((mapping) => servesTarget(mapping.provider)),
  );
  const options =
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

  const hasProviderKey = targetProviderKeys.length > 0;
  const [addProviderKeyOpen, setAddProviderKeyOpen] = useState(false);
  // A virtual key maps one key per provider, so a new key starts with the
  // first key of each provider; the create dialog shows and changes them.
  const firstKeyPerProvider = targetProviderKeys
    .filter(
      (key, index) =>
        targetProviderKeys.findIndex((k) => k.provider === key.provider) ===
        index,
    )
    .map((key) => ({ provider: key.provider, providerApiKeyId: key.id }));
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
  const mappingChips = (
    mappings: Array<{
      provider: SupportedProvider;
      providerApiKeyId: string;
      providerApiKeyName: string;
    }>,
  ) => (
    <span className="flex flex-wrap gap-1.5">
      {mappings
        .filter((mapping) => servesTarget(mapping.provider))
        .map((mapping) => (
          <span
            key={mapping.providerApiKeyId}
            className="rounded-full border bg-muted px-2 py-0.5 text-xs text-foreground"
          >
            {providerCatalog.label(mapping.provider)} ·{" "}
            {mapping.providerApiKeyName}
          </span>
        ))}
    </span>
  );
  const target: RequestTarget = isRouter
    ? { kind: "model-router" }
    : { kind: "provider", provider: selected };

  let credentialSteps: ConnectStepProps[];
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
            : "Create one, or pick one you already have.",
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
    ready = true;
    credentialSteps = [
      {
        done: !!picked,
        title: "Passthrough key (optional)",
        titleAction: options.length > 0 && canCreateKey && (
          <CreateNewLink
            label="Create new passthrough key"
            onCreate={() => setCreateKeyType("passthrough")}
          />
        ),
        detail: (
          <>
            You send your own {targetLabel} key, and this passthrough key in the{" "}
            <code className="font-mono text-xs">{VIRTUAL_KEY_HEADER}</code>{" "}
            header.
          </>
        ),
        actions: (
          <CredentialSelect
            label="Passthrough key"
            createLabel="Create new passthrough key"
            canCreate={!!canCreateKey}
            onCreate={() => setCreateKeyType("passthrough")}
            options={options}
            value={picked?.id}
            onChange={pickKey}
            noneLabel="None"
          />
        ),
        children: keyField || (
          <p className="text-sm text-muted-foreground">
            No passthrough key: requests aren't linked to a user.
          </p>
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
            : "Create one, or pick one you already have.",
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
    />
  );

  const rows: ConnectStepProps[] = [
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
      {rows.map((row, index) => (
        <ConnectStep key={row.title} number={firstNumber + index} {...row} />
      ))}

      <CreateVirtualKeyDialogWithData
        open={createKeyType !== null}
        onOpenChange={(open) => {
          if (!open) setCreateKeyType(null);
        }}
        keyType={createKeyType ?? "standard"}
        initialProviderApiKeys={firstKeyPerProvider}
        targetLabel={targetLabel}
        onCreated={(key) => {
          setCreated(key);
          pickKey(key.id);
        }}
      />
      <OauthClientCreateFlow
        open={oauthCreateOpen}
        onOpenChange={setOauthCreateOpen}
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
              <Loader2 className="size-3.5 animate-spin" />
            ) : revealed ? (
              <EyeOff className="size-3.5" />
            ) : (
              <Eye className="size-3.5" />
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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: providerApiKeys = [] } = useLlmProviderApiKeys({
    enabled: open,
  });
  const llmCreate = useCreateLlmOauthClient();
  const [createdCredentials, setCreatedCredentials] =
    useState<CreatedCredentials | null>(null);

  return (
    <>
      <CreateOAuthClientDialog
        open={open}
        onOpenChange={onOpenChange}
        defaultClientType="llm"
        fixedClientType="llm"
        gateways={[]}
        providerApiKeys={providerApiKeys}
        onSubmit={async (values) => {
          if (values.kind !== "llm") return;
          const result = await llmCreate.mutateAsync(values.body);
          if (result) {
            setCreatedCredentials({
              clientId: result.clientId,
              clientSecret: result.clientSecret,
              grantType: result.grantType,
              oauthScope: LLM_PROXY_OAUTH_SCOPE,
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

// =========================================================================
// Internal helpers
// =========================================================================

/** Same base-URL resolution as the /connection page. */
function useConnectionBaseUrl() {
  const { data: organization } = useOrganization();
  const connectionBaseUrls = organization?.connectionBaseUrls ?? null;
  const baseUrl = useMemo(() => {
    const candidates = resolveCandidateBaseUrls({
      externalProxyUrls: config.api.externalProxyUrls,
      internalProxyUrl: config.api.internalProxyUrl,
      metadata: connectionBaseUrls,
    });
    const adminDefault = resolveAdminDefaultBaseUrl(connectionBaseUrls);
    return adminDefault && candidates.includes(adminDefault)
      ? adminDefault
      : candidates[0];
  }, [connectionBaseUrls]);
  return { baseUrl, organization };
}

/** Jev serves one decisions endpoint rather than a base URL clients extend. */
function endpointUrl(
  baseUrl: string,
  selected: "model-router" | ProxyEndpointProvider,
) {
  if (selected === "model-router") return `${baseUrl}/model-router`;
  if (selected === "jev") return `${baseUrl}/jev/decisions`;
  return `${baseUrl}/${selected}`;
}

function endpointHint(
  selected: "model-router" | ProxyEndpointProvider,
  label: string,
) {
  if (selected === "model-router") {
    return "OpenAI-compatible. Prefix the model with its provider, like openai:gpt-5.4.";
  }
  if (selected === "jev") return "Decisions only: one endpoint, no chat.";
  return `Keep your ${label} SDK and change only the base URL.`;
}

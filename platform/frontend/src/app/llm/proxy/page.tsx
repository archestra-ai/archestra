"use client";

import { type ChatProvider, LLM_PROXY_OAUTH_SCOPE } from "@archestra/shared";
import { Info } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import {
  getConnectableProviders,
  resolveAdminDefaultBaseUrl,
  resolveCandidateBaseUrls,
} from "@/app/connection/connection-flow.utils";
import { TerminalBlock } from "@/app/connection/terminal-block";
import { AuthMethodRow } from "@/components/auth-method-row";
import { CreateOAuthClientDialog } from "@/components/create-oauth-client-dialog";
import {
  CreateVirtualKeyDialogWithData,
  type VirtualKeyType,
} from "@/components/create-virtual-key-dialog";
import {
  type CreatedCredentials,
  OAuthClientCreatedDialog,
} from "@/components/oauth-client-created-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useIdentityProviders } from "@/lib/auth/identity-provider-read.query";
import config from "@/lib/config/config";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import { useCreateLlmOauthClient } from "@/lib/llm-oauth-clients.query";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { useLlmProxy, useUpdateLlmProxy } from "@/lib/llm-proxy.query";
import { useOrganization } from "@/lib/organization.query";
import { cn } from "@/lib/utils";

/**
 * The LLM Proxy connection page: the endpoint URLs a client points at, and an
 * overview of every way a request can authenticate — with links into the
 * Virtual Keys and OAuth Clients tabs that manage those credentials.
 */
export default function LlmProxyPage() {
  const { baseUrl, organization } = useConnectionBaseUrl();
  const [selected, setSelected] = useState<"model-router" | ChatProvider>(
    "model-router",
  );
  const providers = getConnectableProviders(organization);

  return (
    <div className="max-w-4xl space-y-4">
      <ProxyEndpointCard
        baseUrl={baseUrl}
        providers={[...providers]}
        routerSelected={selected === "model-router"}
        selectedProvider={selected === "model-router" ? null : selected}
        onSelectRouter={() => setSelected("model-router")}
        onSelectProvider={setSelected}
      />
      {selected === "model-router" && (
        <Alert variant="info">
          <Info />
          <AlertTitle>How Model Router works</AlertTitle>
          <AlertDescription>
            Use one OpenAI-compatible endpoint for models from different
            providers. The provider at the start of the model name tells Model
            Router where to send the request.
          </AlertDescription>
        </Alert>
      )}
      <AuthenticationOverview />
      <p className="text-xs text-muted-foreground">
        Need setup steps for your app?{" "}
        <Link href="/connection" className="text-primary hover:underline">
          Open the Connect page.
        </Link>
      </p>
    </div>
  );
}

// =========================================================================
// Endpoint card
// =========================================================================

const PRIMARY_PROVIDERS: ChatProvider[] = [
  "openai",
  "anthropic",
  "gemini",
  "bedrock",
  "groq",
];

/** Tab button in the endpoint terminal card. */
function endpointTabClass(active: boolean) {
  return cn(
    "border-b-2 px-2.5 py-2.5 font-mono text-xs transition-colors",
    active
      ? "border-white font-semibold text-white"
      : "border-transparent text-[#9ca3af] hover:text-white",
  );
}

/**
 * The proxy endpoint card: a terminal block with a Model Router tab and
 * per-provider tabs (primary providers inline, the rest behind a searchable
 * "…"). URLs are id-less — the proxy is a singleton, so the path is just
 * `/v1/<provider>` or `/v1/model-router`.
 */
function ProxyEndpointCard({
  baseUrl,
  providers,
  routerSelected,
  selectedProvider,
  onSelectRouter,
  onSelectProvider,
}: {
  baseUrl: string;
  providers: ChatProvider[];
  routerSelected: boolean;
  selectedProvider: ChatProvider | null;
  onSelectRouter: () => void;
  onSelectProvider: (provider: ChatProvider) => void;
}) {
  const providerCatalog = useModelProviderCatalog();
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const primary = providers.filter((p) => PRIMARY_PROVIDERS.includes(p));
  const rest = providers.filter((p) => !PRIMARY_PROVIDERS.includes(p));
  const selectedFromRest =
    selectedProvider && rest.includes(selectedProvider)
      ? selectedProvider
      : null;
  const tabProviders = selectedFromRest
    ? [...primary, selectedFromRest]
    : primary;
  const searchResults = rest.filter((p) =>
    providerCatalog.label(p).toLowerCase().includes(search.toLowerCase()),
  );

  const url = routerSelected
    ? `${baseUrl}/model-router`
    : `${baseUrl}/${selectedProvider}`;

  // Bedrock exposes two endpoints; both live in the same card as labeled rows.
  const rows =
    !routerSelected && selectedProvider === "bedrock"
      ? [
          {
            comment: "Bedrock Converse API",
            code: `${baseUrl}/bedrock`,
          },
          {
            comment: "OpenAI Completions API compatible clients",
            code: `${baseUrl}/bedrock/openai`,
          },
        ]
      : undefined;

  return (
    <div className="space-y-2 rounded-lg border bg-card p-4">
      <h3 className="text-sm font-semibold">Endpoint</h3>
      <TerminalBlock
        code={url}
        rows={rows}
        header={
          <div className="flex flex-wrap items-center gap-1 border-b border-[#1f2937] px-3">
            <button
              type="button"
              onClick={onSelectRouter}
              className={endpointTabClass(routerSelected)}
            >
              Model Router
            </button>
            {tabProviders.map((provider) => (
              <button
                key={provider}
                type="button"
                onClick={() => onSelectProvider(provider)}
                className={endpointTabClass(selectedProvider === provider)}
              >
                {providerCatalog.label(provider)}
              </button>
            ))}
            {rest.length > (selectedFromRest ? 1 : 0) && (
              <Popover
                open={searchOpen}
                onOpenChange={(open) => {
                  setSearchOpen(open);
                  if (!open) setSearch("");
                }}
              >
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label="More providers"
                    className={endpointTabClass(false)}
                  >
                    …
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-64 p-0" align="start">
                  <Command shouldFilter={false}>
                    <CommandInput
                      value={search}
                      onValueChange={setSearch}
                      placeholder="Search providers..."
                    />
                    <CommandList>
                      <CommandEmpty>No providers found.</CommandEmpty>
                      <CommandGroup>
                        {searchResults.map((provider) => (
                          <CommandItem
                            key={provider}
                            value={provider}
                            onSelect={() => {
                              onSelectProvider(provider);
                              setSearchOpen(false);
                              setSearch("");
                            }}
                          >
                            {providerCatalog.label(provider)}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            )}
          </div>
        }
      />
    </div>
  );
}

// =========================================================================
// Authentication overview
// =========================================================================

function AuthenticationOverview() {
  const [createKeyType, setCreateKeyType] = useState<VirtualKeyType | null>(
    null,
  );
  const [oauthCreateOpen, setOauthCreateOpen] = useState(false);

  const { data: canCreateKey } = useHasPermissions({
    llmVirtualKey: ["create"],
  });
  const { data: canReadKeys } = useHasPermissions({
    llmVirtualKey: ["read"],
  });
  const { data: canCreateOauth } = useHasPermissions({
    llmOauthClient: ["create"],
  });
  const { data: canReadOauth } = useHasPermissions({
    llmOauthClient: ["read"],
  });

  return (
    <section className="rounded-lg border bg-card p-4">
      <h3 className="text-sm font-semibold">Authentication</h3>
      <div className="mt-1 divide-y">
        <AuthMethodRow
          title="Standard virtual keys"
          description="One key that authenticates your app; the proxy maps it to your provider keys on each request."
          action={
            canCreateKey ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCreateKeyType("standard")}
              >
                Create standard virtual key
              </Button>
            ) : null
          }
          manageHref={
            canReadKeys ? "/llm/proxy/virtual-keys?keyType=standard" : null
          }
          manageLabel="Manage standard virtual keys"
        />

        <AuthMethodRow
          title="Passthrough"
          description="You send your own provider key or subscription token; the proxy forwards it unchanged. A passthrough virtual key grants no access: it only attributes those requests to a user."
          action={
            canCreateKey ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCreateKeyType("passthrough")}
              >
                Create passthrough virtual key
              </Button>
            ) : null
          }
          manageHref={
            canReadKeys ? "/llm/proxy/virtual-keys?keyType=passthrough" : null
          }
          manageLabel="Manage passthrough virtual keys"
        >
          <TerminalBlock
            rows={[
              {
                comment: "optional: link the request to a user",
                code: "X-Archestra-Virtual-Key: arch_<passthrough-key>",
              },
            ]}
          />
        </AuthMethodRow>

        <AuthMethodRow
          title="OAuth clients"
          description="Register apps that call the proxy as themselves or for signed-in users."
          action={
            canCreateOauth ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setOauthCreateOpen(true)}
              >
                Create OAuth client
              </Button>
            ) : null
          }
          manageHref={canReadOauth ? "/settings/oauth-clients?type=llm" : null}
          manageLabel="Manage OAuth clients"
        />

        <IdentityProviderRow />
      </div>

      <CreateVirtualKeyDialogWithData
        open={createKeyType !== null}
        onOpenChange={(open) => {
          if (!open) setCreateKeyType(null);
        }}
        keyType={createKeyType ?? "standard"}
      />
      <OauthClientCreateFlow
        open={oauthCreateOpen}
        onOpenChange={setOauthCreateOpen}
      />
    </section>
  );
}

/**
 * IdP status plus the admin control for it. The identity-provider roster is an
 * enterprise feature — `useIdentityProviders` stays disabled without it, so
 * the select is hidden and the section reads as status only.
 */
function IdentityProviderRow() {
  const { data: proxy } = useLlmProxy();
  const { data: identityProviders } = useIdentityProviders();
  const { data: canUpdate } = useHasPermissions({ llmProxy: ["update"] });
  const updateProxy = useUpdateLlmProxy();

  const idpId = proxy?.identityProviderId ?? null;
  const idpName = identityProviders?.find((idp) => idp.id === idpId)?.issuer;
  const orgHasIdps = (identityProviders?.length ?? 0) > 0;

  return (
    <AuthMethodRow
      title="Identity provider"
      description="Use a JWT from your identity provider. Requests are linked to the user in the token and use that user's access."
      action={
        !canUpdate ? null : orgHasIdps ? (
          <div className="w-full space-y-1 sm:w-72">
            <Select
              value={idpId ?? "none"}
              disabled={updateProxy.isPending}
              onValueChange={(value) =>
                updateProxy.mutate({
                  identityProviderId: value === "none" ? null : value,
                })
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="No Identity Provider selected" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No Identity Provider</SelectItem>
                {identityProviders?.map((provider) => (
                  <SelectItem key={provider.id} value={provider.id}>
                    {provider.providerId} ({provider.issuer})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground sm:text-right">
              The OIDC identity provider the proxy trusts for JWT
              authentication.
            </p>
          </div>
        ) : (
          <Button variant="outline" size="sm" asChild>
            <Link href="/settings/identity-providers">
              Set up identity providers
            </Link>
          </Button>
        )
      }
    >
      <p className="text-xs">
        {idpId ? (
          <span className="text-green-600 dark:text-green-500">
            {idpName ?? "Identity provider"} is configured
          </span>
        ) : (
          <span className="text-muted-foreground">Not configured</span>
        )}
      </p>
    </AuthMethodRow>
  );
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

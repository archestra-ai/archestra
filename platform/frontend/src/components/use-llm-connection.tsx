"use client";

import {
  type archestraApiTypes,
  isModelRouterSupportedProvider,
  LLM_PROXY_OAUTH_SCOPE,
  PROVIDERS_REQUIRING_BASE_URL,
  type SupportedProvider,
} from "@archestra/shared";
import { useState } from "react";
import type { ProxyEndpointProvider } from "@/app/connection/connection-flow.utils";
import { PoolProviders } from "@/app/llm/model-pools/_parts/pool-providers";
import type {
  CreatedVirtualKey,
  VirtualKeyType,
} from "@/components/create-virtual-key-dialog";
import { poolAnswers } from "@/components/credential-billing/model-pool-access";
import { primaryKeyMappings } from "@/components/credential-billing/provider-key-data";
import type { ProviderApiKeyMappings } from "@/components/provider-key-mappings-field";
import type { RevealableSecret } from "@/components/virtual-key-connection-guide";
import type {
  RequestCredential,
  RequestTarget,
} from "@/components/virtual-key-request-example";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useAutoRouters } from "@/lib/auto-routing.query";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { useLlmProxy } from "@/lib/llm-proxy.query";
import { type ModelPool, useModelPools } from "@/lib/model-pools.query";
import { useOauthClients } from "@/lib/oauth-clients.query";
import { useOrganization } from "@/lib/organization.query";
import {
  useAllVirtualApiKeys,
  useFetchVirtualApiKeyValue,
} from "@/lib/virtual-api-keys.query";

type LlmOauthClient =
  archestraApiTypes.GetOauthClientsResponses["200"]["data"][number];
type NamedProviderMapping = ProviderApiKeyMappings[number] & {
  providerApiKeyName: string;
};

/** How callers authenticate to the LLM Proxy. */
export type LlmAuthMethod = "standard" | "passthrough" | "oauth" | "idp";

/**
 * What a request to one endpoint with one auth method needs: the provider
 * keys behind the endpoint, the credentials that can reach it (the reader's
 * own first), the one picked, and the props of the request built from them.
 * Shared by the connect steps and the LLM Proxy page's endpoint card, which
 * lay the same choices out differently.
 */
export function useLlmConnection({
  selected,
  auth,
  pool,
  offerAutoModel = false,
}: {
  selected: "model-router" | ProxyEndpointProvider;
  auth: LlmAuthMethod;
  /** Connect to this one pool: only the keys that can call it. */
  pool?: ModelPool;
  /** Offer the auto routers the picked credential can call. */
  offerAutoModel?: boolean;
}) {
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
  const { data: llmOauthClients } = useOauthClients({
    limit: 100,
    capability: LLM_PROXY_OAUTH_SCOPE,
    enabled: auth === "oauth",
    toastOnError: false,
  });
  const oauthClients: LlmOauthClient[] = llmOauthClients?.data ?? [];
  const { data: session } = useSession();
  const { data: canCreateKey } = useHasPermissions({
    llmVirtualKey: ["create"],
  });
  const { data: canCreateOauth } = useHasPermissions({
    oauthClient: ["create"],
  });
  const { data: proxy } = useLlmProxy();

  const [createKeyType, setCreateKeyType] = useState<VirtualKeyType | null>(
    null,
  );
  const [oauthCreateOpen, setOauthCreateOpen] = useState(false);
  const [addProviderKeyOpen, setAddProviderKeyOpen] = useState(false);
  const [created, setCreated] = useState<CreatedVirtualKey | null>(null);
  // undefined: nothing picked yet; null: "None" picked.
  const [pickedId, setPickedId] = useState<string | null | undefined>();
  // The request remounts with each key; the model picked survives it.
  const [pickedModel, setPickedModel] = useState<string>();

  // A standard key or OAuth client is usable here only if it maps a provider
  // key behind this endpoint; a passthrough key carries none and always fits.
  const reaches = (credential: { providerApiKeys: ProviderApiKeyMappings }) =>
    credential.providerApiKeys.some((mapping) =>
      servesTarget(mapping.provider),
    );
  // A virtual key calls a pool only once the pool was added to it.
  const callsPool = (key: { id: string }, target: ModelPool) =>
    target.virtualApiKeyIds.includes(key.id);
  // Pools are asked for by name on the Unified Model API.
  const { data: canReadPools } = useHasPermissions({ llmModel: ["read"] });
  const offersPools =
    canReadPools === true &&
    (auth === "standard" || auth === "oauth") &&
    isRouter;
  const { data: pools = [], isFetching: poolsFetching } = useModelPools({
    enabled: offersPools,
    toastOnError: false,
  });
  const poolsOf = (key: { id: string }) =>
    offersPools ? pools.filter((candidate) => callsPool(key, candidate)) : [];
  // Only a client calling as the app takes pools, and only those added to it.
  const takesPools = (client: LlmOauthClient) =>
    client.grantType === "client_credentials";
  const clientPoolsOf = (client: LlmOauthClient) =>
    offersPools && takesPools(client)
      ? pools.filter((candidate) => client.modelPoolIds.includes(candidate.id))
      : [];
  // Auto routers are asked for by name on the Unified Model API too, and
  // answer on their own provider keys.
  const offersRouters =
    offerAutoModel &&
    (auth === "standard" || auth === "oauth") &&
    isRouter &&
    !pool;
  const { data: routers = [], isFetching: routersFetching } = useAutoRouters({
    enabled: offersRouters,
  });
  const hasRouter = (key: { id: string }) =>
    offersRouters &&
    routers.some((router) => router.virtualApiKeyIds.includes(key.id));
  const clientHasRouter = (client: LlmOauthClient) =>
    offersRouters &&
    takesPools(client) &&
    routers.some((router) => client.autoRouterIds.includes(router.id));
  // The list API returns explicit mappings. Resolve automatic access for
  // the endpoint picker just as the proxy does, keeping explicit overrides.
  const withSharedPrimaries = (
    mappings: NamedProviderMapping[],
    includeFutureProviders: boolean,
  ): NamedProviderMapping[] => {
    if (!includeFutureProviders) return mappings;
    const explicitProviders = new Set(
      mappings.map((mapping) => mapping.provider),
    );
    return [
      ...mappings,
      ...targetProviderKeys
        .filter(
          (key) =>
            key.isPrimary &&
            key.userId === null &&
            !key.subscriptionKind &&
            !key.requiresReauthentication &&
            (!PROVIDERS_REQUIRING_BASE_URL.has(key.provider) ||
              !!key.baseUrl?.trim()) &&
            !explicitProviders.has(key.provider),
        )
        .map((key) => ({
          provider: key.provider,
          providerApiKeyId: key.id,
          providerApiKeyName: key.name,
        })),
    ];
  };
  const keyMappings = (key: {
    providerApiKeys: NamedProviderMapping[];
    includeFutureProviders?: boolean;
  }) =>
    withSharedPrimaries(
      key.providerApiKeys,
      key.includeFutureProviders === true,
    );
  // A credential with a pool or auto router added still fits the Unified
  // Model API when it cannot call a provider directly.
  const keyOptions = (virtualKeys?.data ?? []).filter((key) =>
    pool
      ? callsPool(key, pool)
      : auth === "passthrough" ||
        reaches({ providerApiKeys: keyMappings(key) }) ||
        poolsOf(key).length > 0 ||
        hasRouter(key),
  );
  const clientOptions = oauthClients.filter(
    (client) =>
      reaches(client) ||
      clientPoolsOf(client).length > 0 ||
      clientHasRouter(client),
  );
  const credentialSummary = (
    credential: { providerApiKeys: ProviderApiKeyMappings },
    poolCount: number,
    allProviders = false,
  ) => {
    const providers = new Set(
      credential.providerApiKeys.map((mapping) => mapping.provider),
    ).size;
    return [
      allProviders
        ? "All providers"
        : `${providers} ${providers === 1 ? "provider" : "providers"}`,
      `${poolCount} ${poolCount === 1 ? "pool" : "pools"}`,
    ].join(" · ");
  };
  const keySummary = (key: (typeof keyOptions)[number]) =>
    offersPools
      ? credentialSummary(key, poolsOf(key).length, key.includeFutureProviders)
      : undefined;
  const clientSummary = (client: LlmOauthClient) =>
    offersPools && takesPools(client)
      ? credentialSummary(client, clientPoolsOf(client).length)
      : undefined;
  const allOptions =
    auth === "oauth"
      ? clientOptions.map((client) => ({
          id: client.id,
          authorId: client.authorId,
          tokenStart: null,
          name: client.name,
          label: client.name,
          description: clientSummary(client),
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
          description: keySummary(key),
          mappings: keyMappings(key),
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
  const createdWithoutEndpointAccess =
    created &&
    created.id === pickedId &&
    virtualKeys?.data.some((key) => key.id === created.id) &&
    !providerKeysPending &&
    !poolsFetching &&
    !routersFetching &&
    !options.some((option) => option.id === created.id)
      ? created.name
      : null;
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
              ? (createdHere.value ?? null)
              : await fetchKeyValue.mutateAsync(picked.id),
          revealed,
          onRevealedChange: setRevealed,
        }
      : undefined;
  const pickKey = (id: string | null) => {
    setPickedId(id);
    setRevealed(null);
  };

  // Pool grants authorize their member keys independently of which provider
  // keys the viewer can read directly.
  const hasUsablePoolGrant =
    auth === "standard"
      ? keyOptions.some((key) => poolsOf(key).some(poolAnswers))
      : auth === "oauth"
        ? clientOptions.some((client) =>
            clientPoolsOf(client).some(poolAnswers),
          )
        : false;
  // Likewise an auto router answers on its tiers' own keys.
  const hasRouterGrant =
    auth === "standard"
      ? keyOptions.some(hasRouter)
      : auth === "oauth" && clientOptions.some(clientHasRouter);
  const hasProviderKey =
    !!pool ||
    targetProviderKeys.length > 0 ||
    hasUsablePoolGrant ||
    hasRouterGrant;
  // A new key starts with the primary key of each provider this target
  // serves; the create dialog shows and changes them.
  const primaryKeyPerProvider = primaryKeyMappings(targetProviderKeys);

  const target: RequestTarget = isRouter
    ? { kind: "model-router" }
    : { kind: "provider", provider: selected };

  const pickedKey =
    auth === "standard"
      ? keyOptions.find((key) => key.id === picked?.id)
      : undefined;
  const pickedClient =
    auth === "oauth"
      ? clientOptions.find((client) => client.id === picked?.id)
      : undefined;
  const pickedPools = pickedKey
    ? poolsOf(pickedKey)
    : pickedClient
      ? clientPoolsOf(pickedClient)
      : [];
  // The request offers only the pools the picked key or client can call, and
  // only those with a member that can answer.
  const requestPools = pickedPools.filter(poolAnswers).map((entry) => ({
    name: entry.name,
    description: <PoolProviders pool={entry} />,
  }));
  // Only a client calling as the app takes auto routers, like pools.
  const routerClient =
    pickedClient && takesPools(pickedClient) ? pickedClient : undefined;

  let credential: RequestCredential;
  let credentialEnvVar: string;
  let ready: boolean;
  let mappedProviderKeys: NamedProviderMapping[] = [];
  if (auth === "standard") {
    credential = "standard";
    credentialEnvVar = "ARCHESTRA_LLM_VIRTUAL_KEY";
    ready = hasProviderKey && !!picked;
    mappedProviderKeys = picked?.mappings ?? [];
  } else if (auth === "passthrough") {
    credential = "passthrough";
    credentialEnvVar = "ARCHESTRA_LLM_VIRTUAL_KEY";
    // Requests need a passthrough key unless the org allows unauthenticated
    // LLM proxy requests.
    ready = allowsUnauthenticated || !!picked;
  } else if (auth === "oauth") {
    credential = "token";
    credentialEnvVar = "ARCHESTRA_LLM_ACCESS_TOKEN";
    ready = hasProviderKey && !!picked;
    mappedProviderKeys = picked?.mappings ?? [];
    if (
      pickedClient?.grantType === "client_credentials" &&
      pickedClient.includeFutureProviders &&
      pickedClient.scopes.includes(LLM_PROXY_OAUTH_SCOPE)
    ) {
      mappedProviderKeys = withSharedPrimaries(mappedProviderKeys, true);
    }
  } else {
    credential = "token";
    credentialEnvVar = "ARCHESTRA_LLM_IDP_TOKEN";
    ready = hasProviderKey && !!proxy?.identityProviderId;
  }

  /** Everything the request example needs but its layout. */
  const requestProps = {
    target,
    keyType: credential,
    secret,
    // Passthrough with "None": the request carries only the provider key.
    keyValue: auth === "passthrough" && !picked ? "" : undefined,
    credentialEnvVar,
    routerProviders:
      // App clients cannot borrow provider access from the viewer's catalog.
      mappedProviderKeys.length > 0 ||
      (pickedClient && takesPools(pickedClient))
        ? mappedProviderKeys
            .map((mapping) => mapping.provider)
            .filter(isModelRouterSupportedProvider)
        : targetProviderKeys
            .map((key) => key.provider)
            .filter(isModelRouterSupportedProvider),
    mappedProviderKeys,
    fixedModel: pool?.name,
    pools: pool ? [] : requestPools,
    initialModel: pickedModel,
    onModelChange: setPickedModel,
    offerAutoModel: offerAutoModel && isRouter && !pool,
    virtualApiKeyId: pickedKey?.id,
    grantedRouterIds: routerClient?.autoRouterIds,
  };
  // The request remounts with each credential, and when the key becomes
  // readable.
  const requestKey = `${picked?.id ?? "none"}:${secret ? "secret" : "env"}`;

  return {
    isRouter,
    servesTarget,
    targetProviderKeys,
    providerKeysPending,
    hasProviderKey,
    allowsUnauthenticated,
    canManageLlmSettings: !!canManageLlmSettings,
    canCreateKey: !!canCreateKey,
    canCreateOauth: !!canCreateOauth,
    options,
    picked,
    createdWithoutEndpointAccess,
    pickKey,
    pickedKey,
    pickedClient,
    pickedPools,
    routerClient,
    takesPools,
    offersPools,
    offersRouters,
    isVirtualKey,
    secret,
    ready,
    requestProps,
    requestKey,
    primaryKeyPerProvider,
    createKeyType,
    setCreateKeyType,
    oauthCreateOpen,
    setOauthCreateOpen,
    addProviderKeyOpen,
    setAddProviderKeyOpen,
    onKeyCreated: (key: CreatedVirtualKey) => {
      setCreated(key);
      pickKey(key.id);
    },
  };
}

export type LlmConnection = ReturnType<typeof useLlmConnection>;

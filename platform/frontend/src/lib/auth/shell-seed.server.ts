import {
  AGENT_OPTIONS_MAX_PAGE_SIZE,
  archestraApiSdk,
  type archestraApiTypes,
} from "@archestra/shared";
import { headers } from "next/headers";
import {
  CONNECT_CLIENTS,
  isInstallerClientId,
  visibleClients,
} from "@/app/connection/clients";
import {
  getConnectableProviders,
  resolveConnectionBaseUrl,
  resolveInitialClientId,
} from "@/app/connection/connection-flow.utils";
import {
  connectionSetupBody,
  connectionSetupInputsKey,
  connectionSetupKeyDigest,
  firstConnectionSetupInputs,
} from "@/app/connection/connection-setup-payload";
import {
  agentRunQueryKey,
  myAgentRunsPageQuery,
  myAgentRunsQueryKey,
  SIDEBAR_PINNED_RUNS,
  SIDEBAR_RECENT_RUNS,
} from "@/lib/agent-runs-query-keys";
import { appsQueryKey, SIDEBAR_PINNED_APPS_QUERY } from "@/lib/app.query";
import { authQueryKeys } from "@/lib/auth/auth.query";
import {
  isShellSeedRoute,
  SHELL_SEED_HEADER,
  SHELL_SEED_SEARCH_HEADER,
  seededConnectRequest,
  seededConversationId,
  seededRunId,
  seedsNewChatComposer,
} from "@/lib/auth/shell-seed";
import {
  conversationQueryKey,
  conversationsQueryKey,
  SIDEBAR_CONVERSATION_LIMIT,
} from "@/lib/chat/conversations-query-key";
import { newChatSeedQueries } from "@/lib/chat/new-chat-seed";
import {
  getBackendBaseUrl,
  getConfiguredExternalProxyUrls,
  getInternalProxyUrl,
} from "@/lib/config/config";
import { documentOriginQueryKey } from "@/lib/connection-approval-query-keys";
import {
  CONNECTION_GATEWAY_PAGE_QUERY,
  CONNECTION_GATEWAY_REFERENCE_FILTERS,
  type ConnectionSetupSeed,
  connectionApprovalSeedQueries,
} from "@/lib/connection-approval-seed";
import { environmentKeys } from "@/lib/environment.query";
import { guardrailsDeploymentQueryKey } from "@/lib/guardrails-deployment.query";
import { mcpRegistryIssueIndexQueryKey } from "@/lib/mcp/mcp-registry.query";
import {
  projectListQueryKey,
  SIDEBAR_PINNED_PROJECTS_QUERY,
} from "@/lib/projects/projects.query";
import { originFromHeaders, originSchemeKnown } from "@/lib/request-origin";
import { siteNotificationKeys } from "@/lib/site-notification.query";
import { getServerApiHeaders } from "@/lib/utils/server";
import { withServerSeedDeadline } from "@/lib/utils/server-seed-timeout";

/**
 * What the signed-in shell waits on before it renders a page: the session and
 * the bootstrap (permissions, scoped capabilities, config, organization).
 */
export type ShellSeed = {
  session: { user: unknown; session: Record<string, unknown> };
  bootstrap: archestraApiTypes.GetBootstrapResponses["200"];
  /**
   * Other shell data the page's first render shows: the site notification,
   * the sidebar's conversations, pinned projects and pinned apps, its
   * warnings, and on the registry the issue index its badge reads.
   */
  queries: Array<{ queryKey: readonly unknown[]; data: unknown }>;
};

/**
 * The shell's session and bootstrap, resolved on the server for the documents
 * the proxy marks (pages whose first rows are server-rendered), so the auth
 * and permission gates let that page render into the HTML. Null otherwise,
 * and for a visitor who is not signed in or any failure: the shell then
 * resolves in the browser exactly as before. The session keeps only the
 * fields the app reads: the token never lands in the HTML.
 */
export async function prefetchShellSeed(): Promise<ShellSeed | null> {
  const requestHeaders = await headers();
  const route = requestHeaders.get(SHELL_SEED_HEADER);
  const search = requestHeaders.get(SHELL_SEED_SEARCH_HEADER);
  if (!isShellSeedRoute(route, search)) return null;
  try {
    const apiHeaders = await getServerApiHeaders();
    const [session, bootstrap, queries] = await withServerSeedDeadline(
      (signal) => {
        const bootstrapRead = archestraApiSdk.getBootstrap({
          headers: apiHeaders,
          signal,
        });
        return Promise.all([
          fetch(`${getBackendBaseUrl()}/api/auth/get-session`, {
            headers: apiHeaders,
            cache: "no-store",
            signal,
          }).then((response) =>
            response.ok
              ? (response.json() as Promise<ShellSeed["session"] | null>)
              : null,
          ),
          bootstrapRead,
          readShellQueries({
            route,
            search,
            // The origin the browser shows, when the headers say its scheme;
            // without it the document prepares no setup.
            origin: originSchemeKnown(requestHeaders)
              ? originFromHeaders(requestHeaders)
              : null,
            // A speculative load (prefetch or prerender) nobody may see:
            // it reads, but prepares no setup.
            speculative: !!(
              requestHeaders.get("sec-purpose") ?? requestHeaders.get("purpose")
            ),
            headers: apiHeaders,
            signal,
            bootstrap: bootstrapRead,
          }),
        ]);
      },
    );
    if (!bootstrap.data) return null;
    if (!session?.user || !session.session) return null;
    return {
      session: { ...session, session: pickSeedSessionFields(session.session) },
      bootstrap: bootstrap.data,
      queries,
    };
  } catch {
    return null;
  }
}

// ===

/**
 * The reads whose data the first render shows, each under the key its query
 * uses.
 * A read the viewer may not make (a 403) or that fails is left out, and its
 * query loads in the browser as before.
 */
async function readShellQueries(params: {
  route: string | null;
  search: string | null;
  origin: string | null;
  speculative: boolean;
  headers: Record<string, string>;
  signal: AbortSignal;
  bootstrap: Promise<{ data?: ShellSeed["bootstrap"] }>;
}): Promise<ShellSeed["queries"]> {
  const options = { headers: params.headers, signal: params.signal };
  const reads: Array<
    Promise<{ queryKey: readonly unknown[]; data: unknown } | null>
  > = [
    seedRead(
      siteNotificationKeys.active(),
      archestraApiSdk.getSiteNotification(options),
    ),
    seedRead(
      conversationsQueryKey(),
      archestraApiSdk.getChatConversations({
        ...options,
        query: { includeArtifacts: false, limit: SIDEBAR_CONVERSATION_LIMIT },
      }),
    ),
    seedRead(
      projectListQueryKey(SIDEBAR_PINNED_PROJECTS_QUERY),
      archestraApiSdk.getProjects({
        ...options,
        query: SIDEBAR_PINNED_PROJECTS_QUERY,
      }),
    ),
    seedRead(
      appsQueryKey(SIDEBAR_PINNED_APPS_QUERY),
      archestraApiSdk.getApps({ ...options, query: SIDEBAR_PINNED_APPS_QUERY }),
    ),
    seedRead(
      authQueryKeys.defaultCredentialsEnabled(),
      archestraApiSdk.getDefaultCredentialsStatus(options),
      (data) => data?.enabled ?? false,
    ),
    seedRead(
      environmentKeys.k8sCapabilities(),
      archestraApiSdk.getK8sCapabilities(options),
    ),
  ];
  const runId = seededRunId(params.route);
  if (runId) {
    reads.push(
      seedRead(
        agentRunQueryKey(runId),
        archestraApiSdk.getMyAgentRun({ ...options, path: { taskId: runId } }),
      ),
    );
  }
  if (params.route === "/mcp/registry") {
    reads.push(
      seedRead(
        mcpRegistryIssueIndexQueryKey,
        archestraApiSdk.getMcpRegistryIssueIndex(options),
      ),
    );
  }
  // The composer (and an existing conversation's end): one read.
  const conversationId = seededConversationId(params.route);
  const composer = conversationId
    ? readConversation({ ...options, conversationId })
    : params.route === "/chat" && seedsNewChatComposer(params.search)
      ? readNewChatComposer(options)
      : Promise.resolve([]);
  // The connection approval page: everything it reads before its final state.
  const connectRequest = seededConnectRequest(params.route, params.search);
  const approval = connectRequest
    ? readConnectionApproval({
        ...options,
        connectRequest,
        search: params.search,
        bootstrap: params.bootstrap,
        origin: params.speculative ? null : params.origin,
      })
    : Promise.resolve([]);
  const [shell, composerQueries, runs, guardrails, approvalQueries] =
    await Promise.all([
      Promise.all(reads),
      composer,
      readSidebarRuns({ ...options, bootstrap: params.bootstrap }),
      readGuardrailsDeployment({ ...options, bootstrap: params.bootstrap }),
      approval,
    ]);
  return [
    ...shell.filter((entry) => entry !== null),
    ...runs,
    ...guardrails,
    ...composerQueries,
    ...approvalQueries,
  ];
}

/**
 * The connection approval page's reads, each from its own endpoint, in
 * parallel and alongside the bootstrap: the installer's request, the default
 * gateway and the gateway list, the LLM Proxy, the skill names, the plugins,
 * the provider keys and the models. The organization's connection settings
 * (in the bootstrap) say which of the optional parts the page shows. The
 * gateways the page names by id are read once the default gateway and the
 * admin default are known. A part the viewer may not
 * read is left out, and its query loads in the browser.
 */
async function readConnectionApproval(options: {
  headers: Record<string, string>;
  signal: AbortSignal;
  connectRequest: string;
  search: string | null;
  bootstrap: Promise<{ data?: ShellSeed["bootstrap"] }>;
  /** The document's public origin; null prepares no setup. */
  origin: string | null;
}): Promise<ShellSeed["queries"]> {
  const sdk = { headers: options.headers, signal: options.signal };
  // The organization's settings choose the optional parts and name the admin
  // default gateway; the other reads start alongside the bootstrap.
  const organizationRead = options.bootstrap
    .then(({ data }) => data?.organization)
    .catch(() => undefined);
  const urlGatewayId = new URLSearchParams(options.search ?? "").get(
    "gatewayId",
  );
  const defaultGatewayRead = readValue(
    archestraApiSdk.getDefaultMcpGateway({
      ...sdk,
      query: { includeTools: false },
    }),
  );
  const referencesRead = Promise.all([
    defaultGatewayRead,
    organizationRead,
  ]).then(async ([defaultGateway, organization]) => {
    if (!organization) return undefined;
    const ids = [
      ...new Set(
        [
          urlGatewayId,
          organization.connectionDefaultMcpGatewayId,
          defaultGateway?.id,
        ].filter((id): id is string => !!id),
      ),
    ].sort();
    if (ids.length === 0) return undefined;
    const page = await readValue(
      archestraApiSdk.getAgentOptions({
        ...sdk,
        query: {
          ...CONNECTION_GATEWAY_REFERENCE_FILTERS,
          ids,
          limit: AGENT_OPTIONS_MAX_PAGE_SIZE,
        },
      }),
    );
    return page ? { ids, options: page.data } : undefined;
  });
  const [
    request,
    defaultGateway,
    gatewayReferences,
    gatewayPage,
    llmProxy,
    skillNames,
    plugins,
    availableApiKeys,
    models,
    organization,
  ] = await Promise.all([
    readValue(
      archestraApiSdk.getClientConnection({
        ...sdk,
        path: { id: options.connectRequest },
      }),
    ),
    defaultGatewayRead,
    referencesRead,
    readValue(
      archestraApiSdk.getAgentOptionsPage({
        ...sdk,
        query: CONNECTION_GATEWAY_PAGE_QUERY,
      }),
    ),
    organizationRead.then((organization) =>
      organization?.connectionLlmProxyEnabled
        ? readValue(archestraApiSdk.getLlmProxy(sdk))
        : undefined,
    ),
    organizationRead.then((organization) =>
      organization?.connectionSkillsEnabled
        ? readValue(archestraApiSdk.getSkillNames(sdk))
        : undefined,
    ),
    organizationRead.then((organization) =>
      organization?.connectionPluginsEnabled
        ? readValue(archestraApiSdk.getPlugins({ ...sdk, query: {} }))
        : undefined,
    ),
    readValue(archestraApiSdk.getAvailableLlmProviderApiKeys(sdk)),
    readValue(archestraApiSdk.getLlmModels(sdk)),
    organizationRead,
  ]);
  // Without the organization the page cannot render past its settings check.
  if (!organization) return [];
  const setup = await prepareFirstSetup({
    ...sdk,
    search: options.search,
    origin: options.origin,
    bootstrap: await options.bootstrap.then(({ data }) => data),
    request,
    defaultGateway,
    gatewayPage,
    gatewayReferences,
    llmProxy,
    skillNames,
    plugins,
    availableApiKeys,
  });
  const queries = connectionApprovalSeedQueries({
    connectRequest: options.connectRequest,
    request,
    defaultGateway,
    gatewayPage,
    gatewayReferences,
    llmProxy,
    skillNames,
    plugins,
    availableApiKeys,
    models,
    setup,
  });
  return options.origin
    ? [...queries, { queryKey: documentOriginQueryKey, data: options.origin }]
    : queries;
}

/**
 * Prepare the approval page's first setup with the document. The page
 * creates one setup per load without any user action; preparing it here
 * moves that request into the document, so Approve is ready at first paint.
 * The payload is the one the page would send first (the same key, see
 * `firstConnectionSetupInputs`); the page keeps the seeded setup only while
 * its own payload has that key, so a load still prepares exactly one setup.
 * Only its id is seeded: the setup's command carries a one-time token.
 */
async function prepareFirstSetup(params: {
  headers: Record<string, string>;
  signal: AbortSignal;
  search: string | null;
  origin: string | null;
  bootstrap: ShellSeed["bootstrap"] | undefined;
  request: archestraApiTypes.GetClientConnectionResponses["200"] | undefined;
  defaultGateway:
    | archestraApiTypes.GetDefaultMcpGatewayResponses["200"]
    | null
    | undefined;
  gatewayPage:
    | archestraApiTypes.GetAgentOptionsPageResponses["200"]
    | undefined;
  gatewayReferences:
    | { options: archestraApiTypes.GetAgentOptionsResponses["200"]["data"] }
    | undefined;
  llmProxy: archestraApiTypes.GetLlmProxyResponses["200"] | null | undefined;
  skillNames: archestraApiTypes.GetSkillNamesResponses["200"] | undefined;
  plugins: archestraApiTypes.GetPluginsResponses["200"] | undefined;
  availableApiKeys:
    | archestraApiTypes.GetAvailableLlmProviderApiKeysResponses["200"]
    | undefined;
}): Promise<ConnectionSetupSeed | undefined> {
  const organization = params.bootstrap?.organization;
  if (!params.origin || !organization || !params.request) return undefined;
  const query = new URLSearchParams(params.search ?? "");
  const clientId = resolveInitialClientId({
    urlClientId: query.get("clientId"),
    adminDefaultClientId: organization.connectionDefaultClientId,
    visibleClientIds: visibleClients(organization.connectionShownClientIds).map(
      (client) => client.id,
    ),
  });
  const client = CONNECT_CLIENTS.find((c) => c.id === clientId);
  // The page approves only a request for the client it shows.
  if (
    !client ||
    !isInstallerClientId(client.id) ||
    params.request.clientId !== client.id
  ) {
    return undefined;
  }
  // The gateway list as the page merges it: the first page, then the
  // gateways it names by id.
  const gateways = [
    ...new Map(
      [
        ...(params.gatewayPage?.data ?? []),
        ...(params.gatewayReferences?.options ?? []),
      ].map((gateway) => [gateway.id, gateway]),
    ).values(),
  ];
  const external = getConfiguredExternalProxyUrls();
  const inputs = firstConnectionSetupInputs({
    client,
    requestedPlatform: query.get("platform"),
    baseUrl: resolveConnectionBaseUrl({
      externalProxyUrls:
        external.length > 0 ? external : [`${params.origin}/v1`],
      internalProxyUrl: getInternalProxyUrl(),
      metadata: organization.connectionBaseUrls,
    }),
    urlGatewayId: query.get("gatewayId"),
    urlProviderId: query.get("providerId"),
    organization,
    shownProviders: getConnectableProviders(organization),
    permissions: params.bootstrap?.permissions ?? {},
    scopedCapabilities: params.bootstrap?.scopedCapabilities ?? [],
    request: params.request,
    defaultGatewayId: params.defaultGateway?.id ?? null,
    gateways,
    llmProxyId: params.llmProxy?.id ?? null,
    skillNames: params.skillNames ?? null,
    plugins: params.plugins ?? null,
    availableKeys: params.availableApiKeys ?? null,
  });
  if (!inputs) return undefined;
  const inputsKey = connectionSetupInputsKey(inputs);
  const body = connectionSetupBody(inputsKey);
  if (!body) return undefined;
  const created = await readValue(
    archestraApiSdk.createConnectionSetup({
      // The backend accepts a base URL on the origin that asks, as it does
      // for the browser's own request, which carries its Origin too.
      headers: { ...params.headers, Origin: params.origin },
      signal: params.signal,
      body,
    }),
  );
  if (!created) return undefined;
  return {
    keyDigest: connectionSetupKeyDigest(inputsKey),
    id: created.id,
    ...(created.creditWarning ? { creditWarning: created.creditWarning } : {}),
  };
}

/**
 * The sidebar's recent and pinned Agent Runtime runs, each as the first page
 * of its list. Read only once the bootstrap says the deployment runs agents:
 * otherwise the sidebar shows no runs and their endpoint is not served.
 */
async function readSidebarRuns(options: {
  headers: Record<string, string>;
  signal: AbortSignal;
  bootstrap: Promise<{ data?: ShellSeed["bootstrap"] }>;
}): Promise<ShellSeed["queries"]> {
  const { data: bootstrap } = await options.bootstrap.catch(() => ({
    data: undefined,
  }));
  if (!bootstrap?.config?.features?.agentRuntime) return [];
  const lists = await Promise.all(
    [SIDEBAR_RECENT_RUNS, SIDEBAR_PINNED_RUNS].map((list) =>
      seedRead(
        myAgentRunsQueryKey(list),
        archestraApiSdk.getMyAgentRuns({
          headers: options.headers,
          signal: options.signal,
          query: myAgentRunsPageQuery(list, 0),
        }),
        // An infinite query's cache entry: its pages and their offsets.
        (page) => ({ pages: [page], pageParams: [0] }),
      ),
    ),
  );
  return lists.filter((entry) => entry !== null);
}

/**
 * The guardrails status the sidebar's warning row reads ("Guardrails
 * disabled"), so the row is in the HTML instead of appearing after the page
 * has drawn. Read only while OpenAPPA is on: otherwise nothing shows it.
 */
async function readGuardrailsDeployment(options: {
  headers: Record<string, string>;
  signal: AbortSignal;
  bootstrap: Promise<{ data?: ShellSeed["bootstrap"] }>;
}): Promise<ShellSeed["queries"]> {
  const { data: bootstrap } = await options.bootstrap.catch(() => ({
    data: undefined,
  }));
  if (!bootstrap?.config?.features?.openappaEnabled) return [];
  const entry = await seedRead(
    guardrailsDeploymentQueryKey,
    archestraApiSdk.getGuardrailsDeployment({
      headers: options.headers,
      signal: options.signal,
    }),
  );
  return entry ? [entry] : [];
}

/**
 * An existing conversation's first screen: its end (the last messages, with
 * the count of the earlier ones) and the composer's parts for its agent, from
 * one read. The rest of the history loads in the browser after paint. An
 * encrypted chat is left to the browser: only it holds the key.
 */
async function readConversation(options: {
  headers: Record<string, string>;
  signal: AbortSignal;
  conversationId: string;
}): Promise<ShellSeed["queries"]> {
  try {
    const { data, error } = await archestraApiSdk.getConversationBootstrap({
      headers: options.headers,
      signal: options.signal,
      path: { id: options.conversationId },
    });
    if (error || !data || data.conversation.encryptedChat) return [];
    return [
      {
        queryKey: conversationQueryKey(options.conversationId),
        data: data.conversation,
      },
      ...newChatSeedQueries(data.composer),
    ];
  } catch {
    return [];
  }
}

async function readNewChatComposer(options: {
  headers: Record<string, string>;
  signal: AbortSignal;
}): Promise<ShellSeed["queries"]> {
  try {
    const { data, error } = await archestraApiSdk.getNewChatBootstrap(options);
    return error || !data ? [] : newChatSeedQueries(data);
  } catch {
    return [];
  }
}

/** A read's data, or undefined when it failed or the viewer may not make it. */
async function readValue<T>(
  read: Promise<{ data?: T; error?: unknown }>,
): Promise<T | undefined> {
  try {
    const { data, error } = await read;
    return error ? undefined : data;
  } catch {
    return undefined;
  }
}

async function seedRead<T>(
  queryKey: readonly unknown[],
  read: Promise<{ data?: T; error?: unknown }>,
  select: (data: T) => unknown = (data) => data,
) {
  try {
    const { data, error } = await read;
    if (error || data === undefined) return null;
    return { queryKey, data: select(data) };
  } catch {
    return null;
  }
}

/**
 * The session fields the app reads, picked rather than the token removed, so
 * a field the auth library adds later never lands in the HTML unreviewed.
 */
const SEED_SESSION_FIELDS = [
  "id",
  "userId",
  "activeOrganizationId",
  "impersonatedBy",
  "createdAt",
  "updatedAt",
  "expiresAt",
] as const;

function pickSeedSessionFields(
  session: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    SEED_SESSION_FIELDS.filter((field) => field in session).map((field) => [
      field,
      session[field],
    ]),
  );
}

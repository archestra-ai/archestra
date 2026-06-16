import {
  DEFAULT_APP_NAME,
  providerDisplayNames,
  RouteId,
  type SupportedProvider,
  SupportedProvidersSchema,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { isRateLimited } from "@/agents/utils";
import { userHasPermission } from "@/auth";
import { CacheKey } from "@/cache-manager";
import config, { getConnectionBaseUrlSources } from "@/config";
import { withDbTransaction } from "@/database";
import {
  AgentModel,
  ConnectionSetupModel,
  MemberModel,
  OrganizationModel,
  SkillModel,
  SkillShareLinkModel,
  TeamModel,
  VirtualApiKeyModel,
} from "@/models";
import { CONNECTION_SETUP_TOKEN_TTL_MS } from "@/models/connection-setup";
import {
  ensureConnectionVirtualKey,
  readVirtualKeyValue,
} from "@/services/connection-setup";
import {
  buildSetupCommand,
  proxyBaseUrlToOrigin,
  renderSetupScript,
  type SetupScriptContext,
} from "@/services/connection-setup-script";
import { isReservedMarketplaceName } from "@/skills/marketplace/manifest";
import {
  ApiError,
  type ConnectionSetup,
  type ConnectionSetupClientId,
  ConnectionSetupClientIdSchema,
  ConnectionSetupProxyAuthSchema,
  constructResponseSchema,
  type Organization,
} from "@/types";
import {
  CONNECTION_SETUP_SCRIPT_PREFIX,
  SKILL_MARKETPLACE_PREFIX,
} from "../route-paths";
import { deriveMarketplaceName } from "../skill-share/skill-share.routes";

/** Providers each scriptable client can be wired to (mirrors the wizard UI). */
const CLIENT_SUPPORTED_PROVIDERS: Record<
  ConnectionSetupClientId,
  readonly SupportedProvider[]
> = {
  "claude-code": ["anthropic", "bedrock"],
  codex: ["openai"],
  cursor: ["openai"],
  "copilot-cli": [
    "openai",
    "azure",
    "openrouter",
    "vllm",
    "ollama",
    "groq",
    "mistral",
    "deepseek",
    "xai",
    "cerebras",
    "github-copilot",
  ],
};

const CreateConnectionSetupBodySchema = z.object({
  clientId: ConnectionSetupClientIdSchema,
  baseUrl: z.string().url().max(2048),
  mcpGatewayId: z.string().uuid().optional(),
  llmProxyId: z.string().uuid().optional(),
  provider: SupportedProvidersSchema.optional(),
  /** Passthrough by default; "virtual-key" auto-provisions a personal key. */
  proxyAuth: ConnectionSetupProxyAuthSchema.default("provider-key"),
  skills: z
    .object({
      skillIds: z.array(z.string().uuid()).min(1).max(200),
      ttlDays: z.number().int().positive().max(3650).nullable(),
    })
    .optional(),
});

const CreateConnectionSetupResponseSchema = z.object({
  id: z.string().uuid(),
  command: z.string(),
  expiresAt: z.date(),
  tokenStart: z.string(),
});

const connectionSetupRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.post(
    "/api/connection-setups",
    {
      schema: {
        operationId: RouteId.CreateConnectionSetup,
        description:
          "Persist /connection wizard selections and return a one-time `curl | bash` command. " +
          "The command's setup token is shown exactly once and expires after 15 minutes.",
        tags: ["Connection Setups"],
        body: CreateConnectionSetupBodySchema,
        response: constructResponseSchema(CreateConnectionSetupResponseSchema),
      },
    },
    async ({ body, organizationId, user }, reply) => {
      const {
        clientId,
        mcpGatewayId,
        llmProxyId,
        provider,
        proxyAuth,
        skills,
      } = body;
      const baseUrl = body.baseUrl.replace(/\/+$/, "");

      if (!mcpGatewayId && !llmProxyId && !skills) {
        throw new ApiError(
          400,
          "Select at least one of: MCP gateway, LLM proxy, or skills",
        );
      }
      if ((llmProxyId && !provider) || (provider && !llmProxyId)) {
        throw new ApiError(400, "llmProxyId and provider must be set together");
      }
      if (
        provider &&
        !CLIENT_SUPPORTED_PROVIDERS[clientId].includes(provider)
      ) {
        throw new ApiError(
          400,
          `${provider} is not supported for ${clientId} setups`,
        );
      }

      const organization = await OrganizationModel.getById(organizationId);
      if (!organization || !isAllowedBaseUrl({ baseUrl, organization })) {
        throw new ApiError(
          400,
          "baseUrl is not an allowed connection endpoint",
        );
      }

      if (mcpGatewayId) {
        await requireAgentAccess({
          agentId: mcpGatewayId,
          organizationId,
          userId: user.id,
          kind: "mcpGateway",
        });
      }

      let virtualApiKeyId: string | null = null;
      if (llmProxyId && provider) {
        await requireAgentAccess({
          agentId: llmProxyId,
          organizationId,
          userId: user.id,
          kind: "llmProxy",
        });
        // provider-key mode is passthrough: the script only rewires the base
        // URL, so there is nothing to provision.
        if (proxyAuth === "virtual-key") {
          // Minting a virtual key requires the same permission as the
          // dedicated create endpoint (RouteId.CreateVirtualApiKey).
          const canCreateVirtualKey = await userHasPermission(
            user.id,
            organizationId,
            "llmVirtualKey",
            "create",
          );
          if (!canCreateVirtualKey) {
            throw new ApiError(
              403,
              "You need llmVirtualKey:create permission to use a virtual key. Choose the provider-key option instead.",
            );
          }
          virtualApiKeyId = await ensureConnectionVirtualKey({
            organizationId,
            userId: user.id,
            userEmail: user.email,
            userTeamIds: await TeamModel.getUserTeamIds(user.id),
            provider,
            preferredProviderKeyId:
              organization.connectionDefaultProviderKeys?.[provider] ?? null,
          });
        }
      }

      if (skills) {
        await requireSkillAdmin({ userId: user.id, organizationId });
        await assertSkillsBelongToOrg({
          skillIds: skills.skillIds,
          organizationId,
        });
      }

      const { setup, rawToken } = await ConnectionSetupModel.create({
        organizationId,
        userId: user.id,
        clientId,
        baseUrl,
        mcpGatewayId: mcpGatewayId ?? null,
        llmProxyId: llmProxyId ?? null,
        provider: provider ?? null,
        proxyAuth,
        virtualApiKeyId,
        includeSkills: Boolean(skills),
        skillLinkTtlDays: skills?.ttlDays ?? null,
        skillIds: skills?.skillIds ?? [],
        expiresAt: new Date(Date.now() + CONNECTION_SETUP_TOKEN_TTL_MS),
      });

      return reply.send({
        id: setup.id,
        command: buildSetupCommand({
          origin: proxyBaseUrlToOrigin(baseUrl),
          rawToken,
        }),
        expiresAt: setup.expiresAt,
        tokenStart: setup.tokenStart,
      });
    },
  );

  fastify.get(
    `${CONNECTION_SETUP_SCRIPT_PREFIX}/:token`,
    {
      schema: {
        operationId: RouteId.GetConnectionSetupScript,
        description:
          "Serve the rendered one-time setup script for a connection setup. " +
          "Authenticates via the one-time token in the path; the token is " +
          "consumed atomically on the first successful render.",
        tags: ["Connection Setups"],
        params: z.object({ token: z.string().min(20).max(256) }),
        // no `response` schema: this endpoint returns text/plain bash, not
        // JSON. The global error handler still formats 4xx/5xx as JSON, and
        // the generated command uses `curl -f`, so error bodies are never
        // piped to bash.
      },
    },
    async (request, reply) => {
      const limited = await isRateLimited(
        `${CacheKey.ConnectionSetupScriptRateLimit}-${request.ip}`,
        { windowMs: 60_000, maxRequests: 10 },
      );
      if (limited) {
        throw new ApiError(429, "Too many requests");
      }

      const { token } = request.params;

      // Claim FIRST (atomic, exactly one fetch wins), so the re-validation
      // reads below observe any revocation committed before the claim — the
      // narrowest stale-read window READ COMMITTED allows without locking
      // the membership/permission rows. A post-claim failure is compensated
      // by un-claiming in the catch, so a server-side error or revocation
      // doesn't burn the one-time token. (Only a process crash between the
      // two statements burns it; the UI regenerates commands cheaply.)
      const setup = await ConnectionSetupModel.claimByToken({
        rawToken: token,
      });
      if (!setup) {
        const exists = await ConnectionSetupModel.findByToken(token);
        if (exists) {
          throw new ApiError(
            410,
            "This setup link has expired or was already used. Generate a new command from the connection page.",
          );
        }
        throw new ApiError(404, "Unknown setup token");
      }

      let script: string;
      try {
        // Fetch-time re-validation + context building (live reads on the
        // default pool — see claim note above; threading a tx through the
        // auth layer and secrets manager is not possible).
        const { context, skillRender } = await buildScriptContext(setup);

        // Skill-link creation + attach + render commit together: a rendered
        // clone URL exists iff its link row committed.
        script = await withDbTransaction(async (tx) => {
          let skills: SetupScriptContext["skills"] = null;
          if (skillRender) {
            const { link, rawToken: linkToken } =
              await SkillShareLinkModel.create({
                organizationId: setup.organizationId,
                createdByUserId: setup.userId,
                skillIds: skillRender.skillIds,
                marketplaceName: skillRender.marketplaceName,
                name: `Connection setup (${setup.clientId})`,
                expiresAt: setup.skillLinkTtlDays
                  ? new Date(
                      Date.now() + setup.skillLinkTtlDays * 24 * 60 * 60 * 1000,
                    )
                  : null,
                tx,
              });
            await ConnectionSetupModel.attachSkillShareLink({
              connectionSetupId: setup.id,
              skillShareLinkId: link.id,
              tx,
            });
            skills = {
              cloneUrl: `${proxyBaseUrlToOrigin(setup.baseUrl)}${SKILL_MARKETPLACE_PREFIX}/${linkToken}/repo.git`,
              marketplaceName: skillRender.marketplaceName,
            };
          }

          return renderSetupScript({ ...context, skills });
        });
      } catch (error) {
        await ConnectionSetupModel.unclaim(setup.id);
        throw error;
      }

      return reply
        .header("Content-Type", "text/plain; charset=utf-8")
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .send(script);
    },
  );
};

export default connectionSetupRoutes;

// ===================================================================
// Internal helpers
// ===================================================================

const GATEWAY_AGENT_TYPES = new Set(["mcp_gateway", "profile"]);
const PROXY_AGENT_TYPES = new Set(["llm_proxy", "profile"]);

/**
 * 410 (not 403/404) for every fetch-time re-validation failure: the claim is
 * compensated (un-claimed), the token is still alive until its 15-minute expiry, and
 * the unauthenticated caller learns nothing beyond "this link is dead".
 */
const GONE = () =>
  new ApiError(
    410,
    "This setup link is no longer valid. Generate a new command from the connection page.",
  );

/**
 * Builds the render context for a freshly claimed setup, re-validating that
 * the creator still exists, still belongs to the org, and still has access to
 * every referenced resource. The skill share link itself is created later,
 * in the render transaction — this only resolves what it will need.
 */
async function buildScriptContext(setup: ConnectionSetup): Promise<{
  context: Omit<SetupScriptContext, "skills">;
  skillRender: { skillIds: string[]; marketplaceName: string } | null;
}> {
  const organization = await OrganizationModel.getById(setup.organizationId);
  if (!organization) throw GONE();
  const membership = await MemberModel.getByUserId(
    setup.userId,
    setup.organizationId,
  );
  if (!membership) throw GONE();

  const appName = organization.appName ?? DEFAULT_APP_NAME;

  let mcp: SetupScriptContext["mcp"] = null;
  if (setup.mcpGatewayId) {
    const gateway = await findAccessibleAgent({
      agentId: setup.mcpGatewayId,
      organizationId: setup.organizationId,
      userId: setup.userId,
      kind: "mcpGateway",
    });
    if (!gateway) throw GONE();
    mcp = {
      serverName: toServerName(gateway.name) || toMcpServerSlug(appName),
      url: `${setup.baseUrl}/mcp/${gateway.slug ?? gateway.id}`,
    };
  }

  let proxy: SetupScriptContext["proxy"] = null;
  if (setup.llmProxyId && setup.provider) {
    const proxyAgent = await findAccessibleAgent({
      agentId: setup.llmProxyId,
      organizationId: setup.organizationId,
      userId: setup.userId,
      kind: "llmProxy",
    });
    if (!proxyAgent) throw GONE();

    let virtualKeyValue: string | null = null;
    let virtualKeyName: string | null = null;
    if (setup.proxyAuth === "virtual-key") {
      if (!setup.virtualApiKeyId) throw GONE();
      const virtualKey = await VirtualApiKeyModel.findById(
        setup.virtualApiKeyId,
      );
      virtualKeyValue = await readVirtualKeyValue(setup.virtualApiKeyId);
      if (
        !virtualKey ||
        virtualKey.organizationId !== setup.organizationId ||
        !virtualKeyValue
      ) {
        throw GONE();
      }
      virtualKeyName = virtualKey.name;
    }

    proxy = {
      authMode: setup.proxyAuth,
      provider: setup.provider,
      providerLabel: providerDisplayNames[setup.provider] ?? setup.provider,
      url: `${setup.baseUrl}/${setup.provider}/${proxyAgent.id}`,
      proxyName: toProxyName(proxyAgent.name),
      virtualKey: virtualKeyValue,
      virtualKeyName,
      // Passthrough Copilot setups run the GitHub device flow inside the
      // script; virtual-key setups resolve the stored token server-side.
      githubCopilot:
        setup.provider === "github-copilot" &&
        setup.proxyAuth === "provider-key"
          ? {
              tokenExchangeUrl: config.llm["github-copilot"].tokenExchangeUrl,
              deviceAuthBaseUrl: config.llm["github-copilot"].deviceAuthBaseUrl,
              clientId: config.llm["github-copilot"].clientId,
            }
          : null,
    };
  }

  let skillRender: { skillIds: string[]; marketplaceName: string } | null =
    null;
  if (setup.includeSkills) {
    const isSkillAdmin = await userHasPermission(
      setup.userId,
      setup.organizationId,
      "skill",
      "admin",
    );
    if (!isSkillAdmin) throw GONE();

    const skillIds = await ConnectionSetupModel.getSkillIds({
      connectionSetupId: setup.id,
    });
    if (skillIds.length === 0) throw GONE();
    const skillRows = await SkillModel.findByIds(skillIds);
    if (
      skillRows.length !== skillIds.length ||
      skillRows.some((s) => s.organizationId !== setup.organizationId)
    ) {
      throw GONE();
    }

    const marketplaceName = await deriveMarketplaceName(setup.organizationId);
    if (isReservedMarketplaceName(marketplaceName)) throw GONE();
    skillRender = { skillIds, marketplaceName };
  }

  return {
    context: { clientId: setup.clientId, appName, mcp, proxy },
    skillRender,
  };
}

/**
 * Resolve an agent the user can access (live team membership / scope checks
 * via AgentModel.findById), constrained to the expected org and agent type.
 */
async function findAccessibleAgent(params: {
  agentId: string;
  organizationId: string;
  userId: string;
  kind: "mcpGateway" | "llmProxy";
}) {
  const { agentId, organizationId, userId, kind } = params;

  const [canRead, isAdmin] = await Promise.all([
    userHasPermission(userId, organizationId, kind, "read"),
    userHasPermission(userId, organizationId, kind, "admin"),
  ]);
  if (!canRead && !isAdmin) return null;

  const agent = await AgentModel.findById(agentId, userId, isAdmin);
  if (!agent || agent.organizationId !== organizationId) return null;

  const allowedTypes =
    kind === "mcpGateway" ? GATEWAY_AGENT_TYPES : PROXY_AGENT_TYPES;
  if (!allowedTypes.has(agent.agentType)) return null;

  return agent;
}

/** POST-time variant of findAccessibleAgent: failures are user-facing errors. */
async function requireAgentAccess(params: {
  agentId: string;
  organizationId: string;
  userId: string;
  kind: "mcpGateway" | "llmProxy";
}): Promise<void> {
  const agent = await findAccessibleAgent(params);
  if (!agent) {
    // 404 (not 403) so resource existence is not leaked across teams/orgs
    throw new ApiError(
      404,
      params.kind === "mcpGateway"
        ? "MCP gateway not found"
        : "LLM proxy not found",
    );
  }
}

async function requireSkillAdmin(params: {
  userId: string;
  organizationId: string;
}): Promise<void> {
  const isSkillAdmin = await userHasPermission(
    params.userId,
    params.organizationId,
    "skill",
    "admin",
  );
  if (!isSkillAdmin) {
    throw new ApiError(403, "Skill admin permission required to share skills");
  }
}

async function assertSkillsBelongToOrg(params: {
  skillIds: string[];
  organizationId: string;
}): Promise<void> {
  const skills = await SkillModel.findByIds(params.skillIds);
  const skillMap = new Map(skills.map((s) => [s.id, s]));
  for (const skillId of params.skillIds) {
    const skill = skillMap.get(skillId);
    if (!skill || skill.organizationId !== params.organizationId) {
      // 404 (not 403) so org membership is not leaked
      throw new ApiError(404, "Skill not found");
    }
  }
}

/**
 * baseUrl ends up verbatim in a script served from a public endpoint AND in
 * the copy-pasted curl one-liner, so it must EXACTLY match (normalized full
 * URL, not just host) a URL the deployment already trusts: the env-configured
 * public URLs, the admin-curated connection URLs (each optionally with the
 * /v1 suffix the connection page appends), or localhost with no path beyond
 * /v1. Host-only matching would let a crafted path smuggle shell syntax into
 * the rendered script.
 */
function isAllowedBaseUrl(params: {
  baseUrl: string;
  organization: Organization;
}): boolean {
  const normalized = normalizeBaseUrl(params.baseUrl);
  if (!normalized) return false;

  const localHostnames = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  if (localHostnames.has(normalized.hostname)) {
    return normalized.path === "" || normalized.path === "/v1";
  }

  const allowed = new Set<string>();
  const addSource = (raw: string) => {
    const source = normalizeBaseUrl(raw);
    if (!source) return;
    allowed.add(source.url);
    if (!source.url.endsWith("/v1")) allowed.add(`${source.url}/v1`);
  };
  for (const raw of getConnectionBaseUrlSources()) addSource(raw);
  for (const entry of params.organization.connectionBaseUrls ?? []) {
    addSource(entry.url);
  }

  return allowed.has(normalized.url);
}

/**
 * Normalized comparable form of a base URL: lowercased origin + path with
 * trailing slashes stripped. Rejects non-http(s) URLs and anything carrying
 * a query, fragment, or credentials.
 */
function normalizeBaseUrl(
  raw: string,
): { url: string; hostname: string; path: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.search || parsed.hash || parsed.username || parsed.password) {
    return null;
  }

  const path = parsed.pathname.replace(/\/+$/, "");
  const hostname = parsed.hostname.toLowerCase();
  return {
    url: `${parsed.protocol}//${parsed.host.toLowerCase()}${path}`,
    hostname,
    path,
  };
}

/** Gateway name → MCP server name, e.g. "Prod Gateway" → "prod_gateway". */
function toServerName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "_");
}

/** Proxy name → TOML-safe provider id, e.g. "Default Proxy" → "default_proxy". */
function toProxyName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "archestra";
}

/** White-label app name → fallback MCP server slug (mirrors the frontend). */
function toMcpServerSlug(appName: string): string {
  const slug = appName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "archestra";
}

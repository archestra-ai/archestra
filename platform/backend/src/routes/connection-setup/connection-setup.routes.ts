import { createHash } from "node:crypto";
import {
  DEFAULT_APP_NAME,
  providerDisplayNames,
  RouteId,
  type SupportedProvider,
  SupportedProvidersSchema,
  toMcpClientServerName,
  VIRTUAL_KEY_HEADER,
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
  PluginModel,
  SkillMarketplaceCredentialModel,
  SkillModel,
  SkillShareLinkModel,
  TeamModel,
  VirtualApiKeyModel,
} from "@/models";
import { CONNECTION_SETUP_TOKEN_TTL_MS } from "@/models/connection-setup";
import { pluginDeliveryBudgetError } from "@/plugins/delivery-budget";
import {
  type ConnectionCreditWarning,
  ensureConnectionPassthroughKey,
  ensureConnectionVirtualKey,
  readVirtualKeyValue,
} from "@/services/connection-setup";
import {
  buildSetupCommand,
  proxyBaseUrlToOrigin,
  renderSetupScript,
  type SetupScriptContext,
} from "@/services/connection-setup-script";
import {
  isReservedMarketplaceName,
  resolvePluginName,
} from "@/skills/marketplace/manifest";
import { deriveMarketplaceName } from "@/skills/marketplace/marketplace-name";
import {
  ApiError,
  type ConnectionSetup,
  type ConnectionSetupClientId,
  ConnectionSetupClientIdSchema,
  ConnectionSetupPlatformSchema,
  ConnectionSetupProxyAuthSchema,
  constructResponseSchema,
  GATEWAY_CAPABLE_AGENT_TYPES,
  type Organization,
  PLUGIN_DELIVERY_MAX_COUNT,
  type PluginPlatform,
} from "@/types";
import {
  CONNECTION_HEALTH_PATH,
  CONNECTION_SETUP_SCRIPT_PREFIX,
  SKILL_MARKETPLACE_PREFIX,
  SKILL_MARKETPLACE_STATIC_PATH,
} from "../route-paths";

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
  /** Target OS for the generated script; defaults to bash (macOS/Linux). */
  platform: ConnectionSetupPlatformSchema.default("macos"),
  baseUrl: z.string().url().max(2048),
  mcpGatewayId: z.string().uuid().optional(),
  // Accepted for client compatibility but ignored — the org's single LLM
  // Proxy is resolved server-side; `provider` alone opts the proxy in.
  llmProxyId: z.string().uuid().optional(),
  provider: SupportedProvidersSchema.optional(),
  /** Passthrough by default; "virtual-key" auto-provisions a personal key. */
  proxyAuth: ConnectionSetupProxyAuthSchema.default("provider-key"),
  /**
   * In passthrough (provider-key) mode, auto-provision a personal passthrough
   * key and inject the X-Archestra-Virtual-Key header so the proxy attributes
   * requests to the user. Defaults on; the UI exposes an opt-out. Best-effort:
   * silently skipped when the caller lacks llmVirtualKey:create.
   */
  attributePassthrough: z.boolean().default(true),
  /**
   * Explicit model for the Copilot CLI's provider wiring — the CLI refuses to
   * launch a BYOK provider without one, so the wizard's review step picks it.
   * The script applies it as COPILOT_MODEL. copilot-cli setups only.
   */
  model: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[\x20-\x7E]+$/, "must be printable ASCII")
    .optional(),
  skills: z
    .object({
      skillIds: z.array(z.string().uuid()).min(1).max(200),
      ttlDays: z.number().int().positive().max(3650).nullable(),
    })
    .optional(),
  /** Exact enabled/approved plugins reviewed by the connection page. */
  pluginIds: z
    .array(z.string().uuid())
    .max(PLUGIN_DELIVERY_MAX_COUNT)
    .optional(),
});

/**
 * Non-fatal signal that the bound Anthropic key couldn't be confirmed to have a
 * usable balance. `insufficient_balance` = remaining usage balance is too low,
 * whether out of credit or over a usage/spend limit (do-not-retry); `unverified`
 * = the check itself failed transiently (retry-friendly).
 */
const ConnectionCreditWarningSchema = z.object({
  kind: z.enum(["insufficient_balance", "unverified"]),
  /** Display name of the provider API key the warning is about. */
  keyName: z.string(),
});

const CreateConnectionSetupResponseSchema = z.object({
  id: z.string().uuid(),
  command: z.string(),
  expiresAt: z.date(),
  tokenStart: z.string(),
  /** Present when the bound Anthropic key has no (confirmable) credit. */
  creditWarning: ConnectionCreditWarningSchema.optional(),
  plugins: z.array(
    z.object({
      id: z.string().uuid(),
      pluginSlug: z.string(),
      displayName: z.string(),
      clientType: ConnectionSetupClientIdSchema,
    }),
  ),
});

const CreateConnectionVirtualKeyBodySchema = z.object({
  provider: SupportedProvidersSchema,
});

const CreateConnectionVirtualKeyResponseSchema = z.object({
  /** Raw virtual key value, returned exactly once for the user to paste. */
  value: z.string(),
  /** Display name of the key (for revocation guidance). */
  name: z.string(),
  /** Present when the bound Anthropic key has no (confirmable) credit. */
  creditWarning: ConnectionCreditWarningSchema.optional(),
});

const CreateConnectionPassthroughKeyBodySchema = z.object({
  /** LLM proxy the passthrough key is scoped to (added to its allowed list). */
  llmProxyId: z.string().uuid(),
});

const CreateConnectionPassthroughKeyResponseSchema = z.object({
  /** Raw passthrough key value, returned exactly once for the user to paste. */
  value: z.string(),
  /** Display name of the key (for revocation guidance). */
  name: z.string(),
});

const ConnectionHealthRefSchema = z.string().min(1).max(256);

const ConnectionHealthQuerySchema = z.object({
  /** MCP gateway id or slug, exactly as embedded in the client's config. */
  mcp: ConnectionHealthRefSchema.optional(),
  /** LLM proxy id or slug, exactly as embedded in the client's config. */
  llm: ConnectionHealthRefSchema.optional(),
});

const ConnectionHealthStatusSchema = z.enum(["ok", "down"]);

const ConnectionHealthResponseSchema = z.object({
  /**
   * One entry per requested query param. "down" deliberately conflates every
   * per-resource failure mode (deleted, never existed, wrong type) — the
   * endpoint discloses no more than "claude will not reach this". Always a
   * 200: the startup guard treats any response without a "down" marker (the
   * 404 an older backend returns for this then-unknown route, or a 429) as
   * "can't tell" and stays green, so version skew and rate limiting can
   * never read as an outage.
   */
  mcp: ConnectionHealthStatusSchema.optional(),
  llm: ConnectionHealthStatusSchema.optional(),
});

const connectionSetupRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    CONNECTION_HEALTH_PATH,
    {
      schema: {
        operationId: RouteId.GetConnectionHealth,
        description:
          "Health of the remotes a connected client is wired to, one request for all of them. " +
          "Public: used by the Claude Code startup guard before every launch, from machines with no session. " +
          "Reports only ok/down per requested remote.",
        tags: ["Connection Setups"],
        querystring: ConnectionHealthQuerySchema,
        response: constructResponseSchema(ConnectionHealthResponseSchema),
      },
    },
    async (request) => {
      // Heavy per-requester limit plus a fair instance-wide backstop: a
      // launch fires one request, so 30/min per requester is generous for
      // humans and hostile to id/slug enumeration; the global bucket caps
      // what a distributed scan can extract regardless of identities.
      const [requesterLimited, globallyLimited] = await Promise.all([
        isRateLimited(
          `${CacheKey.ConnectionHealthRateLimit}-${connectionHealthRequesterKey(request)}`,
          { windowMs: 60_000, maxRequests: 30 },
        ),
        isRateLimited(`${CacheKey.ConnectionHealthRateLimit}-global`, {
          windowMs: 60_000,
          maxRequests: 600,
        }),
      ]);
      if (requesterLimited || globallyLimited) {
        throw new ApiError(429, "Too many requests");
      }

      const { mcp, llm } = request.query;
      const [mcpExists, llmExists] = await Promise.all([
        mcp
          ? AgentModel.existsByIdOrSlugAndType({
              idOrSlug: mcp,
              agentType: "mcp_gateway",
            })
          : null,
        llm
          ? AgentModel.existsByIdOrSlugAndType({
              idOrSlug: llm,
              agentType: "llm_proxy",
            })
          : null,
      ]);

      const statusOf = (exists: boolean | null) =>
        exists === null
          ? undefined
          : exists
            ? ("ok" as const)
            : ("down" as const);
      return { mcp: statusOf(mcpExists), llm: statusOf(llmExists) };
    },
  );

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
    async ({ body, headers, organizationId, user }, reply) => {
      const {
        clientId,
        platform,
        mcpGatewayId,
        provider,
        proxyAuth,
        attributePassthrough,
        model,
        skills,
        pluginIds: requestedPluginIds,
      } = body;
      const baseUrl = body.baseUrl.replace(/\/+$/, "");

      if (
        provider &&
        !CLIENT_SUPPORTED_PROVIDERS[clientId].includes(provider)
      ) {
        throw new ApiError(
          400,
          `${provider} is not supported for ${clientId} setups`,
        );
      }
      if (model && clientId !== "copilot-cli") {
        throw new ApiError(
          400,
          "model is only supported for copilot-cli setups",
        );
      }

      const organization = await OrganizationModel.getById(organizationId);
      if (
        !organization ||
        !isAllowedBaseUrl({
          baseUrl,
          organization,
          requestOrigin: headers.origin,
        })
      ) {
        throw new ApiError(
          400,
          "baseUrl is not an allowed connection endpoint",
        );
      }

      if (mcpGatewayId) {
        await requireGatewayAccess({
          agentId: mcpGatewayId,
          organizationId,
          userId: user.id,
        });
      }

      let virtualApiKeyId: string | null = null;
      let creditWarning: ConnectionCreditWarning | undefined;
      // The caller no longer picks a proxy: `provider` alone opts the LLM
      // Proxy in, and the org's single proxy is resolved server-side.
      let llmProxyId: string | null = null;
      if (provider) {
        llmProxyId = (
          await requireLlmProxyAccess({ organizationId, userId: user.id })
        ).id;
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
          // The standard key is personal-scoped (authorId = the acting user), so
          // it carries the user's identity on its own — the proxy attributes the
          // request to that owner. No passthrough key is needed in this mode.
          ({ virtualApiKeyId, creditWarning } =
            await ensureConnectionVirtualKey({
              organizationId,
              userId: user.id,
              userEmail: user.email,
              userTeamIds: await TeamModel.getUserTeamIds(user.id),
              provider,
              preferredProviderKeyId:
                organization.connectionDefaultProviderKeys?.[provider] ?? null,
            }));
        } else if (
          // provider-key mode is passthrough: the script only rewires the base
          // URL and the user keeps their own provider credentials. We also
          // attribute requests to the user via X-Archestra-Virtual-Key, reusing
          // the (otherwise-null) virtualApiKeyId column to carry the passthrough
          // key id. Applies to Claude Code (Anthropic subscription or the user's
          // own Bedrock credentials), Codex (the user's own OpenAI key), and the
          // Copilot CLI (GitHub Copilot subscription, via COPILOT_PROVIDER_HEADERS).
          // Best-effort: silently skipped without llmVirtualKey:create.
          attributePassthrough &&
          ((clientId === "claude-code" &&
            (provider === "anthropic" || provider === "bedrock")) ||
            (clientId === "codex" && provider === "openai") ||
            (clientId === "copilot-cli" && provider === "github-copilot"))
        ) {
          const canCreateVirtualKey = await userHasPermission(
            user.id,
            organizationId,
            "llmVirtualKey",
            "create",
          );
          if (canCreateVirtualKey) {
            virtualApiKeyId = await ensureConnectionPassthroughKey({
              organizationId,
              userId: user.id,
              userEmail: user.email,
            });
          }
        }
      }

      if (skills) {
        await requireSkillRead({ userId: user.id, organizationId });
        await assertSkillsBelongToOrg({
          skillIds: skills.skillIds,
          organizationId,
        });
      }

      let plugins: Awaited<
        ReturnType<typeof PluginModel.findDeliverableForClient>
      > = [];
      if (requestedPluginIds !== undefined) {
        const uniqueIds = Array.from(new Set(requestedPluginIds));
        if (uniqueIds.length !== requestedPluginIds.length) {
          throw new ApiError(400, "pluginIds must be unique");
        }
        if (uniqueIds.length > 0) {
          if (!config.plugins.enabled) {
            throw new ApiError(404, "Plugins are not enabled");
          }
          const canDeliverPlugins = await userCanDeliverPlugins({
            userId: user.id,
            organizationId,
          });
          if (!canDeliverPlugins) {
            throw new ApiError(
              403,
              "You need plugin:read and plugin:admin permissions to install plugins",
            );
          }
          await assertPluginDeliveryBudget({
            ids: uniqueIds,
            organizationId,
          });
          plugins = await PluginModel.findApprovedByIds({
            ids: uniqueIds,
            organizationId,
          });
          if (plugins.length !== uniqueIds.length) {
            throw new ApiError(404, "Plugin not found or not approved");
          }
          if (plugins.some((plugin) => plugin.clientType !== clientId)) {
            throw new ApiError(
              400,
              "Plugins must target the selected connection client",
            );
          }
          const requiredPlatform = resolvePluginPlatform(platform);
          if (
            plugins.some(
              (plugin) => !plugin.supportedPlatforms.includes(requiredPlatform),
            )
          ) {
            throw new ApiError(
              400,
              `Every selected plugin must support ${requiredPlatform}`,
            );
          }
        }
      } else if (config.plugins.enabled) {
        const canDeliverPlugins = await userCanDeliverPlugins({
          userId: user.id,
          organizationId,
        });
        if (canDeliverPlugins) {
          const requiredPlatform = resolvePluginPlatform(platform);
          assertPluginDeliveryStats(
            await PluginModel.getDeliverableStatsForClient({
              organizationId,
              clientType: clientId,
              platform: requiredPlatform,
            }),
          );
          const deliverable =
            await PluginModel.findDeliverableMetadataForClient({
              organizationId,
              clientType: clientId,
              platform: requiredPlatform,
            });
          const ids = deliverable.map((plugin) => plugin.id);
          await assertPluginDeliveryBudget({ ids, organizationId });
          plugins = await PluginModel.findApprovedByIds({
            ids,
            organizationId,
          });
        }
      }
      const pluginIds = plugins.map((plugin) => plugin.id);
      if (!mcpGatewayId && !llmProxyId && !skills && pluginIds.length === 0) {
        throw new ApiError(
          400,
          "Select at least one of: MCP gateway, LLM proxy, skills, or an enabled plugin",
        );
      }

      const { setup, rawToken } = await ConnectionSetupModel.create({
        organizationId,
        userId: user.id,
        clientId,
        platform,
        baseUrl,
        mcpGatewayId: mcpGatewayId ?? null,
        llmProxyId,
        provider: provider ?? null,
        proxyAuth,
        model: model ?? null,
        virtualApiKeyId,
        includeSkills: Boolean(skills),
        skillLinkTtlDays: skills?.ttlDays ?? null,
        skillIds: skills?.skillIds ?? [],
        pluginIds,
        expiresAt: new Date(Date.now() + CONNECTION_SETUP_TOKEN_TTL_MS),
      });

      return reply.send({
        id: setup.id,
        command: buildSetupCommand({
          origin: proxyBaseUrlToOrigin(baseUrl),
          rawToken,
          platform,
        }),
        expiresAt: setup.expiresAt,
        tokenStart: setup.tokenStart,
        creditWarning,
        plugins: plugins.map(({ id, pluginSlug, displayName, clientType }) => ({
          id,
          pluginSlug,
          displayName,
          clientType,
        })),
      });
    },
  );

  fastify.post(
    "/api/connection-setups/virtual-key",
    {
      schema: {
        operationId: RouteId.CreateConnectionVirtualKey,
        description:
          "Provision (or reuse) the caller's personal connection virtual key " +
          "for a provider and return its value once. Backs the manual " +
          "/connection flow's virtual-key option; mirrors the auto-provisioning " +
          "done by the one-command setup. Requires llmVirtualKey:create.",
        tags: ["Connection Setups"],
        body: CreateConnectionVirtualKeyBodySchema,
        response: constructResponseSchema(
          CreateConnectionVirtualKeyResponseSchema,
        ),
      },
    },
    async ({ body, organizationId, user }, reply) => {
      const { provider } = body;

      // Same gate as the virtual-key branch of CreateConnectionSetup: minting a
      // key requires the dedicated create permission.
      const canCreateVirtualKey = await userHasPermission(
        user.id,
        organizationId,
        "llmVirtualKey",
        "create",
      );
      if (!canCreateVirtualKey) {
        throw new ApiError(
          403,
          "You need llmVirtualKey:create permission to use a virtual key. Use your own provider key instead.",
        );
      }

      const organization = await OrganizationModel.getById(organizationId);
      if (!organization) {
        throw new ApiError(404, "Organization not found");
      }

      const { virtualApiKeyId, creditWarning } =
        await ensureConnectionVirtualKey({
          organizationId,
          userId: user.id,
          userEmail: user.email,
          userTeamIds: await TeamModel.getUserTeamIds(user.id),
          provider,
          preferredProviderKeyId:
            organization.connectionDefaultProviderKeys?.[provider] ?? null,
        });

      const value = await readVirtualKeyValue(virtualApiKeyId);
      const virtualKey = await VirtualApiKeyModel.findById(virtualApiKeyId);
      if (!value || !virtualKey) {
        throw new ApiError(500, "Failed to provision a virtual key");
      }

      return reply.send({ value, name: virtualKey.name, creditWarning });
    },
  );

  fastify.post(
    "/api/connection-setups/passthrough-key",
    {
      schema: {
        operationId: RouteId.CreateConnectionPassthroughKey,
        description:
          "Provision (or reuse) the caller's personal passthrough virtual key " +
          "scoped to an LLM proxy and return its value once. Backs the manual " +
          "/connection flow's X-Archestra-Virtual-Key attribution step for " +
          "Claude Code and Claude Desktop. Requires llmVirtualKey:create.",
        tags: ["Connection Setups"],
        body: CreateConnectionPassthroughKeyBodySchema,
        response: constructResponseSchema(
          CreateConnectionPassthroughKeyResponseSchema,
        ),
      },
    },
    async ({ organizationId, user }, reply) => {
      // body.llmProxyId is accepted for client compatibility but ignored —
      // there is a single org-wide LLM Proxy now.

      // Same gate as the virtual-key route: minting a key requires the
      // dedicated create permission.
      const canCreateVirtualKey = await userHasPermission(
        user.id,
        organizationId,
        "llmVirtualKey",
        "create",
      );
      if (!canCreateVirtualKey) {
        throw new ApiError(
          403,
          "You need llmVirtualKey:create permission to create a passthrough key.",
        );
      }

      // We're generating a connection for the LLM Proxy, so the caller must be
      // able to reach it.
      await requireLlmProxyAccess({ organizationId, userId: user.id });

      const virtualApiKeyId = await ensureConnectionPassthroughKey({
        organizationId,
        userId: user.id,
        userEmail: user.email,
      });

      const value = await readVirtualKeyValue(virtualApiKeyId);
      const virtualKey = await VirtualApiKeyModel.findById(virtualApiKeyId);
      if (!value || !virtualKey) {
        throw new ApiError(500, "Failed to provision a passthrough key");
      }

      return reply.send({ value, name: virtualKey.name });
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
        const { context, marketplaceRender } = await buildScriptContext(setup);

        // Skill-link creation + attach + render commit together: a rendered
        // clone URL exists iff its link row committed.
        script = await withDbTransaction(async (tx) => {
          let skills: SetupScriptContext["skills"] = null;
          // Skills-only setups register the deployment's shared marketplace
          // URL, authenticated with a credential minted for this user. That is
          // what lets a member install with the same one command an admin
          // gets, and it stays current instead of freezing a snapshot.
          //
          // A setup that also delivers plugins still mints a share link: the
          // shared URL serves skills only, and splitting the two would make the
          // script register two marketplaces.
          if (marketplaceRender && marketplaceRender.pluginIds.length === 0) {
            const { rawToken: marketplaceToken } =
              await SkillMarketplaceCredentialModel.create({
                organizationId: setup.organizationId,
                userId: setup.userId,
                tx,
              });
            const origin = proxyBaseUrlToOrigin(setup.baseUrl);
            const staticUrl = new URL(
              `${origin}${SKILL_MARKETPLACE_STATIC_PATH}`,
            );
            // The credential rides as the URL's userinfo, exactly as a share
            // link's token does today, so `plugin marketplace add` needs no
            // credential helper and no prompt.
            staticUrl.username = encodeURIComponent(marketplaceToken);
            skills = {
              cloneUrl: staticUrl.toString(),
              marketplaceName: marketplaceRender.marketplaceName,
              hasSkills: true,
              pluginNames: [],
            };
          } else if (marketplaceRender) {
            const { link, rawToken: linkToken } =
              await SkillShareLinkModel.create({
                organizationId: setup.organizationId,
                createdByUserId: setup.userId,
                skillIds: marketplaceRender.skillIds,
                pluginIds: marketplaceRender.pluginIds,
                pluginClientType: marketplaceRender.pluginClientType,
                pluginPlatform: marketplaceRender.pluginPlatform,
                marketplaceName: marketplaceRender.marketplaceName,
                name: `Connection setup (${setup.clientId})`,
                expiresAt: setup.skillLinkTtlDays
                  ? new Date(
                      Date.now() + setup.skillLinkTtlDays * 24 * 60 * 60 * 1000,
                    )
                  : marketplaceRender.pluginIds.length > 0
                    ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
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
              marketplaceName: marketplaceRender.marketplaceName,
              hasSkills: marketplaceRender.skillIds.length > 0,
              pluginNames: marketplaceRender.pluginNames,
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

const GATEWAY_AGENT_TYPES = new Set<string>(GATEWAY_CAPABLE_AGENT_TYPES);

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

interface MarketplaceRenderContext {
  skillIds: string[];
  pluginIds: string[];
  pluginNames: string[];
  pluginClientType: ConnectionSetupClientId | null;
  pluginPlatform: PluginPlatform | null;
  marketplaceName: string;
}

/**
 * Builds the render context for a freshly claimed setup, re-validating that
 * the creator still exists, still belongs to the org, and still has access to
 * every referenced resource. The skill share link itself is created later,
 * in the render transaction — this only resolves what it will need.
 */
async function buildScriptContext(setup: ConnectionSetup): Promise<{
  context: Omit<SetupScriptContext, "skills">;
  marketplaceRender: MarketplaceRenderContext | null;
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
    const gateway = await findAccessibleGateway({
      agentId: setup.mcpGatewayId,
      organizationId: setup.organizationId,
      userId: setup.userId,
    });
    if (!gateway) throw GONE();
    mcp = {
      serverName:
        toMcpClientServerName(gateway.name) || toMcpServerSlug(appName),
      url: `${setup.baseUrl}/mcp/${gateway.slug ?? gateway.id}`,
    };
  }

  let proxy: SetupScriptContext["proxy"] = null;
  if (setup.llmProxyId && setup.provider) {
    // Re-validate that the creator can still route through the org's single
    // LLM Proxy (permission-only — there is no per-agent proxy access).
    const proxyAgent = await findAccessibleLlmProxy({
      organizationId: setup.organizationId,
      userId: setup.userId,
    });
    if (!proxyAgent) throw GONE();

    let virtualKeyValue: string | null = null;
    let virtualKeyName: string | null = null;
    let passthroughVirtualKey: string | null = null;
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
    } else if (setup.proxyAuth === "provider-key" && setup.virtualApiKeyId) {
      // Passthrough attribution key (provider-key mode reuses virtualApiKeyId).
      // Best-effort: a revoked key just drops the header — never throw GONE(),
      // since the subscription credential still passes through unattributed.
      passthroughVirtualKey = await readVirtualKeyValue(setup.virtualApiKeyId);
    }

    proxy = {
      authMode: setup.proxyAuth,
      provider: setup.provider,
      providerLabel: providerDisplayNames[setup.provider] ?? setup.provider,
      url: `${setup.baseUrl}/${setup.provider}`,
      proxyName: toProxyName(proxyAgent.name),
      virtualKey: virtualKeyValue,
      virtualKeyName,
      passthroughVirtualKey,
      model: setup.model,
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

  let skillIds: string[] = [];
  if (setup.includeSkills) {
    // Reading is enough to install: the shared marketplace URL serves each
    // caller exactly the skills they may already read. Publishing a *snapshot*
    // of a chosen set is still admin-only, and is re-checked below for the
    // plugin path, which is the only one that still mints a share link.
    const canReadSkills = await userHasPermission(
      setup.userId,
      setup.organizationId,
      "skill",
      "read",
    );
    if (!canReadSkills) throw GONE();

    skillIds = await ConnectionSetupModel.getSkillIds({
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
  }

  const pluginIds = await ConnectionSetupModel.getPluginIds({
    connectionSetupId: setup.id,
  });
  let pluginNames: string[] = [];
  if (pluginIds.length > 0) {
    if (!config.plugins.enabled) throw GONE();
    const canDeliverPlugins = await userCanDeliverPlugins({
      userId: setup.userId,
      organizationId: setup.organizationId,
    });
    if (!canDeliverPlugins) throw GONE();
    await assertPluginDeliveryBudget({
      ids: pluginIds,
      organizationId: setup.organizationId,
    });
    const plugins = await PluginModel.findApprovedByIds({
      ids: pluginIds,
      organizationId: setup.organizationId,
    });
    if (
      plugins.length !== pluginIds.length ||
      plugins.some(
        (plugin) =>
          plugin.clientType !== setup.clientId ||
          !plugin.supportedPlatforms.includes(
            resolvePluginPlatform(setup.platform),
          ),
      )
    ) {
      throw GONE();
    }
    pluginNames = plugins.map((plugin) => resolvePluginName(plugin.pluginSlug));
  }

  let marketplaceRender: MarketplaceRenderContext | null = null;
  if (skillIds.length > 0 || pluginIds.length > 0) {
    const marketplaceName = await deriveMarketplaceName(
      setup.organizationId,
      skillIds.length === 0
        ? "plugins"
        : pluginIds.length === 0
          ? "skills"
          : "extensions",
    );
    if (isReservedMarketplaceName(marketplaceName)) throw GONE();
    marketplaceRender = {
      skillIds,
      pluginIds,
      pluginNames,
      pluginClientType: pluginIds.length > 0 ? setup.clientId : null,
      pluginPlatform:
        pluginIds.length > 0 ? resolvePluginPlatform(setup.platform) : null,
      marketplaceName,
    };
  }

  return {
    context: {
      clientId: setup.clientId,
      platform: setup.platform,
      appName,
      mcp,
      proxy,
    },
    marketplaceRender,
  };
}

function resolvePluginPlatform(
  platform: z.infer<typeof ConnectionSetupPlatformSchema>,
): PluginPlatform {
  return platform === "windows" ? "windows" : "posix";
}

async function assertPluginDeliveryBudget(params: {
  ids: string[];
  organizationId: string;
}): Promise<void> {
  const error = pluginDeliveryBudgetError(
    await PluginModel.getApprovedDeliveryStats(params),
  );
  if (error) throw new ApiError(400, error);
}

function assertPluginDeliveryStats(params: {
  pluginCount: number;
  totalBytes: number;
}): void {
  const error = pluginDeliveryBudgetError(params);
  if (error) throw new ApiError(400, error);
}

async function userCanDeliverPlugins(params: {
  userId: string;
  organizationId: string;
}): Promise<boolean> {
  const [canRead, canAdmin] = await Promise.all([
    userHasPermission(params.userId, params.organizationId, "plugin", "read"),
    userHasPermission(params.userId, params.organizationId, "plugin", "admin"),
  ]);
  return canRead && canAdmin;
}

/**
 * Resolve a gateway the user can access (live team membership / scope checks
 * via AgentModel.findById), constrained to the expected org and agent type.
 */
async function findAccessibleGateway(params: {
  agentId: string;
  organizationId: string;
  userId: string;
}) {
  const { agentId, organizationId, userId } = params;

  const [canRead, isAdmin] = await Promise.all([
    userHasPermission(userId, organizationId, "mcpGateway", "read"),
    userHasPermission(userId, organizationId, "mcpGateway", "admin"),
  ]);
  if (!canRead && !isAdmin) return null;

  const agent = await AgentModel.findById(agentId, userId, isAdmin);
  if (!agent || agent.organizationId !== organizationId) return null;
  if (!GATEWAY_AGENT_TYPES.has(agent.agentType)) return null;

  return agent;
}

/** POST-time variant of findAccessibleGateway: failures are user-facing errors. */
async function requireGatewayAccess(params: {
  agentId: string;
  organizationId: string;
  userId: string;
}): Promise<void> {
  const agent = await findAccessibleGateway(params);
  if (!agent) {
    // 404 (not 403) so resource existence is not leaked across teams/orgs
    throw new ApiError(404, "MCP gateway not found");
  }
}

/**
 * The org's single LLM Proxy, if the user may route through it. Permission-only
 * (llmProxy read or admin) — there is no per-agent proxy access resolution.
 */
async function findAccessibleLlmProxy(params: {
  organizationId: string;
  userId: string;
}) {
  const { organizationId, userId } = params;
  const canRead = await userHasPermission(
    userId,
    organizationId,
    "llmProxy",
    "read",
  );
  if (!canRead) return null;
  return AgentModel.getOrgLlmProxy(organizationId);
}

/** POST-time variant of findAccessibleLlmProxy: missing access is user-facing. */
async function requireLlmProxyAccess(params: {
  organizationId: string;
  userId: string;
}) {
  const proxy = await findAccessibleLlmProxy(params);
  if (!proxy) {
    throw new ApiError(
      403,
      "You need llmProxy:read permission to route through the LLM Proxy.",
    );
  }
  return proxy;
}

/**
 * Installing shared skills needs only `skill:read`: the setup script registers
 * the deployment's shared marketplace URL, which serves each caller exactly the
 * skills they may already read. Publishing a *snapshot* of a chosen set is
 * still admin-only, and is enforced where a share link is actually minted.
 */
async function requireSkillRead(params: {
  userId: string;
  organizationId: string;
}): Promise<void> {
  const canReadSkills = await userHasPermission(
    params.userId,
    params.organizationId,
    "skill",
    "read",
  );
  if (!canReadSkills) {
    throw new ApiError(403, "Skill read permission required to install skills");
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
 * public/internal URLs, the admin-curated connection URLs (each optionally
 * with the /v1 suffix the connection page appends), or — with no path beyond
 * /v1 — localhost or the origin the browser reached the app on (the request's
 * Origin header). The Origin match is what keeps zero-config deployments
 * working: without ARCHESTRA_API_BASE_URL/ARCHESTRA_FRONTEND_URL the
 * connection page derives its endpoint from window.location.origin, which no
 * env-derived source can know. Restricting origin-level matches to the exact
 * ""/"/v1" paths the page generates prevents a crafted path from smuggling
 * shell syntax into the rendered script, and URL parsing confines the origin
 * itself to the host/port charset.
 */
function isAllowedBaseUrl(params: {
  baseUrl: string;
  organization: Organization;
  requestOrigin: string | undefined;
}): boolean {
  const normalized = normalizeBaseUrl(params.baseUrl);
  if (!normalized) return false;

  if (normalized.path === "" || normalized.path === "/v1") {
    const localHostnames = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
    if (localHostnames.has(normalized.hostname)) return true;

    const requestOrigin = params.requestOrigin
      ? normalizeBaseUrl(params.requestOrigin)
      : null;
    // A browser Origin header is origin-only; a path means it was forged.
    if (
      requestOrigin &&
      requestOrigin.path === "" &&
      requestOrigin.url === normalized.origin
    ) {
      return true;
    }
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
): { url: string; origin: string; hostname: string; path: string } | null {
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
  const origin = `${parsed.protocol}//${parsed.host.toLowerCase()}`;
  return {
    url: `${origin}${path}`,
    origin,
    hostname,
    path,
  };
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

/**
 * Rate-limit identity for the public health endpoint, most-specific wins:
 * the connection's virtual-key header when the caller sends one (hashed —
 * the raw secret never becomes a cache key), else the first X-Forwarded-For
 * hop, else the socket address. Spoofing any of these only moves the caller
 * into a different bucket, which is all a rate-limit key needs.
 */
function connectionHealthRequesterKey(request: {
  headers: Record<string, string | string[] | undefined>;
  ip: string;
}): string {
  const virtualKey = request.headers[VIRTUAL_KEY_HEADER.toLowerCase()];
  if (typeof virtualKey === "string" && virtualKey.length > 0) {
    return `vk-${createHash("sha256").update(virtualKey).digest("hex").slice(0, 32)}`;
  }
  const forwardedFor = request.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.length > 0) {
    const firstHop = forwardedFor.split(",")[0]?.trim();
    if (firstHop) return `xff-${firstHop}`;
  }
  return `ip-${request.ip}`;
}

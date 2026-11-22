import type { SupportedProvider } from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import {
  LlmProviderApiKeyModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  SecretModel,
} from "@/models";
import type { AgentRuntime, User } from "@/types";
import routes from "./agent-runtime.routes";

/** The caller can change between requests: set `ctx.user`. */
export async function buildAccountTestApp(ctx: {
  user: User;
  organizationId: string;
}) {
  const app = createFastifyInstance();
  app.addHook("onRequest", async (request) => {
    Object.assign(request, {
      user: ctx.user,
      organizationId: ctx.organizationId,
    });
  });
  registerAuditLogHook(app);
  await app.register(routes);
  return app;
}

export function runtimeFor(
  overrides: Partial<AgentRuntime> & Pick<AgentRuntime, "inferenceProtocol">,
): AgentRuntime {
  return {
    image: "example.com/coding-agent:latest",
    command: null,
    backend: "kubernetes",
    steerMode: "pipe",
    privileged: false,
    environment: null,
    credentials: [],
    ttlHours: null,
    idleTimeoutMinutes: null,
    // Each person chooses, as an agent created today is stored. A test of an
    // agent saved before people could choose removes the field.
    accountLock: null,
    ...overrides,
  };
}

/** A key with one synced model linked to it, as a provider sync leaves them. */
export async function makeKeyWithModel(params: {
  organizationId: string;
  provider: SupportedProvider;
  modelId: string;
  /** The owner of a personal key; omitted, the key is shared with everyone. */
  userId?: string;
  /** A shared key nobody was granted: only administrators reach it. */
  adminsOnly?: boolean;
  apiKeyValue?: string;
}) {
  // Recording the kind keeps an OpenAI or xAI key from counting as a possible
  // subscription, which only its owner may use.
  const apiKeyValue = params.apiKeyValue ?? "sk-test-company-key";
  const key = await LlmProviderApiKeyModel.create(
    {
      organizationId: params.organizationId,
      secretId: (
        await SecretModel.create({
          name: "runtime-account-test",
          secret: { apiKey: apiKeyValue },
        })
      ).id,
      name: `${params.provider} ${crypto.randomUUID().slice(0, 8)}`,
      provider: params.provider,
      scope: params.userId ? "personal" : "org",
      userId: params.userId ?? null,
      baseUrl: null,
      inferenceBaseUrl: null,
    },
    params.userId || params.adminsOnly
      ? { initialPermissionGrants: [], apiKeyValue }
      : { publishToOrganization: true, apiKeyValue },
  );
  const model =
    (await ModelModel.findByProviderAndModelId(
      params.provider,
      params.modelId,
    )) ??
    (await ModelModel.create({
      externalId: `${params.provider}/${params.modelId}`,
      provider: params.provider,
      modelId: params.modelId,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      lastSyncedAt: new Date(),
    }));
  await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [model.id]);
  return { key, model };
}

/**
 * `companyAccount` where the connection and its model are both set, by the
 * agent or by its runtime: nothing of it is the caller's to choose.
 */
export function companyAccountSetBy(
  fixedBy: "agent" | "runtime",
  set: Awaited<ReturnType<typeof makeKeyWithModel>>,
) {
  return {
    connection: {
      id: set.key.id,
      name: set.key.name,
      provider: set.key.provider,
      fixedBy,
    },
    model: { id: set.model.id, name: set.model.modelId, fixedBy },
    usesOrganizationDefault: false,
  };
}

/** `companyAccount` where nothing is set or chosen, and no default resolves. */
export const NO_COMPANY_ACCOUNT = {
  connection: { id: null, name: null, provider: null, fixedBy: null },
  model: { id: null, name: null, fixedBy: null },
  usesOrganizationDefault: false,
};

export async function accountAudits(agentId: string) {
  return db
    .select({
      action: schema.auditLogsTable.action,
      actorId: schema.auditLogsTable.actorId,
      httpMethod: schema.auditLogsTable.httpMethod,
      before: schema.auditLogsTable.before,
      after: schema.auditLogsTable.after,
    })
    .from(schema.auditLogsTable)
    .where(
      and(
        eq(schema.auditLogsTable.resourceId, agentId),
        eq(schema.auditLogsTable.httpRoute, "/api/agents/:id/runtime/account"),
      ),
    );
}

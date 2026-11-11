import {
  getProvidersWithOptionalApiKey,
  type SupportedProvider,
} from "@archestra/shared";
import { isAnthropicKeylessAuthEnabled } from "@/clients/anthropic-keyless-auth";
import { isAzureOpenAiEntraIdEnabled } from "@/clients/azure-openai-credentials";
import config from "@/config";
import { LlmProviderApiKeyModel, ModelModel, ModelPoolModel } from "@/models";
import { ApiError, type ModelPool } from "@/types";

/** A pool as the chat picker shows it: no members, only their providers. */
interface ChatModelPool {
  id: string;
  name: string;
  providers: SupportedProvider[];
}

/**
 * The pools a user can pick in chat: those with an enabled member on a key the
 * user may use, the same rule that lets a key into its pool on the proxy.
 */
export async function listChatModelPools(params: {
  organizationId: string;
  userId: string;
}): Promise<ChatModelPool[]> {
  if (!config.llmProxy.modelPoolsEnabled) return [];
  const [pools, keyIds] = await Promise.all([
    ModelPoolModel.list(params.organizationId),
    usableKeyIds(params),
  ]);
  return pools
    .filter((pool) => anchorMember(pool, keyIds))
    .map((pool) => ({
      id: pool.id,
      name: pool.name,
      providers: [
        ...new Set(
          pool.members
            .filter((member) => member.enabled)
            .map((member) => member.provider),
        ),
      ],
    }));
}

/**
 * What a conversation stores when the user picks a pool: the pool, plus one
 * member's key and model for everything that needs a single model (context
 * size, attachments, titles).
 */
export async function resolveChatModelPool(params: {
  organizationId: string;
  userId: string;
  modelPoolId: string;
}): Promise<{ modelPoolId: string; chatApiKeyId: string; modelId: string }> {
  return resolveModelPoolSelection(params, false);
}

/**
 * An agent grants use of its pool's shared keys, even without a direct key
 * grant. Personal members still belong only to their owner. Re-anchor for the
 * acting caller before the LLM client checks the selected provider's credential.
 * Callers must already have authorized use of the agent configured to this pool.
 */
export async function resolveAgentModelPool(params: {
  organizationId: string;
  userId: string;
  modelPoolId: string;
}): Promise<{ modelPoolId: string; chatApiKeyId: string; modelId: string }> {
  return resolveModelPoolSelection(params, true);
}

async function resolveModelPoolSelection(
  params: { organizationId: string; userId: string; modelPoolId: string },
  throughAgent: boolean,
): Promise<{ modelPoolId: string; chatApiKeyId: string; modelId: string }> {
  const pool = config.llmProxy.modelPoolsEnabled
    ? await ModelPoolModel.findById({
        organizationId: params.organizationId,
        id: params.modelPoolId,
      })
    : null;
  if (!pool) throw new ApiError(404, "Model pool not found");
  const keyIds = throughAgent
    ? await agentKeyIds(pool, params)
    : await usableKeyIds(params);
  const member = anchorMember(pool, keyIds);
  if (!member) throw new ApiError(404, "Model pool not found");
  await ModelModel.ensureModelExists(member.modelId, member.provider);
  const model = await ModelModel.findByProviderAndModelId(
    member.provider,
    member.modelId,
  );
  if (!model) throw new ApiError(404, "Model pool not found");
  return {
    modelPoolId: pool.id,
    chatApiKeyId: member.providerApiKeyId,
    modelId: model.id,
  };
}

/**
 * Applies an agent's model choice in place: a picked pool stores one of its
 * members as the agent's key and model, and picking a key or model leaves the
 * pool.
 */
export async function applyAgentModelPool(
  body: {
    modelPoolId?: string | null;
    llmApiKeyId?: string | null;
    modelId?: string | null;
  },
  params: { organizationId: string; userId: string },
): Promise<void> {
  if (body.modelPoolId) {
    const pooled = await resolveChatModelPool({
      ...params,
      modelPoolId: body.modelPoolId,
    });
    body.llmApiKeyId = pooled.chatApiKeyId;
    body.modelId = pooled.modelId;
  } else if (
    body.modelPoolId === undefined &&
    (body.llmApiKeyId !== undefined || body.modelId !== undefined)
  ) {
    body.modelPoolId = null;
  }
}

/** Current metadata is sufficient to skip disconnected keys without reading secrets. */
async function agentKeyIds(
  pool: ModelPool,
  params: { organizationId: string; userId: string },
): Promise<Set<string>> {
  const keys = await LlmProviderApiKeyModel.findByIds(
    pool.members
      .filter((member) => member.enabled)
      .map((member) => member.providerApiKeyId),
  );
  const keylessProviders = new Set<SupportedProvider>(
    getProvidersWithOptionalApiKey({
      azureEntraIdEnabled: isAzureOpenAiEntraIdEnabled(),
      anthropicKeylessAuthEnabled: isAnthropicKeylessAuthEnabled(),
    }),
  );
  if (config.llm.gemini.vertexAi.enabled) keylessProviders.add("gemini");
  if (config.llm.bedrock.iamAuthEnabled) keylessProviders.add("bedrock");
  return new Set(
    keys
      .filter(
        (key) =>
          key.organizationId === params.organizationId &&
          (key.userId === null || key.userId === params.userId) &&
          !key.requiresReauthentication &&
          (key.secretId !== null || keylessProviders.has(key.provider)),
      )
      .map((key) => key.id),
  );
}

async function usableKeyIds(params: {
  organizationId: string;
  userId: string;
}): Promise<Set<string>> {
  const keys = await LlmProviderApiKeyModel.getAvailableKeysForUser(
    params.organizationId,
    params.userId,
    [],
  );
  return new Set(keys.map((key) => key.id));
}

/**
 * The member a pooled chat is anchored on: the first one the user can use, in
 * the pool's order. Bedrock members come last, because a request in Bedrock's
 * own format can't be translated for the other members.
 */
function anchorMember(pool: ModelPool, keyIds: Set<string>) {
  return pool.members
    .filter((member) => member.enabled && keyIds.has(member.providerApiKeyId))
    .sort(
      (a, b) =>
        Number(a.provider === "bedrock") - Number(b.provider === "bedrock") ||
        a.priority - b.priority,
    )[0];
}

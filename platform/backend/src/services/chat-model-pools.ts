import type { SupportedProvider } from "@archestra/shared";
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
  const pool = config.llmProxy.modelPoolsEnabled
    ? await ModelPoolModel.findById({
        organizationId: params.organizationId,
        id: params.modelPoolId,
      })
    : null;
  const member = pool && anchorMember(pool, await usableKeyIds(params));
  if (!pool || !member) throw new ApiError(404, "Model pool not found");
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

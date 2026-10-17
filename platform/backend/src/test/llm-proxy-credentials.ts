import { VirtualApiKeyModel } from "@/models";

/**
 * A passthrough virtual key owned by `ownerId` in `organizationId`, returned as
 * the raw token a client sends in `X-Archestra-Virtual-Key`.
 *
 * LLM proxy tests send this instead of a bare provider key, so they exercise
 * the default platform-credential gate. The owner must be a member of the
 * organization, which the proxy checks for passthrough keys.
 */
export async function makePassthroughCredential(params: {
  organizationId: string;
  ownerId: string;
}): Promise<string> {
  const { value } = await VirtualApiKeyModel.create({
    organizationId: params.organizationId,
    name: `Test passthrough ${crypto.randomUUID().slice(0, 8)}`,
    keyType: "passthrough",
    scope: "personal",
    authorId: params.ownerId,
  });
  return value;
}

import { createHmac, timingSafeEqual } from "node:crypto";
import config from "@/config";

// Chat's source/user headers are attribution hints elsewhere in Archestra.
// An authenticated Chat route signs its session scope before the internal HTTP
// hop. A reverse proxy arriving over loopback cannot impersonate a user merely
// by forwarding those hints. This value stays inside the backend.
export const APPA_CALLER_AUTH_HEADER = "X-Archestra-OpenAPPA-Caller-Auth";
type ChatIdentity = {
  agentId: string;
  userId: string;
  sessionId: string;
  parentId?: string;
};

export function signChatIdentity(identity: ChatIdentity): string {
  if (!config.auth.secret)
    throw new Error("OpenAPPA Chat requires ARCHESTRA_AUTH_SECRET");
  return createHmac("sha256", config.auth.secret)
    .update("archestra-openappa-chat-v1\0")
    .update(
      JSON.stringify([
        identity.agentId,
        identity.userId,
        identity.sessionId,
        identity.parentId ?? null,
      ]),
    )
    .digest("hex");
}

export function verifyChatIdentity(
  signature: unknown,
  identity: ChatIdentity,
): boolean {
  if (typeof signature !== "string" || !/^[a-f0-9]{64}$/.test(signature))
    return false;
  return timingSafeEqual(
    Buffer.from(signature, "hex"),
    Buffer.from(signChatIdentity(identity), "hex"),
  );
}

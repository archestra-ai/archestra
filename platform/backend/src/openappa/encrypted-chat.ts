import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { ContentEncryption } from "@archestra/openappa-rs";
import type { EncryptedChatAuditContext } from "@/content-encryption/encrypted-chat";
import { ApiError } from "@/types";

export type OpenappaEncryptedChat = {
  organizationId: string;
  userId: string;
  audit: EncryptedChatAuditContext;
};

const current = new AsyncLocalStorage<OpenappaEncryptedChat | null>();
// The native annotator crosses HTTP back into this process. A capability lives
// only until its dispatch settles; neither the key nor this token is persisted.
const annotatorRequests = new Map<string, OpenappaEncryptedChat>();
export const OPENAPPA_CONTEXT_HEADER = "x-archestra-openappa-context";

export function enterOpenappaEncryptedChat(
  context: OpenappaEncryptedChat | null,
): void {
  current.enterWith(context);
}

export function openappaEncryptedChat(
  organizationId: string,
  sessionId: string,
): OpenappaEncryptedChat | null {
  const context = current.getStore();
  return context?.organizationId === organizationId &&
    context.audit.conversationId === sessionId
    ? context
    : null;
}

export async function withOpenappaContentEncryption<T>(
  organizationId: string,
  sessionId: string,
  run: (encryption?: ContentEncryption) => Promise<T>,
): Promise<T> {
  const context = openappaEncryptedChat(organizationId, sessionId);
  if (!context) return run();
  const token = randomUUID();
  annotatorRequests.set(token, context);
  try {
    return await run({
      key: context.audit.dek,
      scope: JSON.stringify([organizationId, sessionId]),
      annotatorContext: token,
    });
  } finally {
    annotatorRequests.delete(token);
  }
}

/** Called only after the route proves loopback and the process bridge bearer. */
export function openappaAnnotatorContext(
  token: string | undefined,
): OpenappaEncryptedChat | null {
  if (token === undefined) return null;
  const context = annotatorRequests.get(token);
  if (!context) throw new ApiError(401, "OpenAPPA annotation context expired");
  return context;
}

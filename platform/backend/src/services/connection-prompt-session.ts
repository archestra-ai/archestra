import { createHash } from "node:crypto";
import {
  buildConnectionPrompt,
  CONNECTION_SETUP_WINDOW_MS,
  hasNativeSetupSession,
  NATIVE_SESSION_CLIENT_LABELS,
} from "@archestra/shared/connection-setup";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import logger from "@/logging";
import { ApiError } from "@/types";
import type { ConnectionSetupClientId } from "@/types/connection-setup";

interface PendingConnection {
  userId: string;
  organizationId: string;
  clientId: ConnectionSetupClientId;
  origin: string;
  expiresAt: number;
}

interface BoundConnection extends Omit<PendingConnection, "origin"> {}

/** Start a short setup window without changing the prompt copied by the user. */
export async function beginConnectionPromptSession(params: {
  userId: string;
  organizationId: string;
  clientId: ConnectionSetupClientId;
  origin: string;
}): Promise<{ expiresAt: string }> {
  if (!params.userId || !params.organizationId) {
    throw new ApiError(401, "Unauthenticated");
  }
  if (!hasNativeSetupSession(params.clientId)) {
    throw new ApiError(400, "Unsupported client");
  }
  let origin: string;
  try {
    const parsed = new URL(params.origin);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.origin !== params.origin
    ) {
      throw new Error("Not an origin");
    }
    origin = parsed.origin;
  } catch {
    throw new ApiError(400, "Invalid connection origin");
  }
  const expiresAt = Date.now() + CONNECTION_SETUP_WINDOW_MS;
  await cacheManager.set(
    pendingKey(params.userId, params.organizationId, params.clientId),
    { ...params, origin, expiresAt } satisfies PendingConnection,
    CONNECTION_SETUP_WINDOW_MS,
  );
  return { expiresAt: new Date(expiresAt).toISOString() };
}

/** A pending browser window can bind only to the first matching native session. */
export async function recognizeConnectionSetup(params: {
  userId: string;
  organizationId: string;
  sessionId: string;
  clientId?: ConnectionSetupClientId;
  requestBody?: unknown;
}): Promise<boolean> {
  if (!params.userId || !params.organizationId || !params.sessionId) {
    return false;
  }
  const boundKey = sessionKey(
    params.userId,
    params.organizationId,
    params.sessionId,
  );
  const isBound = (value: BoundConnection | undefined) =>
    !!value &&
    value.expiresAt > Date.now() &&
    value.userId === params.userId &&
    value.organizationId === params.organizationId &&
    (!params.clientId || value.clientId === params.clientId);
  const bound = await cacheManager.get<BoundConnection>(boundKey);
  if (isBound(bound)) return true;
  if (!params.clientId || !params.requestBody) return false;

  const key = pendingKey(params.userId, params.organizationId, params.clientId);
  const pending = await cacheManager.get<PendingConnection>(key);
  if (!matchesPrompt(pending, params.requestBody)) return false;

  // DELETE RETURNING binds at most one session across backend replicas.
  const claimed = await cacheManager.getAndDelete<PendingConnection>(key);
  if (!claimed) {
    // A concurrent request in this same session may have claimed the window.
    for (let attempt = 0; attempt < 4; attempt++) {
      if (isBound(await cacheManager.get<BoundConnection>(boundKey)))
        return true;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
  }
  if (!matchesPrompt(claimed, params.requestBody)) return false;
  try {
    await cacheManager.set(
      boundKey,
      {
        userId: claimed.userId,
        organizationId: claimed.organizationId,
        clientId: claimed.clientId,
        expiresAt: claimed.expiresAt,
      } satisfies BoundConnection,
      Math.max(1, claimed.expiresAt - Date.now()),
    );
  } catch (err) {
    logger.error({ err }, "connection prompt session binding was not stored");
    return false;
  }
  return true;
}

function matchesPrompt(
  pending: PendingConnection | undefined,
  body: unknown,
): pending is PendingConnection {
  if (!pending || pending.expiresAt <= Date.now()) return false;
  if (!hasNativeSetupSession(pending.clientId)) return false;
  const prompt = buildConnectionPrompt({
    origin: pending.origin,
    clientId: pending.clientId,
    label: NATIVE_SESSION_CLIENT_LABELS[pending.clientId],
  });
  // The copied prompt can also name parts the user left out; any such list
  // still belongs to the same prompt.
  return userTexts(body).some((text) =>
    text.replace(/&exclude=[a-z,]*/g, "").includes(prompt),
  );
}

function userTexts(body: unknown): string[] {
  if (!isRecord(body)) return [];
  if (Array.isArray(body.messages)) {
    for (let index = body.messages.length - 1; index >= 0; index--) {
      const message = body.messages[index];
      if (
        !isRecord(message) ||
        message.role !== "user" ||
        message.tool_call_id
      ) {
        continue;
      }
      const texts = textParts(message.content);
      if (texts.length) return texts;
    }
    return [];
  }
  if (Array.isArray(body.contents)) {
    for (let index = body.contents.length - 1; index >= 0; index--) {
      const message = body.contents[index];
      if (
        !isRecord(message) ||
        message.role !== "user" ||
        !Array.isArray(message.parts)
      ) {
        continue;
      }
      const texts: string[] = [];
      for (const part of message.parts) {
        if (
          isRecord(part) &&
          !part.functionResponse &&
          !part.functionCall &&
          typeof part.text === "string"
        ) {
          texts.push(part.text);
        }
      }
      if (texts.length) return texts;
    }
    return [];
  }
  if (Array.isArray(body.input)) {
    for (let index = body.input.length - 1; index >= 0; index--) {
      const item = body.input[index];
      if (
        !isRecord(item) ||
        item.role !== "user" ||
        item.tool_call_id ||
        (item.type && item.type !== "message")
      ) {
        continue;
      }
      const texts = textParts(item.content);
      if (texts.length) return texts;
    }
  }
  return [];
}

function textParts(content: unknown): string[] {
  if (typeof content === "string") {
    return isClientGeneratedText(content) ? [] : [content];
  }
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      if (!isClientGeneratedText(part)) texts.push(part);
    } else if (
      isRecord(part) &&
      (part.type === "text" || part.type === "input_text") &&
      typeof part.text === "string" &&
      !isClientGeneratedText(part.text)
    ) {
      texts.push(part.text);
    }
  }
  return texts;
}

function isClientGeneratedText(text: string): boolean {
  return text.trimStart().startsWith("<system-reminder>");
}

function pendingKey(
  userId: string,
  organizationId: string,
  clientId: string,
): AllowedCacheKey {
  return `${CacheKey.ConnectionPromptSession}-pending-${digest(userId, organizationId, clientId)}`;
}

function sessionKey(
  userId: string,
  organizationId: string,
  sessionId: string,
): AllowedCacheKey {
  return `${CacheKey.ConnectionPromptSession}-session-${digest(userId, organizationId, sessionId)}`;
}

function digest(...values: string[]): string {
  return createHash("sha256")
    .update(values.join("\0")) // lgtm[js/insufficient-password-hash] Digests user, organization, and session ids into a cache key, not a password.
    .digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

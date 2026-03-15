import { and, desc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { ApiKeyResponse, SelectApiKey } from "@/types";

class ApiKeyModel {
  static async listByUserId(userId: string): Promise<ApiKeyResponse[]> {
    const apiKeys = await db
      .select()
      .from(schema.apikeysTable)
      .where(eq(schema.apikeysTable.userId, userId))
      .orderBy(desc(schema.apikeysTable.createdAt));

    return apiKeys.map(normalizeApiKey);
  }

  static async findByIdForUser(
    id: string,
    userId: string,
  ): Promise<ApiKeyResponse | null> {
    const [apiKey] = await db
      .select()
      .from(schema.apikeysTable)
      .where(
        and(
          eq(schema.apikeysTable.id, id),
          eq(schema.apikeysTable.userId, userId),
        ),
      )
      .limit(1);

    return apiKey ? normalizeApiKey(apiKey) : null;
  }
}

export default ApiKeyModel;

// === Internal helpers

function normalizeApiKey(apiKey: SelectApiKey): ApiKeyResponse {
  return {
    id: apiKey.id,
    name: apiKey.name,
    start: apiKey.start,
    prefix: apiKey.prefix,
    userId: apiKey.userId,
    enabled: apiKey.enabled,
    lastRequest: apiKey.lastRequest,
    expiresAt: apiKey.expiresAt,
    createdAt: apiKey.createdAt,
    updatedAt: apiKey.updatedAt,
    metadata: parseJsonRecord(apiKey.metadata),
    permissions: parsePermissions(apiKey.permissions),
  };
}

function parsePermissions(
  value: string | null,
): Record<string, string[]> | null {
  const parsed = parseJsonRecord(value);
  if (!parsed) return null;

  return Object.fromEntries(
    Object.entries(parsed).map(([key, actions]) => [
      key,
      Array.isArray(actions)
        ? actions.filter(
            (action): action is string => typeof action === "string",
          )
        : [],
    ]),
  );
}

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }

  return null;
}

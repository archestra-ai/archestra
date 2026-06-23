import {
  TOOL_APP_DATA_DELETE_SHORT_NAME,
  TOOL_APP_DATA_GET_SHORT_NAME,
  TOOL_APP_DATA_LIST_SHORT_NAME,
  TOOL_APP_DATA_SET_SHORT_NAME,
} from "@archestra/shared";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AppDataModel, AppModel } from "@/models";
import { callerIsAppAdmin } from "@/services/apps/app-authorization";
import { ApiError } from "@/types";
import { APP_DATA_KEY_MAX_LENGTH } from "@/types/app";
import {
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
  structuredSuccessResult,
  successResult,
} from "./helpers";
import type { ArchestraContext } from "./types";

/**
 * The App Data Store tools (`archestra.storage`). They operate strictly on the
 * calling app's own store: `appId` comes from the route-bound context set by
 * the app MCP proxy, never from a tool argument, so one app can never read or
 * write another app's data. The store is partitioned: `scope: "user"` (the
 * default) addresses the viewing user's private partition — `userId` likewise
 * comes only from the authenticated context — and `scope: "app"` addresses the
 * app-wide shared partition. Outside the proxy `context.appId` is absent and
 * the tools refuse; user scope without an authenticated viewer fails closed
 * rather than falling back to the shared partition.
 */
type PartitionResolution =
  | { ok: true; partition: { appId: string; userId: string | null } }
  | { ok: false; error: string };

function resolvePartition(
  context: ArchestraContext,
  scope: "user" | "app",
): PartitionResolution {
  const appId = context.appId;
  if (!appId) {
    return {
      ok: false,
      error: "App data tools are only available to a running app.",
    };
  }
  switch (scope) {
    case "app":
      return { ok: true, partition: { appId, userId: null } };
    case "user": {
      const userId = context.userId;
      if (!userId) {
        return {
          ok: false,
          error:
            'scope "user" requires an authenticated viewer; this session has none.',
        };
      }
      return { ok: true, partition: { appId, userId } };
    }
  }
}

const keyField = z
  .string()
  .min(1)
  .max(APP_DATA_KEY_MAX_LENGTH)
  .describe("The data store key.");

const scopeField = z
  .enum(["user", "app"])
  .default("user")
  .describe(
    'Storage partition: "user" (default) is private to the viewing user, "app" is shared by everyone using the app.',
  );

const revisionField = z
  .number()
  .int()
  .min(0)
  .describe(
    "Optimistic concurrency guard. Omit for last-writer-wins. 0 = create only if the key is absent. A positive value = overwrite only if the key is still at that revision (from a prior get/set); otherwise the write is rejected as a conflict.",
  );

const claimOwnerField = z
  .boolean()
  .describe(
    'Shared-scope only: when creating a NEW key, claim it so only you (or an app admin/author) may later overwrite or delete it. Has no effect on the "user" scope or on an existing key.',
  );

const ownerOutputField = z
  .string()
  .nullable()
  .describe("User id owning a shared key, or null if collaborative.");

const GetSchema = z.strictObject({ key: keyField, scope: scopeField });
const SetSchema = z.strictObject({
  key: keyField,
  value: z
    .unknown()
    .describe(
      "Any JSON-serializable value except null (use app_data_delete to clear a key). Pass objects/arrays directly — get returns exactly what was stored, no JSON.stringify needed.",
    ),
  scope: scopeField,
  expectedRevision: revisionField.optional(),
  claimOwner: claimOwnerField.optional(),
});
const ListSchema = z.strictObject({ scope: scopeField });
const DeleteSchema = z.strictObject({ key: keyField, scope: scopeField });

const GetOutputSchema = z.object({
  value: z.unknown(),
  revision: z.number().int().nullable(),
  owner: ownerOutputField,
});
const SetOutputSchema = z.object({
  key: z.string(),
  revision: z.number().int(),
  owner: ownerOutputField,
});
const ListOutputSchema = z.object({
  entries: z.array(
    z.object({
      key: z.string(),
      value: z.unknown(),
      revision: z.number().int(),
      owner: ownerOutputField,
    }),
  ),
});

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_APP_DATA_GET_SHORT_NAME,
    title: "Get App Data",
    description:
      "Read a value from the calling app's data store (per-user or shared partition).",
    schema: GetSchema,
    outputSchema: GetOutputSchema,
    async handler({ args, context }) {
      const resolution = resolvePartition(context, args.scope);
      if (!resolution.ok) return errorResult(resolution.error);
      const entry = await AppDataModel.get({
        ...resolution.partition,
        key: args.key,
      });
      return structuredSuccessResult({
        value: entry?.value ?? null,
        revision: entry?.revision ?? null,
        owner: entry?.owner ?? null,
      });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_APP_DATA_SET_SHORT_NAME,
    title: "Set App Data",
    description:
      "Write a value to the calling app's data store (per-user or shared partition).",
    schema: SetSchema,
    outputSchema: SetOutputSchema,
    async handler({ args, context }) {
      const resolution = resolvePartition(context, args.scope);
      if (!resolution.ok) return errorResult(resolution.error);
      const caller = await resolveCaller(context);
      if (!caller.ok) return errorResult(caller.error);
      try {
        const entry = await AppDataModel.set({
          ...resolution.partition,
          ...caller.caller,
          key: args.key,
          value: args.value,
          expectedRevision: args.expectedRevision,
          claimOwner: args.claimOwner,
        });
        return structuredSuccessResult({
          key: entry.key,
          revision: entry.revision,
          owner: entry.owner,
        });
      } catch (error) {
        return mapAppDataError(error);
      }
    },
  }),
  defineArchestraTool({
    shortName: TOOL_APP_DATA_LIST_SHORT_NAME,
    title: "List App Data",
    description:
      "List all entries in one partition of the calling app's data store.",
    schema: ListSchema,
    outputSchema: ListOutputSchema,
    async handler({ args, context }) {
      const resolution = resolvePartition(context, args.scope);
      if (!resolution.ok) return errorResult(resolution.error);
      const entries = await AppDataModel.list(resolution.partition);
      return structuredSuccessResult({ entries });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_APP_DATA_DELETE_SHORT_NAME,
    title: "Delete App Data",
    description:
      "Delete a key from the calling app's data store (per-user or shared partition).",
    schema: DeleteSchema,
    async handler({ args, context }) {
      const resolution = resolvePartition(context, args.scope);
      if (!resolution.ok) return errorResult(resolution.error);
      const caller = await resolveCaller(context);
      if (!caller.ok) return errorResult(caller.error);
      try {
        const deleted = await AppDataModel.delete({
          ...resolution.partition,
          ...caller.caller,
          key: args.key,
        });
        return successResult(
          deleted ? `Deleted "${args.key}".` : `No entry for "${args.key}".`,
        );
      } catch (error) {
        return mapAppDataError(error);
      }
    },
  }),
] as const);

export const toolEntries = registry.toolEntries;
export const tools = registry.tools;

// =============================================================================
// Internal helpers
// =============================================================================

type CallerResolution =
  | {
      ok: true;
      caller: { callerUserId: string; callerCanOverrideOwner: boolean };
    }
  | { ok: false; error: string };

// Identifies the writer and decides the ownership-override policy: the app's
// author or an org app-admin may overwrite/delete keys owned by other users.
// The mechanism lives in the model; this resolves the policy bit per call.
async function resolveCaller(
  context: ArchestraContext,
): Promise<CallerResolution> {
  const { userId, organizationId, appId } = context;
  if (!userId || !organizationId || !appId) {
    return {
      ok: false,
      error: "Writing app data requires an authenticated viewer.",
    };
  }
  const app = await AppModel.findById(appId);
  const callerCanOverrideOwner =
    app?.authorId === userId ||
    (await callerIsAppAdmin(userId, organizationId));
  return {
    ok: true,
    caller: { callerUserId: userId, callerCanOverrideOwner },
  };
}

// Conflict (409) and ownership (403) failures carry a machine-readable code in
// both _meta.archestraError and structuredContent.archestraError so the app SDK
// can branch on result._meta.archestraError || result.structuredContent.
// archestraError. Any other ApiError stays a plain text errorResult.
function mapAppDataError(error: unknown): CallToolResult {
  if (
    error instanceof ApiError &&
    (error.statusCode === 409 || error.statusCode === 403)
  ) {
    const type = error.statusCode === 409 ? "conflict" : "forbidden";
    const archestraError = { type, message: error.message } as const;
    return {
      content: [{ type: "text" as const, text: `Error: ${error.message}` }],
      structuredContent: { archestraError },
      _meta: { archestraError },
      isError: true,
    };
  }
  if (error instanceof ApiError) {
    return errorResult(error.message);
  }
  throw error;
}

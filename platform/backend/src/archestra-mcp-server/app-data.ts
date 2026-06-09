import {
  TOOL_APP_DATA_DELETE_SHORT_NAME,
  TOOL_APP_DATA_GET_SHORT_NAME,
  TOOL_APP_DATA_LIST_SHORT_NAME,
  TOOL_APP_DATA_SET_SHORT_NAME,
} from "@archestra/shared";
import { z } from "zod";
import { AppDataModel } from "@/models";
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
 * The App Data Store tools (`window.archestra.data`). They operate strictly on
 * the calling app's own store: `appId` comes from the route-bound context set by
 * the app MCP proxy, never from a tool argument, so one app can never read or
 * write another app's data. Outside that proxy `context.appId` is absent and the
 * tools refuse.
 */
function requireAppId(context: ArchestraContext): string | null {
  return context.appId ?? null;
}

const keyField = z
  .string()
  .min(1)
  .max(APP_DATA_KEY_MAX_LENGTH)
  .describe("The data store key.");

const GetSchema = z.strictObject({ key: keyField });
const SetSchema = z.strictObject({
  key: keyField,
  value: z.unknown().describe("Any JSON-serializable value."),
});
const ListSchema = z.strictObject({});
const DeleteSchema = z.strictObject({ key: keyField });

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_APP_DATA_GET_SHORT_NAME,
    title: "Get App Data",
    description: "Read a value from the calling app's data store.",
    schema: GetSchema,
    outputSchema: z.object({ value: z.unknown() }),
    async handler({ args, context }) {
      const appId = requireAppId(context);
      if (!appId) {
        return errorResult(
          "App data tools are only available to a running app.",
        );
      }
      const value = await AppDataModel.get(appId, args.key);
      return structuredSuccessResult({ value });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_APP_DATA_SET_SHORT_NAME,
    title: "Set App Data",
    description: "Write a value to the calling app's data store.",
    schema: SetSchema,
    outputSchema: z.object({ key: z.string() }),
    async handler({ args, context }) {
      const appId = requireAppId(context);
      if (!appId) {
        return errorResult(
          "App data tools are only available to a running app.",
        );
      }
      try {
        const entry = await AppDataModel.set(appId, args.key, args.value);
        return structuredSuccessResult({ key: entry.key });
      } catch (error) {
        if (error instanceof ApiError) {
          return errorResult(error.message);
        }
        throw error;
      }
    },
  }),
  defineArchestraTool({
    shortName: TOOL_APP_DATA_LIST_SHORT_NAME,
    title: "List App Data",
    description: "List all entries in the calling app's data store.",
    schema: ListSchema,
    outputSchema: z.object({
      entries: z.array(z.object({ key: z.string(), value: z.unknown() })),
    }),
    async handler({ context }) {
      const appId = requireAppId(context);
      if (!appId) {
        return errorResult(
          "App data tools are only available to a running app.",
        );
      }
      const entries = await AppDataModel.list(appId);
      return structuredSuccessResult({ entries });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_APP_DATA_DELETE_SHORT_NAME,
    title: "Delete App Data",
    description: "Delete a key from the calling app's data store.",
    schema: DeleteSchema,
    async handler({ args, context }) {
      const appId = requireAppId(context);
      if (!appId) {
        return errorResult(
          "App data tools are only available to a running app.",
        );
      }
      const deleted = await AppDataModel.delete(appId, args.key);
      return successResult(
        deleted ? `Deleted "${args.key}".` : `No entry for "${args.key}".`,
      );
    },
  }),
] as const);

export const toolEntries = registry.toolEntries;
export const tools = registry.tools;

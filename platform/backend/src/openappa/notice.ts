/**
 * OpenAPPA denial notices.
 *
 * When OpenAPPA blocks a tool call, the proxy replaces it with a notice tool call.
 * The notice keeps the original call ID and position, and carries the ruling
 * in plain text so client safety classifiers inspect clear text.
 *
 * On later requests, the proxy restores notice calls back to original tool calls
 * and injects the ruling as their result.
 */
import { isDeepStrictEqual } from "node:util";
import {
  PROXY_STAMPED_TOOL_ARGUMENTS,
  TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
} from "@archestra/shared";
import { z } from "zod";
import { type OfferJws, OfferJwsSchema } from "./offer-claims";

/** Incremented when the notice payload structure changes. */
const NOTICE_VERSION = 1;

/** Notice call metadata used to restore the original call on subsequent turns. */
const NoticeMetadata = z.object({
  v: z.literal(NOTICE_VERSION),
  call_id: z.string().min(1),
  namespace: z.string().min(1).optional(),
});

const FunctionArguments = z.union([
  z.string().refine((value) => isRecord(parseJson(value)), "a JSON object"),
  z.record(z.string(), z.unknown()),
]);

/**
 * Receipt metadata attached to a direct execute_remedy_plan call.
 * Consumed by the gateway and stripped before forwarding to the model provider.
 */
export const RemedyExecutionSchema = z.object({
  v: z.literal(1),
  kind: z.literal("appa_remedy"),
  call_id: z.string().min(1).max(512),
  // Display context only for client-decorated tool names.
  tool_name: z.string().min(1).max(512),
  original_arguments: z
    .string()
    .refine((value) => isRecord(parseJson(value)), "a JSON object"),
});

/**
 * Schema for notice arguments. Standard function calls accept JSON objects;
 * custom tool calls accept an object with an input string.
 */
export const NoticeArguments = z
  .object({
    tool: z.string().min(1),
    arguments: FunctionArguments,
    ruling: z.string().min(1),
    notice: NoticeMetadata.extend({ custom: z.literal(true).optional() }),
    offers: z.array(OfferJwsSchema).optional(),
  })
  .superRefine((value, context) => {
    if (!value.notice.custom) return;
    const customArguments =
      typeof value.arguments === "string"
        ? parseJson(value.arguments)
        : value.arguments;
    if (
      !isRecord(customArguments) ||
      Object.keys(customArguments).length !== 1 ||
      typeof customArguments.input !== "string"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["arguments"],
        message: "a custom call requires an input string",
      });
    }
  });

type NoticeFunctionCall = {
  kind: "function";
  arguments: Record<string, unknown>;
  /** Validated source text for wires that require byte-stable history. */
  rawArguments?: string;
};

type NoticeCustomCall = {
  kind: "custom";
  input: string;
};

export type NoticeOriginalCall = NoticeFunctionCall | NoticeCustomCall;

/** Shared plugin/MCP execution receipt contract. */
export type RemedyExecution = z.infer<typeof RemedyExecutionSchema>;

type ParsedRemedyExecution = RemedyExecution & {
  parsedOriginalArguments: Record<string, unknown>;
};

type AppaNotice = {
  /** The provider call id of the denied call, which the notice reuses. */
  id: string;
  /** The tool the model named, as it was spelled on the wire. */
  tool: string;
  /** The denied call, normalized once at the protocol boundary. */
  original: NoticeOriginalCall;
  /** The rendered ruling the client shows and the provider later receives. */
  result: string;
  /** True when the original call was a free-form custom tool. */
  custom?: boolean;
  /** The namespace of the original tool declaration (e.g. in Codex). */
  namespace?: string;
  /** Signed offer routing claims. Not used for restoration. */
  offers?: OfferJws[];
};

export function buildNoticeArguments(
  notice: Omit<AppaNotice, "original"> & {
    /** Original call arguments as an object or JSON string. */
    arguments: Record<string, unknown> | string;
    offers?: OfferJws[];
  },
): z.infer<typeof NoticeArguments> {
  const original = normalizeOriginalCall({
    custom: notice.custom,
    arguments: notice.arguments,
  });
  if (!original) {
    throw new TypeError("OpenAPPA custom notice requires a string input");
  }
  return {
    tool: notice.tool,
    arguments:
      original.kind === "custom"
        ? { input: original.input }
        : (original.rawArguments ?? original.arguments),
    ruling: notice.result,
    notice: {
      v: NOTICE_VERSION,
      call_id: notice.id,
      ...(notice.custom ? { custom: true } : {}),
      ...(notice.namespace ? { namespace: notice.namespace } : {}),
    },
    ...(notice.offers && notice.offers.length > 0
      ? { offers: notice.offers }
      : {}),
  };
}

/** Parses notice arguments and validates matching call ID. */
export function readNotice(params: {
  callId: string;
  arguments: unknown;
}): AppaNotice | null {
  const parsed = NoticeArguments.safeParse(
    typeof params.arguments === "string"
      ? parseJson(params.arguments)
      : params.arguments,
  );
  if (!parsed.success) return null;
  const { tool, arguments: args, ruling, notice, offers } = parsed.data;
  if (notice.call_id !== params.callId) return null;
  const original = normalizeOriginalCall({
    custom: notice.custom,
    arguments: args,
  });
  if (!original) return null;
  return {
    id: params.callId,
    tool,
    original,
    result: ruling,
    ...(notice.custom ? { custom: true } : {}),
    ...(notice.namespace ? { namespace: notice.namespace } : {}),
    ...(offers && offers.length > 0 ? { offers } : {}),
  };
}

/** Reads an execution receipt attached to a direct remedy control call. */
export function readRemedyExecution(params: {
  callId: string;
  toolName: string;
  arguments: unknown;
}): ParsedRemedyExecution | null {
  const argumentsValue =
    typeof params.arguments === "string"
      ? parseJson(params.arguments)
      : params.arguments;
  if (!isRecord(argumentsValue)) return null;
  const parsed = RemedyExecutionSchema.safeParse(argumentsValue.execution);
  if (
    !parsed.success ||
    parsed.data.call_id !== params.callId ||
    parsed.data.tool_name !== params.toolName
  )
    return null;
  const parsedOriginalArguments = parseJson(parsed.data.original_arguments);
  if (!isRecord(parsedOriginalArguments)) return null;
  if (
    !isDeepStrictEqual(
      withoutProxyMembers(argumentsValue),
      parsedOriginalArguments,
    )
  )
    return null;
  return {
    ...parsed.data,
    parsedOriginalArguments,
  };
}

// === Internal helpers ===

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A remedy call's arguments without what the proxy writes beside them: the
 * receipt and the matched offer's flattened JWS. The proxy drops an echoed
 * JWS before stamping, so the model's own copy is left out too.
 */
function withoutProxyMembers(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const stamped: readonly string[] =
    PROXY_STAMPED_TOOL_ARGUMENTS[TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME];
  return Object.fromEntries(
    Object.entries(args).filter(([name]) => !stamped.includes(name)),
  );
}

/** Normalizes notice arguments into a typed function call or custom tool call. */
function normalizeOriginalCall(params: {
  custom: boolean | undefined;
  arguments: unknown;
}): NoticeOriginalCall | undefined {
  const rawArguments =
    typeof params.arguments === "string" ? params.arguments : undefined;
  const argumentsValue = rawArguments
    ? parseJson(rawArguments)
    : params.arguments;
  if (!isRecord(argumentsValue)) return undefined;
  if (!params.custom) {
    return {
      kind: "function",
      arguments: argumentsValue,
      ...(rawArguments ? { rawArguments } : {}),
    };
  }
  return typeof argumentsValue.input === "string"
    ? { kind: "custom", input: argumentsValue.input }
    : undefined;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

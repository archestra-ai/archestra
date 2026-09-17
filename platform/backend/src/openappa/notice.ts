/**
 * OpenAPPA denial notices.
 *
 * When OpenAPPA blocks a tool call, the proxy replaces it with a notice tool call.
 * The notice preserves the original call ID and position, and carries the ruling
 * in plain text so client safety classifiers inspect clear text rather than encoded tokens.
 *
 * On subsequent requests, the proxy restores notice calls back to original tool calls
 * and injects the ruling as their result. Restoration is a stateless pure function.
 */
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

/** Incremented when the notice payload structure changes. */
const NOTICE_VERSION = 1;

/**
 * A notice call's arguments, as the client and the transcript see them: the
 * blocked call in the clear, the ruling in the clear, and beside them the
 * record restoration needs to put the call back where it was.
 */
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
 * A provider-history-only receipt on a direct execute_remedy_plan call. The
 * gateway consumes it, while the next provider request receives the original
 * arguments again so the receipt never becomes model-visible history.
 */
export const RemedyExecutionSchema = z.object({
  v: z.literal(1),
  kind: z.literal("appa_remedy"),
  call_id: z.string().min(1).max(512),
  // Display context only. The gateway cannot reconstruct a client's decorated
  // model-facing spelling from its bare MCP tool name.
  tool_name: z.string().min(1).max(512),
  original_arguments: z
    .string()
    .refine((value) => isRecord(parseJson(value)), "a JSON object"),
});

/**
 * The public MCP-tool schema. It stays strict at this shared boundary: a
 * function call carries an object or validated JSON-object text, while custom
 * calls carry only their one free-form `input` string.
 */
export const NoticeArguments = z
  .object({
    tool: z.string().min(1),
    arguments: FunctionArguments,
    ruling: z.string().min(1),
    notice: NoticeMetadata.extend({ custom: z.literal(true).optional() }),
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
};

export function buildNoticeArguments(
  notice: Omit<AppaNotice, "original"> & {
    /**
     * Compatibility input for notices already produced by the proxy. Custom
     * calls have always used `{ input: string }`; normalize that legacy shape
     * here rather than making every caller parse it independently.
     */
    arguments: Record<string, unknown> | string;
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
  const { tool, arguments: args, ruling, notice } = parsed.data;
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
  };
}

/**
 * Reads an execution receipt attached to a direct control call.
 *
 * This is presentation/history cleanup only. A malformed receipt is ignored;
 * it never grants authority and never changes which remedy the gateway ran.
 */
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
  const { execution: _receipt, ...visibleArguments } = argumentsValue;
  const { execution: _previousReceipt, ...originalArguments } =
    parsedOriginalArguments;
  if (!isDeepStrictEqual(visibleArguments, originalArguments)) return null;
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
 * Notice JSON is protocol input, so it is parsed exactly once here. A custom
 * tool is free-form text, never an arbitrary object coerced with `String()`.
 */
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

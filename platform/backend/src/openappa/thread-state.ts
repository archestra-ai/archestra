import { TimeInMs } from "@archestra/shared/consts";
import { LRUCacheManager } from "@/cache-manager";
import logger from "@/logging";
import OpenAppaThreadStateModel from "@/models/openappa-thread-state";
import { registerProcessLocalCache } from "@/process-local-cache-registry";
import type { ThreadCall, ThreadTool } from "@/types/openappa-thread-state";
import { openappaEncryptedChat } from "./encrypted-chat";
import { withoutTrajectoryStamp } from "./trajectory-stamp";

/**
 * Governing a provider-side thread.
 *
 * Anthropic's message threads keep the conversation on the provider. A create
 * request carries the tools and the transcript; every continue carries only
 * the new messages and the id of the response it follows, and leaves the tools
 * to the thread. OpenAPPA rules on a request's declared tools, so for a
 * governed thread the proxy keeps what it ruled on, one row per governed
 * response, and puts the tools back for the ruling (never on the wire).
 *
 * A continue the proxy has no row for, or whose row is `diverged`, is
 * answered with the provider's own `thread_not_found`: the client replays the
 * whole conversation with a create, which OpenAPPA governs from the start.
 */

/** Why the proxy asks the client to replay a thread instead of continuing it. */
type ThreadReplayReason =
  | "missing"
  | "diverged"
  | "consumed"
  | "foreign"
  | "unavailable";

type ThreadRequest =
  | { type: "create" }
  | { type: "continue"; previousMessageId: string };

/** The request's `thread` parameter, when the request carries one. */
export function readThreadRequest(body: unknown): ThreadRequest | undefined {
  const thread = (body as { thread?: unknown } | null)?.thread;
  if (!thread || typeof thread !== "object") return undefined;
  const { type, previous_message_id: previous } = thread as {
    type?: unknown;
    previous_message_id?: unknown;
  };
  if (type === "create") return { type };
  if (type === "continue" && typeof previous === "string" && previous !== "")
    return { type, previousMessageId: previous };
  return undefined;
}

/** What a governed thread response leaves for its continue. */
export type ThreadRecord = {
  organizationId: string;
  sessionId: string;
  /** Set when the request declared tools: they become the thread's tools. */
  tools?: ThreadTool[];
  /** The root the request continued, when it did not declare tools. */
  rootMessageId?: string;
  /** The response a continue follows; its calls are spent once this one is kept. */
  previousMessageId?: string;
};

class ThreadStates {
  /**
   * The state a governed continue is ruled with, or why the proxy has none:
   * no row (`missing`), a rewrite the thread cannot continue from
   * (`diverged`), a response already continued (`consumed`), another session's
   * row (`foreign`), or a store that could not be read (`unavailable`).
   */
  async forContinue(params: {
    organizationId: string;
    sessionId: string;
    previousMessageId: string;
  }): Promise<
    | {
        ok: true;
        tools: ThreadTool[];
        calls: ThreadCall[];
        rootMessageId: string;
      }
    | { ok: false; reason: ThreadReplayReason }
  > {
    const key = `${params.organizationId}\u0000${params.previousMessageId}`;
    const encryptedChat = openappaEncryptedChat(
      params.organizationId,
      params.sessionId,
    );
    let row = encryptedChat ? undefined : this.rows.get(key);
    if (!row) {
      try {
        const found = await OpenAppaThreadStateModel.find({
          organizationId: params.organizationId,
          messageId: params.previousMessageId,
          encryptedChat: encryptedChat?.audit,
        });
        // Only a row is worth keeping. A cached copy can lag the one clearing
        // `calls` on another replica; that is harmless, because the provider
        // refuses a second continue of the same message.
        if (found && !encryptedChat) this.rows.set(key, found);
        row = found ?? undefined;
      } catch (error) {
        logger.warn({ err: error }, "OpenAPPA could not read a thread state");
        return { ok: false, reason: "unavailable" };
      }
    }
    if (!row) return { ok: false, reason: "missing" };
    // A row of another session says nothing else about itself.
    if (row.sessionId !== params.sessionId)
      return { ok: false, reason: "foreign" };
    if (row.diverged) return { ok: false, reason: "diverged" };
    // A message continues once: this one was, so the provider refuses a repeat.
    if (row.calls === null) return { ok: false, reason: "consumed" };
    // The root that set the tools is gone (expired before this row).
    if (!row.tools) return { ok: false, reason: "missing" };
    return {
      ok: true,
      tools: row.tools,
      calls: row.calls,
      rootMessageId: row.rootMessageId,
    };
  }

  /**
   * Keeps what a governed thread response was ruled on. A failed write only
   * costs a replay: the next continue finds no row.
   */
  async record(params: {
    record: ThreadRecord;
    messageId: string | undefined;
    calls: ThreadCall[];
    diverged: boolean;
  }): Promise<void> {
    const { record, messageId, calls } = params;
    // A response whose calls are too large to keep cannot be continued from.
    const diverged =
      params.diverged ||
      Buffer.byteLength(JSON.stringify(calls)) > MAX_CALLS_BYTES;
    if (!messageId) return;
    const rootMessageId = record.tools
      ? messageId
      : (record.rootMessageId ?? messageId);
    if (record.previousMessageId)
      this.rows.delete(
        `${record.organizationId}\u0000${record.previousMessageId}`,
      );
    try {
      await OpenAppaThreadStateModel.record({
        organizationId: record.organizationId,
        encryptedChat: openappaEncryptedChat(
          record.organizationId,
          record.sessionId,
        )?.audit,
        messageId,
        sessionId: record.sessionId,
        rootMessageId,
        ...(record.tools ? { tools: record.tools } : {}),
        ...(record.previousMessageId
          ? { previousMessageId: record.previousMessageId }
          : {}),
        calls: diverged ? [] : calls,
        diverged,
      });
    } catch (error) {
      logger.warn(
        { err: error },
        "OpenAPPA could not keep the state of a governed thread response",
      );
    }
  }

  async deleteExpired(now = new Date()): Promise<void> {
    const before = new Date(now.getTime() - RETENTION_DAYS * TimeInMs.Day);
    const deleted = await OpenAppaThreadStateModel.deleteOlderThan(before);
    logger.info(
      { deleted, before: before.toISOString() },
      "OpenAPPA deleted expired provider-thread states",
    );
  }

  private readonly rows = registerProcessLocalCache(
    new LRUCacheManager<
      NonNullable<Awaited<ReturnType<typeof OpenAppaThreadStateModel.find>>>
    >({ maxSize: 5_000, defaultTtl: TimeInMs.Minute }),
  );
}

export const threadStates = new ThreadStates();

/** A governed thread request: what it keeps, and what its ruling borrowed. */
export class GovernedThread {
  constructor(
    private readonly params: {
      record: ThreadRecord;
      /** Set for a continue the proxy holds state for. */
      continuation?: {
        /** Whether the ruling was given the thread's tools back. */
        hydratedTools: boolean;
        /** The continue's own system blocks, as the client wrote them. */
        deltaSystem: unknown;
        echoedCalls?: object;
      };
    },
  ) {}

  /** The provider thread owns the tools of a continue; the ruling only borrowed them. */
  restoreProviderRequest(built: unknown): void {
    const { continuation } = this.params;
    if (!continuation) return;
    const thread = built as {
      tools?: unknown;
      system?: unknown;
      messages: unknown[];
    };
    if (continuation.hydratedTools) delete thread.tools;
    // The thread keeps the system prompt it was created with, guidance
    // included. A continue sends only its own system blocks, as the client
    // wrote them: guidance the ruling added to them would repeat in the thread.
    if (continuation.deltaSystem === undefined) delete thread.system;
    else thread.system = continuation.deltaSystem;
    // The adapters may hand back copies, so the echo is found by its place
    // (first) and its content (the same call ids), not by identity.
    if (
      continuation.echoedCalls &&
      isEchoOf(thread.messages[0], continuation.echoedCalls)
    )
      thread.messages = thread.messages.slice(1);
  }

  /**
   * Keeps what a governed provider thread was ruled on, so its next continue can
   * be ruled on too. A response the client holds a rewrite of that the provider
   * cannot continue from is kept as diverged: the continue is answered with a
   * replay request.
   */
  async recordResponse(params: {
    messageId: string | undefined;
    providerCalls: readonly { id: string }[];
    clientCalls: readonly { id: string; name: string; arguments?: unknown }[];
    refused: boolean;
    held: boolean;
  }): Promise<void> {
    await threadStates.record({
      record: this.params.record,
      messageId: params.messageId,
      calls: params.refused
        ? []
        : params.clientCalls.map((call) => ({
            id: call.id,
            name: call.name,
            input: parseCallArguments(call.arguments),
          })),
      diverged: !clientKeepsThreadPairing({
        providerCallIds: params.providerCalls.map((call) => call.id),
        clientCallIds: params.clientCalls.map((call) =>
          withoutTrajectoryStamp(call.id),
        ),
        refused: params.refused,
        held: params.held,
      }),
    });
  }
}

/**
 * The tools a thread declared, in the order the request listed them. The
 * declarations come from the gateway-marker pass, which ran over the same
 * entries; `types` names the provider tool type of each, by position.
 */
export function threadToolsOf(params: {
  declarations: ReadonlyArray<{
    name: string;
    namespace?: string;
    marker?: string;
    contract?: string;
  }>;
  types: ReadonlyArray<string | undefined>;
}): ThreadTool[] {
  return params.declarations.map((declaration, index) => ({
    name: declaration.name,
    ...(declaration.namespace ? { namespace: declaration.namespace } : {}),
    ...(params.types[index] ? { type: params.types[index] } : {}),
    ...(declaration.marker ? { marker: declaration.marker } : {}),
    ...(declaration.contract ? { contract: declaration.contract } : {}),
  }));
}

/** The `tools` a continue would have carried, as far as OpenAPPA reads them. */
export function toolSkeletonOf(tools: readonly ThreadTool[]): unknown[] {
  return tools.map((tool) => ({
    name: tool.name,
    ...(tool.type ? { type: tool.type } : {}),
    description: "",
    input_schema: { type: "object" },
  }));
}

/**
 * Whether the client can still continue the provider's thread from this
 * response. The provider holds the model's own output, the client holds what
 * the proxy returned: they pair while every call id the provider holds is one
 * the client holds, and the response was not replaced by text.
 *
 * @public — exported for testability
 */
export function clientKeepsThreadPairing(params: {
  providerCallIds: readonly string[];
  clientCallIds: readonly string[];
  refused: boolean;
  held: boolean;
}): boolean {
  if (params.refused || params.held) return false;
  const client = new Set(params.clientCallIds);
  return (
    params.providerCallIds.length === client.size &&
    params.providerCallIds.every((id) => client.has(id))
  );
}

/**
 * The body of the provider's own answer for an unknown thread. The request id
 * is the proxy's, and says so, so it is never taken for a provider request.
 */
export function threadNotFoundBody(proxyRequestId: string) {
  return {
    type: "error",
    error: {
      type: "not_found_error",
      message:
        'No thread state was found for the requested `previous_message_id`. Replay the full conversation with `thread: {"type": "create"}` to start a new Thread.',
      details: { error_code: "thread_not_found" },
    },
    request_id: `req_archestra_${proxyRequestId}`,
  };
}

/** The provider's answer for a message that was already continued. */
export function threadAlreadyContinuedBody(proxyRequestId: string) {
  return {
    type: "error",
    error: {
      type: "invalid_request_error",
      message:
        'The requested `previous_message_id` has already been continued. Replay the full conversation with `thread: {"type": "create"}` to start a new Thread.',
      details: { error_code: "thread_already_continued" },
    },
    request_id: `req_archestra_${proxyRequestId}`,
  };
}

/** The provider's answer that makes a client resend statelessly for the session. */
export function threadUnsupportedBody(proxyRequestId: string) {
  return {
    type: "error",
    error: {
      type: "invalid_request_error",
      message:
        "Threads are unavailable for this request right now. Resend the full conversation without a thread.",
      details: { error_code: "thread_unsupported_request" },
    },
    request_id: `req_archestra_${proxyRequestId}`,
  };
}

/**
 * The assistant message a continue's results answer: the calls the client holds
 * for the response it follows. The ruling reads it like the history a full
 * request carries, and it never goes upstream.
 */
export function echoedCallsMessage(calls: readonly ThreadCall[]) {
  return {
    role: "assistant",
    content: calls.map((call) => ({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: call.input,
    })),
  };
}

// ===

const RETENTION_DAYS = 7;
const MAX_CALLS_BYTES = 256 * 1024;

/**
 * Whether `message` is the echoed calls the ruling borrowed: an assistant
 * message with the same tool call ids, in the same order.
 */
function isEchoOf(message: unknown, echo: object): boolean {
  const ids = (value: unknown): unknown[] => {
    const content = (value as { content?: unknown } | undefined)?.content;
    return Array.isArray(content)
      ? content.map((block) => (block as { id?: unknown } | undefined)?.id)
      : [];
  };
  if ((message as { role?: string } | undefined)?.role !== "assistant")
    return false;
  const found = ids(message);
  const expected = ids(echo);
  return (
    expected.length > 0 &&
    found.length === expected.length &&
    found.every((id, index) => id === expected[index])
  );
}

function parseCallArguments(args: unknown): Record<string, unknown> {
  if (args && typeof args === "object") return args as Record<string, unknown>;
  try {
    const parsed = typeof args === "string" ? JSON.parse(args) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

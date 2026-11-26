import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  MCP_GATEWAY_MAX_INLINE_FILE_BYTES,
  MCP_UPLOAD_REQUIRED_RESULT_TYPE,
  TOOL_RUN_TOOL_SHORT_NAME,
} from "@archestra/shared";
import {
  archestraMcpBranding,
  getArchestraToolInputSchema,
} from "@/archestra-mcp-server";
import { cacheManager } from "@/cache-manager";
import {
  BuiltInFileAnswer,
  type BuiltInFileReceipt,
  type BuiltInFileSink,
  type BuiltInFiles,
  type TakenFile,
} from "@/clients/mcp-files/built-in-files";
import {
  decodeInlineFile,
  type FileInput,
  FileInputError,
  needsOutOfBandUpload,
  readFileInput,
  redactFileArguments,
} from "@/clients/mcp-files/file-input";
import { isObject } from "@/clients/mcp-files/is-object";
import {
  checkedBytes,
  FileTransferError,
  type TransferredFile,
} from "@/clients/mcp-files/transfer";
import logger from "@/logging";
import { workspaceTransferTickets } from "@/services/agent-runtime/workspace-transfers";
import { ApiError } from "@/types";
import { encodeRequestState } from "./mrtr";
import {
  FILE_UPLOAD_PATH_SEGMENT,
  FILE_UPLOAD_STATE_TTL_MS,
  type FilesDeclaration,
  missingCapabilityError,
  newOpaqueId,
  RELAY_TARGET_TTL_MS,
  type RelayDone,
  relayDoneKey,
  relayKey,
  requestMismatchError,
  sessionKey,
  spentStateError,
} from "./upload-store";

/**
 * The MCP File Uploads extension for the gateway's own built-in tools.
 *
 * Here the gateway is the server. A built-in handler reads its file argument
 * through {@link createBuiltInFiles}; an out-of-band file makes it throw a
 * {@link BuiltInFileAnswer}, which {@link answerBuiltInUploadRequest} turns
 * into `upload_required` with a target at the gateway's own address. The
 * caller's upload is streamed into the handler's sink by
 * {@link receiveBuiltInUpload}, and the caller's retry runs the handler
 * again, which then finds the file stored.
 *
 * The caller's `requestState` binds the call exactly as it was made — for a
 * built-in reached through run_tool, that is the run_tool call — so the
 * retry repeats it, and the upload session it names is spent once.
 */

/**
 * One call's view of its file arguments, for `context.files`. The gateway
 * calls `spend` once the tool has finished: an input round in between leaves
 * the upload session for the retry after it.
 */
export function createBuiltInFiles(params: {
  agentId: string;
  /** The tool name as the caller sent it: what its `requestState` binds. */
  wireName: string;
  principal: string;
  /** Null for a caller that did not declare the extension. */
  declaration: FilesDeclaration | null;
  /** Set on the retry that follows an upload request. */
  uploadSessionId?: string;
}): BuiltInFiles & { spend(): Promise<void> } {
  // Read once per leg, so a tool that takes several files reads them all
  // from the same session.
  let claimed: Promise<ClaimedSession> | undefined;

  return {
    async spend() {
      if (!claimed || !params.uploadSessionId) return;
      if ((await claimed).kind !== "claimed") return;
      // Two retries with one state can both get here; only one answers.
      const spent = await cacheManager.getAndDelete<BuiltInSession>(
        sessionKey(params.uploadSessionId),
        { throwOnError: true },
      );
      if (!spent) throw spentStateError();
    },
    accepted: params.declaration !== null,
    async take({ name, value, descriptor }): Promise<TakenFile> {
      if (params.declaration === null) {
        throw new BuiltInFileAnswer({
          kind: "error",
          error: missingCapabilityError(
            "This tool takes files, but the request did not declare the files extension, so the tool didn't run.",
            {},
          ),
        });
      }
      let input: FileInput;
      let bytes: Buffer | undefined;
      try {
        input = readFileInput(value, name);
        bytes = decodeInlineFile(input, descriptor);
      } catch (error) {
        if (!(error instanceof FileInputError)) throw error;
        return {
          kind: "refused",
          message: `${error.message} The tool didn't run.`,
        };
      }
      if (bytes && bytes.length > MCP_GATEWAY_MAX_INLINE_FILE_BYTES) {
        return {
          kind: "refused",
          message: `The file sent inline is ${bytes.length} bytes; this gateway accepts at most ${MCP_GATEWAY_MAX_INLINE_FILE_BYTES} inline. Upload it instead. The tool didn't run.`,
        };
      }

      if (params.uploadSessionId) {
        claimed ??= claimSession(params, params.uploadSessionId);
        const session = await claimed;
        if (session.kind === "refused") return session;
        const receipt = session.receipts.get(input.id);
        if (!receipt) {
          return {
            kind: "refused",
            message: `The file "${input.id}" was not part of the upload, so the tool didn't run.`,
          };
        }
        return { kind: "uploaded", input, receipt };
      }

      if (bytes) return { kind: "inline", input, bytes };
      if (!needsOutOfBandUpload(input)) {
        return { kind: "inline", input, bytes: Buffer.alloc(0) };
      }
      if (!params.declaration.upload) {
        throw new BuiltInFileAnswer({
          kind: "error",
          error: missingCapabilityError(
            "This tool needs a file uploaded, but the request did not declare file uploads, so the tool didn't run.",
            { upload: {} },
          ),
        });
      }
      return { kind: "pending", input };
    },

    requireUpload({ input, sink, expiresAt }): never {
      throw new BuiltInFileAnswer({ kind: "upload", input, sink, expiresAt });
    },
  };
}

/**
 * The gateway's answer to a built-in tool that asked for an upload: one
 * caller-bound target at the gateway's own address, and a `requestState`
 * bound to this caller and this exact call.
 */
export async function answerBuiltInUploadRequest(params: {
  answer: Extract<BuiltInFileAnswer["answer"], { kind: "upload" }>;
  agentId: string;
  wireName: string;
  args: Record<string, unknown>;
  principal: string;
  /** The retry this answers, when the call was already one. */
  uploadSessionId?: string;
  /** Input the caller already gave in this call, kept for the retry. */
  inputResponses?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  if (params.uploadSessionId) {
    // The spec: a second upload request in one logical call fails the call.
    return {
      content: [
        {
          type: "text",
          text: "The tool asked for the file a second time, so it didn't run.",
        },
      ],
      isError: true,
    };
  }
  const { input, sink } = params.answer;
  const now = Date.now();
  const expiresAt = Math.min(
    params.answer.expiresAt,
    now + RELAY_TARGET_TTL_MS,
  );
  const relayId = newOpaqueId();
  const sessionId = newOpaqueId();
  const relay: BuiltInRelay = {
    kind: "built-in",
    relayId,
    agentId: params.agentId,
    principal: params.principal,
    fileId: input.id,
    file: transferredFile(input),
    sink,
    expiresAt,
  };
  const session: BuiltInSession = {
    kind: "built-in",
    agentId: params.agentId,
    wireName: params.wireName,
    principal: params.principal,
    files: [{ fileId: input.id, relayId }],
    ...(params.inputResponses && { inputResponses: params.inputResponses }),
  };
  await cacheManager.set(
    sessionKey(sessionId),
    session,
    FILE_UPLOAD_STATE_TTL_MS,
  );
  await cacheManager.set(
    relayKey(relayId),
    relay,
    Math.max(1, expiresAt - now),
  );

  return {
    resultType: MCP_UPLOAD_REQUIRED_RESULT_TYPE,
    uploads: [
      {
        fileId: input.id,
        path: `/${FILE_UPLOAD_PATH_SEGMENT}/${relayId}`,
        method: "PUT",
        credentials: "include",
        expiresAt: new Date(expiresAt).toISOString(),
      },
    ],
    requestState: encodeRequestState({
      principal: params.principal,
      method: "tools/call",
      requestParams: { name: params.wireName, arguments: params.args },
      keys: [],
      uploadSessionId: sessionId,
      ttlMs: FILE_UPLOAD_STATE_TTL_MS,
    }),
    content: [],
  };
}

/**
 * The input a caller already gave in a call that then asked for an upload,
 * for the retry after it: answered once, not asked again.
 */
export async function inputResponsesBeforeUpload(
  uploadSessionId: string,
): Promise<Record<string, unknown> | undefined> {
  const session = await cacheManager.get<UploadSessionRecord>(
    sessionKey(uploadSessionId),
    { throwOnError: true },
  );
  return session?.kind === "built-in" ? session.inputResponses : undefined;
}

/** A relay record for a built-in tool's upload. */
export type BuiltInRelay = {
  kind: "built-in";
  relayId: string;
  agentId: string;
  principal: string;
  fileId: string;
  file: TransferredFile;
  sink: BuiltInFileSink;
  /** Epoch ms after which the caller may no longer start this upload. */
  expiresAt: number;
};

/**
 * Stream a caller's upload into the built-in tool's sink. The bytes are held
 * to the file's declared size and digest on the way; the sink stores them
 * only once they are complete and match.
 */
export async function receiveBuiltInUpload(params: {
  relay: BuiltInRelay;
  body: AsyncIterable<Uint8Array>;
}): Promise<
  | { kind: "stored"; receipt: BuiltInFileReceipt }
  | { kind: "failed"; status: number; message: string }
> {
  const { relay } = params;
  try {
    // The digest the gateway computes over the same bytes, for a file that
    // declared none: the runtime's own hash then still has a match to meet.
    const hash = createHash("sha256");
    async function* hashed(): AsyncGenerator<Uint8Array> {
      for await (const chunk of checkedBytes(params.body, relay.file)) {
        hash.update(chunk);
        yield chunk;
      }
    }
    const ticket = await workspaceTransferTickets.resolveRelayed(
      relay.sink.ticketId,
    );
    const receipt = await workspaceTransferTickets.receive({
      ticket,
      body: Readable.from(hashed()),
      sha256: () => hash.digest("hex"),
    });
    return { kind: "stored", receipt: receipt as BuiltInFileReceipt };
  } catch (error) {
    if (error instanceof FileTransferError) {
      return { kind: "failed", status: 400, message: error.message };
    }
    if (error instanceof ApiError && error.statusCode < 500) {
      logger.info(
        {
          agentId: relay.agentId,
          fileId: relay.fileId,
          status: error.statusCode,
        },
        "Workspace refused an MCP file upload",
      );
      return {
        kind: "failed",
        status: error.statusCode,
        message: error.message,
      };
    }
    throw error;
  }
}

/**
 * A built-in call's arguments as they may be logged and recorded: every file
 * argument's bytes are replaced by their size. run_tool carries another
 * tool's arguments, which are redacted by that tool's schema.
 */
export function redactBuiltInFileArguments(
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const recorded = redactFileArguments(
    getArchestraToolInputSchema(name) ?? null,
    args,
  );
  const innerName = recorded.tool_name;
  if (
    archestraMcpBranding.getToolShortName(name) === TOOL_RUN_TOOL_SHORT_NAME &&
    typeof innerName === "string" &&
    isObject(recorded.tool_args)
  ) {
    recorded.tool_args = redactFileArguments(
      getArchestraToolInputSchema(innerName) ?? null,
      recorded.tool_args,
    );
  }
  return recorded;
}

// === Internal helpers ===

type BuiltInSession = {
  kind: "built-in";
  agentId: string;
  wireName: string;
  principal: string;
  files: { fileId: string; relayId: string }[];
  inputResponses?: Record<string, unknown>;
};

/** A session record as either kind of file call wrote it. */
type UploadSessionRecord = BuiltInSession | { kind?: "upstream" };

type ClaimedSession =
  | { kind: "claimed"; receipts: Map<string, BuiltInFileReceipt> }
  | { kind: "refused"; message: string };

/**
 * Check a retry's upload session: it must be this call's, and every file in
 * it must have arrived. It is spent by `spend`, once the tool has finished.
 */
async function claimSession(
  params: { agentId: string; wireName: string; principal: string },
  sessionId: string,
): Promise<ClaimedSession> {
  const session = await cacheManager.get<UploadSessionRecord>(
    sessionKey(sessionId),
    { throwOnError: true },
  );
  if (!session) {
    throw new BuiltInFileAnswer({ kind: "error", error: spentStateError() });
  }
  if (
    session.kind !== "built-in" ||
    session.agentId !== params.agentId ||
    session.wireName !== params.wireName ||
    session.principal !== params.principal
  ) {
    throw new BuiltInFileAnswer({
      kind: "error",
      error: requestMismatchError(),
    });
  }
  const receipts = new Map<string, BuiltInFileReceipt>();
  for (const { fileId, relayId } of session.files) {
    const done = await cacheManager.get<RelayDone>(relayDoneKey(relayId), {
      throwOnError: true,
    });
    if (!done?.receipt) {
      return {
        kind: "refused",
        message:
          "The file was not uploaded yet, so the tool didn't run. Upload it to its target, then retry.",
      };
    }
    receipts.set(fileId, done.receipt);
  }
  return { kind: "claimed", receipts };
}

function transferredFile(input: FileInput): TransferredFile {
  const { size, name, mimeType, digest } = input;
  return {
    size,
    mimeType,
    ...(name !== undefined && { name }),
    ...(digest !== undefined && { digest }),
  };
}

import {
  MCP_FILES_EXTENSION_ID,
  MCP_GATEWAY_MAX_INLINE_FILE_BYTES,
  MCP_UPLOAD_REQUIRED_RESULT_TYPE,
} from "@archestra/shared";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { cacheManager } from "@/cache-manager";
import mcpClient, {
  type TokenAuthContext,
  type UpstreamHttpCall,
  type UpstreamHttpCallOutcome,
  type UpstreamHttpCallPlan,
} from "@/clients/mcp-client";
import type { FileCallRpcError } from "@/clients/mcp-files/built-in-files";
import {
  collectFileArguments,
  decodeInlineFile,
  type FileArgument,
  FileInputError,
  needsOutOfBandUpload,
  redactFileArguments,
  schemaDeclaresFileInput,
} from "@/clients/mcp-files/file-input";
import { isObject } from "@/clients/mcp-files/is-object";
import {
  discoverUpstreamFilesSupport,
  isTimeout,
  StatelessUpstreamError,
  sendStatelessRequest,
  type UpstreamHttpTarget,
} from "@/clients/mcp-files/stateless-upstream";
import {
  FileTransferError,
  type TransferredFile,
  transferFile,
} from "@/clients/mcp-files/transfer";
import {
  parseUploadRequiredResult,
  resolveUploadTargetUrl,
  type UploadTarget,
  UploadTargetError,
} from "@/clients/mcp-files/upload-target";
import config from "@/config";
import logger from "@/logging";
import { evaluateRemoteServerUrlAgainstNetworkPolicy } from "@/services/environments/remote-server-network-policy";
import { agentOwner } from "@/types/tool-owner";
import { type BuiltInRelay, receiveBuiltInUpload } from "./built-in-files";
import { encodeRequestState, INPUT_REQUIRED_RESULT_TYPE } from "./mrtr";
import { COMPLETE_RESULT_TYPE } from "./protocol";
import {
  acknowledgeRepeat,
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
 * The MCP File Uploads extension at the gateway.
 *
 * The gateway is a server to its caller and a client of each upstream server,
 * so one file call is two logical calls: the caller's, which the gateway
 * answers, and the gateway's own to the upstream. Every out-of-band file is
 * relayed: the caller uploads to a target at the gateway's own address, and
 * the gateway streams the bytes on to the target the upstream named, with the
 * upstream's credential when that target asks for it. Upstream target URLs,
 * their headers and the upstream's `requestState` never reach the caller.
 *
 * Downloads are not supported: the gateway never declares `download`
 * upstream, so no upstream returns download targets through it.
 *
 * @see https://github.com/modelcontextprotocol/experimental-ext-file-uploads
 */

/**
 * One caller `tools/call` as the files extension sees it.
 *
 * `planFor` is handed to `mcpClient.executeToolCallForOwner`, which calls it
 * with the schema of the tool it actually runs. When that tool takes files,
 * the call is made here, and an answer that is not a tool result — an upload
 * request, or a protocol error — is left in {@link interim} for the gateway's
 * handler to return instead.
 */
export class GatewayFileCall {
  interim?:
    | { kind: "upload_required"; result: Record<string, unknown> }
    | { kind: "error"; error: FileCallRpcError };

  constructor(
    private readonly context: {
      agentId: string;
      /** The tool's name at the gateway. */
      toolName: string;
      /** The name as the caller sent it, which its `requestState` binds. */
      wireName: string;
      principal: string;
      args: Record<string, unknown>;
      /** Null for a caller that did not declare the extension. */
      declaration: FilesDeclaration | null;
      /** Set on the retry that follows an upload request. */
      uploadSessionId?: string;
    },
  ) {}

  readonly planFor = (
    inputSchema: Record<string, unknown> | null,
  ): UpstreamHttpCallPlan | undefined => {
    const { args, uploadSessionId } = this.context;
    let files: FileArgument[];
    try {
      files = collectFileArguments(inputSchema, args);
    } catch (error) {
      if (!(error instanceof FileInputError)) throw error;
      return {
        run: async () => toolError(`${error.message} The tool didn't run.`),
        // Whatever the arguments hold, no inline bytes go into the record.
        recordedArguments: redactFileArguments(inputSchema, args),
      };
    }
    // A tool that takes files is only ever called the 2026-07-28 way, even
    // without a file this time: its server may list it only to file clients.
    // A retry of an upload is a file call even if, impossibly, the tool no
    // longer marks the argument: the upload session decides how it ends.
    if (!schemaDeclaresFileInput(inputSchema) && !uploadSessionId) {
      return undefined;
    }
    return {
      run: (params) => this.run(params, files),
      recordedArguments: redactFileArguments(inputSchema, args),
    };
  };

  private async run(
    params: Parameters<UpstreamHttpCall>[0],
    files: FileArgument[],
  ): Promise<UpstreamHttpCallOutcome> {
    // The gateway declares upstream only what its caller declared, so a
    // caller without the extension cannot call a tool that takes files.
    if (this.context.declaration === null) {
      return this.answerWith(
        rpcError(
          missingCapabilityError(
            "This tool takes files, but the request did not declare the files extension, so the tool didn't run.",
            {},
          ),
        ),
      );
    }
    let inlineBytes = 0;
    for (const file of files) {
      try {
        const bytes = decodeInlineFile(file.input, file.descriptor);
        inlineBytes += bytes?.length ?? 0;
      } catch (error) {
        if (!(error instanceof FileInputError)) throw error;
        return toolError(`${error.message} The tool did not run.`);
      }
    }
    if (inlineBytes > MCP_GATEWAY_MAX_INLINE_FILE_BYTES) {
      return toolError(
        `The files sent inline total ${inlineBytes} bytes; this gateway accepts at most ${MCP_GATEWAY_MAX_INLINE_FILE_BYTES} inline. Upload them instead. The tool did not run.`,
      );
    }

    if (this.context.uploadSessionId) {
      return this.resumeAfterUpload(params, this.context.uploadSessionId);
    }

    const outOfBand = files.filter((file) => needsOutOfBandUpload(file.input));
    const callerUploads = this.context.declaration?.upload === true;
    if (outOfBand.length > 0 && !callerUploads) {
      return this.answerWith(
        rpcError(
          missingCapabilityError(
            "This tool needs files uploaded, but the request did not declare file uploads, so the tool didn't run.",
            { upload: {} },
          ),
        ),
      );
    }

    const support = await discoverUpstreamFilesSupport({
      target: params.target,
      cacheKey: params.installKey,
      signal: params.signal,
    });
    if (!support.upload && support.maxInlineBytes === 0) {
      return toolError(
        "The MCP server behind this tool does not support file transfers, so the tool didn't run.",
      );
    }
    if (outOfBand.length > 0 && !support.upload) {
      return toolError(
        `The MCP server behind this tool only takes files inline (up to ${support.maxInlineBytes} bytes), so the tool didn't run.`,
      );
    }
    if (inlineBytes > support.maxInlineBytes) {
      return toolError(
        `The files sent inline total ${inlineBytes} bytes; the MCP server behind this tool takes at most ${support.maxInlineBytes} inline. Upload them instead. The tool didn't run.`,
      );
    }

    // Declared upstream: only what the gateway implements and the caller
    // declared. Without uploads, empty settings say "inline only".
    const declareUpload = callerUploads && support.upload;
    const answer = await this.callUpstream(params, {
      declareUpload,
      requestState: undefined,
    });
    if (answer.kind !== "result") return answer.outcome;

    const { result } = answer;
    if (result.resultType !== MCP_UPLOAD_REQUIRED_RESULT_TYPE) {
      return completeOutcome(result);
    }
    if (outOfBand.length === 0) {
      return toolError(
        "The MCP server asked for an upload although every file was sent inline, so the tool didn't run.",
      );
    }

    let uploadRequest: ReturnType<typeof parseUploadRequiredResult>;
    try {
      uploadRequest = parseUploadRequiredResult(
        result,
        outOfBand.map((file) => file.input.id),
        { allowHttpLoopback: allowsLocalTargets() },
      );
    } catch (error) {
      if (!(error instanceof UploadTargetError)) throw error;
      return toolError(
        `The MCP server's upload request was refused: ${error.message} The tool didn't run.`,
      );
    }

    return this.relayUploadRequest(params, uploadRequest, outOfBand);
  }

  /**
   * Answer the caller's first call with an upload request of the gateway's
   * own: one relayed target per file, and a `requestState` bound to this
   * caller and this exact call.
   */
  private async relayUploadRequest(
    params: Parameters<UpstreamHttpCall>[0],
    uploadRequest: ReturnType<typeof parseUploadRequiredResult>,
    outOfBand: FileArgument[],
  ): Promise<UpstreamHttpCallOutcome> {
    const { agentId, toolName, wireName, principal, args } = this.context;
    const now = Date.now();
    const sessionId = newOpaqueId();
    const filesById = new Map(outOfBand.map((file) => [file.input.id, file]));

    const relays: RelayRecord[] = [];
    for (const target of uploadRequest.uploads) {
      const file = filesById.get(target.fileId);
      if (!file) throw new Error("A validated upload target names no file");
      let url: URL;
      try {
        url = resolveUploadTargetUrl(target, params.target.url);
      } catch (error) {
        if (!(error instanceof UploadTargetError)) throw error;
        return toolError(
          `The MCP server's upload request was refused: ${error.message} The tool didn't run.`,
        );
      }
      if (target.credentials === "include" && params.target.signsRequests) {
        return toolError(
          "The MCP server asked for its credential on an upload, which a request-signing server cannot be given. The tool didn't run.",
        );
      }
      if (target.url !== undefined) {
        const refusal = await egressRefusal(url, params.networkPolicyScope);
        if (refusal) return toolError(`${refusal} The tool didn't run.`);
      }

      const upstreamExpiry = target.expiresAt
        ? Date.parse(target.expiresAt)
        : Number.POSITIVE_INFINITY;
      if (upstreamExpiry <= now) {
        return toolError(
          "The MCP server's upload target had already expired, so the tool didn't run.",
        );
      }
      relays.push({
        kind: "upstream",
        relayId: newOpaqueId(),
        agentId,
        toolName,
        principal,
        installKey: params.installKey,
        fileId: target.fileId,
        file: transferredFile(file),
        target,
        expiresAt: Math.min(upstreamExpiry, now + RELAY_TARGET_TTL_MS),
      });
    }

    const session: UploadSession = {
      kind: "upstream",
      agentId,
      toolName,
      principal,
      installKey: params.installKey,
      upstreamRequestState: uploadRequest.requestState,
      relayIds: relays.map((relay) => relay.relayId),
    };
    await cacheManager.set(
      sessionKey(sessionId),
      session,
      FILE_UPLOAD_STATE_TTL_MS,
    );
    for (const relay of relays) {
      await cacheManager.set(
        relayKey(relay.relayId),
        relay,
        Math.max(1, relay.expiresAt - now),
      );
    }

    return this.answerWith({
      kind: "upload_required",
      result: {
        resultType: MCP_UPLOAD_REQUIRED_RESULT_TYPE,
        uploads: relays.map((relay) => ({
          fileId: relay.fileId,
          path: `/${FILE_UPLOAD_PATH_SEGMENT}/${relay.relayId}`,
          method: callerMethod(relay.target),
          credentials: "include",
          expiresAt: new Date(relay.expiresAt).toISOString(),
        })),
        requestState: encodeRequestState({
          principal,
          method: "tools/call",
          requestParams: { name: wireName, arguments: args },
          keys: [],
          uploadSessionId: sessionId,
          ttlMs: FILE_UPLOAD_STATE_TTL_MS,
        }),
        content: [],
      },
    });
  }

  /**
   * The caller's retry: every relayed file must have reached its upstream
   * target before the session is spent, and the session is spent exactly once
   * before the upstream retry goes out.
   */
  private async resumeAfterUpload(
    params: Parameters<UpstreamHttpCall>[0],
    sessionId: string,
  ): Promise<UpstreamHttpCallOutcome> {
    const { agentId, toolName, principal } = this.context;
    const session = await cacheManager.get<UploadSession>(
      sessionKey(sessionId),
      {
        throwOnError: true,
      },
    );
    if (!session) return this.answerWith(rpcError(spentStateError()));
    if (
      session.kind !== "upstream" ||
      session.agentId !== agentId ||
      session.toolName !== toolName ||
      session.principal !== principal
    ) {
      return this.answerWith(rpcError(requestMismatchError()));
    }
    if (session.installKey !== params.installKey) {
      return toolError(
        "The MCP server behind this tool changed since the upload was requested, so the tool didn't run. Call it again.",
      );
    }

    for (const relayId of session.relayIds) {
      const done = await cacheManager.get<RelayDone>(relayDoneKey(relayId), {
        throwOnError: true,
      });
      if (!done) {
        return toolError(
          "Not every file was uploaded, so the tool didn't run. Upload each file to its target, then retry.",
        );
      }
    }

    const claimed = await cacheManager.getAndDelete<UploadSession>(
      sessionKey(sessionId),
      { throwOnError: true },
    );
    if (!claimed) return this.answerWith(rpcError(spentStateError()));

    const answer = await this.callUpstream(params, {
      declareUpload: true,
      requestState: claimed.upstreamRequestState,
      afterTransfer: true,
    });
    if (answer.kind !== "result") return answer.outcome;
    if (answer.result.resultType === MCP_UPLOAD_REQUIRED_RESULT_TYPE) {
      return toolError(
        "The MCP server asked for the files a second time, so the tool didn't run.",
      );
    }
    return completeOutcome(answer.result);
  }

  /**
   * One `tools/call` to the upstream. A call without an answer, or one whose
   * state the upstream refuses after bytes were sent, has an unknown outcome:
   * it may have run, so it is reported and never sent again.
   */
  private async callUpstream(
    params: Parameters<UpstreamHttpCall>[0],
    options: {
      declareUpload: boolean;
      requestState: string | undefined;
      afterTransfer?: boolean;
    },
  ): Promise<
    | { kind: "result"; result: Record<string, unknown> }
    | { kind: "done"; outcome: UpstreamHttpCallOutcome }
  > {
    const unknownOutcome =
      "The MCP server did not confirm the call, so whether the tool ran is unknown. Check before calling it again.";
    let answer: Awaited<ReturnType<typeof sendStatelessRequest>>;
    try {
      answer = await sendStatelessRequest({
        target: params.target,
        method: "tools/call",
        name: params.toolName,
        requestParams: {
          name: params.toolName,
          arguments: this.context.args,
          ...(options.requestState !== undefined && {
            requestState: options.requestState,
          }),
        },
        clientCapabilities: {
          extensions: {
            [MCP_FILES_EXTENSION_ID]: options.declareUpload
              ? { upload: {} }
              : {},
          },
        },
        signal: params.signal,
      });
    } catch (error) {
      if (!(error instanceof StatelessUpstreamError)) {
        // The call's own deadline passed with the request out: it may have
        // run. A caller's abort is theirs to report, so it propagates.
        if (params.signal.aborted && isTimeout(params.signal.reason)) {
          return { kind: "done", outcome: toolError(unknownOutcome) };
        }
        throw error;
      }
      logger.warn(
        {
          agentId: this.context.agentId,
          toolName: this.context.toolName,
          error: error.message,
        },
        "MCP file call got no answer from the upstream server",
      );
      if (error.status === 401 || error.status === 403) {
        // Refused before running: the request never got past authorization.
        return {
          kind: "done",
          outcome: toolError(
            `The MCP server refused the gateway's credential (HTTP ${error.status}), so the tool didn't run. Reconnect the server, then call it again.`,
          ),
        };
      }
      return {
        kind: "done",
        outcome: toolError(
          options.requestState === undefined && !options.afterTransfer
            ? `${error.message} The tool may or may not have run.`
            : unknownOutcome,
        ),
      };
    }

    if (answer.kind === "error") {
      if (options.afterTransfer && answer.error.code === -32602) {
        return { kind: "done", outcome: toolError(unknownOutcome) };
      }
      return {
        kind: "done",
        outcome: toolError(
          `The MCP server refused the call: ${answer.error.message}`,
        ),
      };
    }
    if (answer.result.resultType === INPUT_REQUIRED_RESULT_TYPE) {
      return {
        kind: "done",
        outcome: toolError(
          "The MCP server asked for input during a file call, which the gateway does not relay yet, so the tool didn't finish.",
        ),
      };
    }
    return { kind: "result", result: answer.result };
  }

  private answerWith(
    interim: NonNullable<GatewayFileCall["interim"]>,
  ): UpstreamHttpCallOutcome {
    this.interim = interim;
    return { kind: "unrecorded" };
  }
}

/**
 * Take one relayed upload from the caller and stream it to the upstream
 * target it stands for.
 *
 * Answers only once the upstream target has: a 2xx here means the upstream
 * stored the whole file. The upstream credential, when the target asks for
 * it, is resolved now through the same path a tool call takes, so it is never
 * stored and is as fresh as a call's would be.
 */
export async function relayFileUpload(params: {
  relayId: string;
  profileId: string;
  tokenAuth: TokenAuthContext;
  principal: string;
  method: "PUT" | "POST";
  /** The caller's declared Content-Length, when it sent one. */
  contentLength: number | undefined;
  body: AsyncIterable<Uint8Array>;
  signal: AbortSignal;
}): Promise<{ status: number; message?: string }> {
  const { relayId, profileId, tokenAuth, principal } = params;
  const notFound = {
    status: 404,
    message: "This upload target does not exist or has expired.",
  };
  const relay = await cacheManager.get<RelayRecord | BuiltInRelay>(
    relayKey(relayId),
    { throwOnError: true },
  );
  if (!relay) {
    // Repeating an upload that already arrived succeeds again without
    // sending anything: the caller may have lost the first answer.
    const done = await cacheManager.get<RelayDone>(relayDoneKey(relayId), {
      throwOnError: true,
    });
    if (
      done &&
      done.agentId === profileId &&
      done.principal === principal &&
      params.method === done.method
    ) {
      return acknowledgeRepeat(params, done.size);
    }
    return notFound;
  }
  // Indistinguishable from a missing target to anyone it was not issued to.
  if (relay.expiresAt <= Date.now()) return notFound;
  if (relay.agentId !== profileId || relay.principal !== principal) {
    return notFound;
  }
  const method = relay.kind === "built-in" ? "PUT" : callerMethod(relay.target);
  if (params.method !== method) {
    return { status: 405, message: `Upload this file with ${method}.` };
  }
  if (
    params.contentLength !== undefined &&
    params.contentLength !== relay.file.size
  ) {
    return {
      status: 400,
      message: `The upload is ${params.contentLength} bytes; the file was declared as ${relay.file.size}.`,
    };
  }
  // Claim the target: one transfer at a time, and none after it succeeded.
  const claimed = await cacheManager.getAndDelete<RelayRecord | BuiltInRelay>(
    relayKey(relayId),
    { throwOnError: true },
  );
  if (!claimed) {
    return {
      status: 409,
      message: "This file is already being uploaded.",
    };
  }
  if (claimed.kind === "built-in") {
    return storeForBuiltIn({ relay: claimed, method, body: params.body });
  }

  let failure: { status: number; message: string } | undefined;
  let sending = false;
  let result: Awaited<ReturnType<typeof mcpClient.executeToolCallForOwner>>;
  try {
    result = await mcpClient.executeToolCallForOwner(
      { id: `file-upload-${relayId}`, name: claimed.toolName, arguments: {} },
      agentOwner(profileId),
      tokenAuth,
      {
        abortSignal: params.signal,
        // The transfer bounds itself by the file's size; the tool-call
        // timeout is far too short for a large file.
        upstreamTimeoutMs: FILE_UPLOAD_STATE_TTL_MS,
        upstreamHttpFor: () => ({
          recordedArguments: {},
          run: async (upstream) => {
            failure = await transferToUpstream({
              relay: claimed,
              upstream,
              body: params.body,
              signal: params.signal,
              onSending: () => {
                sending = true;
              },
            });
            return { kind: "unrecorded" };
          },
        }),
      },
    );
  } catch (error) {
    // The caller went away mid-body, say: the target stays usable if it can.
    await offerAgain(claimed, sending);
    throw error;
  }
  if (!failure && result.isError) {
    failure = { status: 502, message: describeToolResult(result.content) };
  }

  if (failure) {
    await offerAgain(claimed, sending);
    return failure;
  }
  const done: RelayDone = {
    agentId: claimed.agentId,
    principal: claimed.principal,
    method,
    size: claimed.file.size,
  };
  await cacheManager.set(relayDoneKey(relayId), done, FILE_UPLOAD_STATE_TTL_MS);
  return { status: 200 };
}

// === Internal helpers ===

type UploadSession = {
  kind: "upstream";
  agentId: string;
  toolName: string;
  principal: string;
  installKey: string;
  upstreamRequestState: string;
  relayIds: string[];
};

type RelayRecord = {
  kind: "upstream";
  relayId: string;
  agentId: string;
  toolName: string;
  principal: string;
  installKey: string;
  fileId: string;
  file: TransferredFile;
  target: UploadTarget;
  /** Epoch ms after which the caller may no longer start this upload. */
  expiresAt: number;
};

/**
 * The method the caller uploads with. A form target is presented without its
 * form, as raw bytes the caller PUTs: the relay builds the multipart body.
 */
function callerMethod(target: UploadTarget): "PUT" | "POST" {
  return target.form ? "PUT" : (target.method ?? "PUT");
}

/**
 * Put a claimed target back after a failed transfer, when trying again is
 * safe: a PUT can be repeated, and a POST that never started sending was not
 * applied. A POST that may have been is never offered twice.
 */
async function offerAgain(relay: RelayRecord | BuiltInRelay, sending: boolean) {
  const remaining = relay.expiresAt - Date.now();
  if (remaining <= 0) return;
  if (
    sending &&
    relay.kind === "upstream" &&
    (relay.target.method ?? "PUT") !== "PUT"
  ) {
    return;
  }
  await cacheManager.set(relayKey(relay.relayId), relay, remaining);
}

/**
 * The upload for a built-in tool: the bytes go to the tool's own sink, which
 * can take them again after a failure for as long as the target lives.
 */
async function storeForBuiltIn(params: {
  relay: BuiltInRelay;
  method: "PUT" | "POST";
  body: AsyncIterable<Uint8Array>;
}): Promise<{ status: number; message?: string }> {
  const { relay } = params;
  let outcome: Awaited<ReturnType<typeof receiveBuiltInUpload>>;
  try {
    outcome = await receiveBuiltInUpload({ relay, body: params.body });
  } catch (error) {
    await offerAgain(relay, true);
    throw error;
  }
  if (outcome.kind === "failed") {
    await offerAgain(relay, true);
    return { status: outcome.status, message: outcome.message };
  }
  const done: RelayDone = {
    agentId: relay.agentId,
    principal: relay.principal,
    method: params.method,
    size: relay.file.size,
    receipt: outcome.receipt,
  };
  await cacheManager.set(
    relayDoneKey(relay.relayId),
    done,
    FILE_UPLOAD_STATE_TTL_MS,
  );
  return { status: 200 };
}

async function transferToUpstream(params: {
  relay: RelayRecord;
  upstream: Parameters<UpstreamHttpCall>[0];
  body: AsyncIterable<Uint8Array>;
  signal: AbortSignal;
  /** Called once the request to the upstream target is about to go out. */
  onSending: () => void;
}): Promise<{ status: number; message: string } | undefined> {
  const { relay, upstream } = params;
  if (upstream.installKey !== relay.installKey) {
    return {
      status: 409,
      message:
        "The MCP server behind this tool changed since the upload was requested.",
    };
  }
  const target = upstream.target;
  try {
    const url = resolveUploadTargetUrl(relay.target, target.url);
    if (relay.target.url !== undefined) {
      const refusal = await egressRefusal(url, upstream.networkPolicyScope);
      if (refusal) return { status: 502, message: refusal };
    }
    await transferFile({
      target: relay.target,
      url,
      file: relay.file,
      body: params.body,
      credentialHeaders:
        relay.target.credentials === "include"
          ? credentialHeadersFor(target)
          : undefined,
      guardDestination: relay.target.url !== undefined,
      signal: params.signal,
      onSending: params.onSending,
    });
    return undefined;
  } catch (error) {
    if (
      error instanceof UploadTargetError ||
      error instanceof FileTransferError
    ) {
      logger.info(
        {
          agentId: relay.agentId,
          toolName: relay.toolName,
          fileId: relay.fileId,
          error: error.message,
          ...(error instanceof FileTransferError &&
            error.detail !== undefined && { detail: error.detail }),
        },
        "MCP file upload relay failed",
      );
      return { status: 502, message: error.message };
    }
    throw error;
  }
}

function credentialHeadersFor(
  target: UpstreamHttpTarget,
): Record<string, string> {
  if (target.signsRequests) {
    throw new UploadTargetError(
      "A request-signing MCP server cannot hand its credential to an upload.",
    );
  }
  return target.credentialHeaders;
}

/** Why the environment's egress policy refuses an upload address, if it does. */
async function egressRefusal(
  url: URL,
  scope: Parameters<UpstreamHttpCall>[0]["networkPolicyScope"],
): Promise<string | undefined> {
  if (!scope.organizationId) return undefined;
  const verdict = await evaluateRemoteServerUrlAgainstNetworkPolicy({
    serverType: "remote",
    serverUrl: url.href,
    environmentId: scope.environmentId,
    organizationId: scope.organizationId,
  });
  if (verdict.allowed) return undefined;
  logger.info(
    { organizationId: scope.organizationId, reason: verdict.message },
    "Network egress policy refused an MCP file upload target",
  );
  return "The upload target's address is not allowed by the network egress policy.";
}

function transferredFile(file: FileArgument): TransferredFile {
  const { size, name, mimeType, digest } = file.input;
  return {
    size,
    mimeType,
    ...(name !== undefined && { name }),
    ...(digest !== undefined && { digest }),
  };
}

function completeOutcome(
  result: Record<string, unknown>,
): UpstreamHttpCallOutcome {
  const { resultType, content, isError, _meta, structuredContent } = result;
  // A result type the gateway does not know is an invalid result.
  if (resultType !== undefined && resultType !== COMPLETE_RESULT_TYPE) {
    return toolError(
      `The MCP server answered with an unsupported result type, so the call's outcome is unknown.`,
    );
  }
  // The upstream's own files `_meta` (download targets, say) is for the
  // gateway, which declared no downloads; it never reaches the caller.
  const meta = isObject(_meta)
    ? Object.fromEntries(
        Object.entries(_meta).filter(([key]) => key !== MCP_FILES_EXTENSION_ID),
      )
    : undefined;
  return {
    kind: "result",
    result: {
      content: Array.isArray(content) ? (content as ContentBlock[]) : [],
      isError: isError === true,
      ...(meta && Object.keys(meta).length > 0 && { _meta: meta }),
      ...(isObject(structuredContent) && { structuredContent }),
    },
  };
}

function toolError(text: string): UpstreamHttpCallOutcome {
  return {
    kind: "result",
    result: { content: [{ type: "text", text }], isError: true },
  };
}

function rpcError(
  error: FileCallRpcError,
): NonNullable<GatewayFileCall["interim"]> {
  return { kind: "error", error };
}

function describeToolResult(content: unknown): string {
  if (Array.isArray(content)) {
    const text = content
      .map((block) =>
        isObject(block) && typeof block.text === "string" ? block.text : "",
      )
      .filter(Boolean)
      .join(" ");
    if (text) return text;
  }
  return "The upload could not be relayed to the MCP server.";
}

/** Loopback http upload targets are fine where loopback servers are. */
function allowsLocalTargets(): boolean {
  return !config.production || config.test.enableE2eTestEndpoints;
}

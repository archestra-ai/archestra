import { randomBytes } from "node:crypto";
import { MCP_FILES_EXTENSION_ID } from "@archestra/shared";
import { CacheKey } from "@/cache-manager";
import type { FileCallRpcError } from "@/clients/mcp-files/built-in-files";
import { isObject } from "@/clients/mcp-files/is-object";

/**
 * What every MCP File Uploads flow at the gateway shares: the upload target
 * path, lifetimes, the caller's declaration, and the shared-cache records
 * that carry an upload from the call that asks for it, through the upload
 * request, to the retry.
 */

/** `MissingRequiredClientCapabilityError` from the base protocol. */
const MISSING_REQUIRED_CLIENT_CAPABILITY_ERROR_CODE = -32021;

/** Path segment under `/v1/mcp/:profileId` that relayed uploads go to. */
export const FILE_UPLOAD_PATH_SEGMENT = "files";

/**
 * How long the caller's `requestState` for an upload stays redeemable. It has
 * to cover the caller's transfers and the retry after them.
 */
export const FILE_UPLOAD_STATE_TTL_MS = 60 * 60 * 1000;

/** Latest a relayed target may start: well inside the state's lifetime. */
export const RELAY_TARGET_TTL_MS = 30 * 60 * 1000;

/** What a caller declared of the files extension on this request. */
export type FilesDeclaration = { upload: boolean };

/**
 * Read the files extension out of a request's client capabilities.
 *
 * Null when the extension is not declared, including when it carries a
 * `revision` the gateway does not know.
 */
export function readFilesDeclaration(
  clientCapabilities: unknown,
): FilesDeclaration | null {
  if (!isObject(clientCapabilities)) return null;
  const extensions = clientCapabilities.extensions;
  if (!isObject(extensions)) return null;
  const settings = extensions[MCP_FILES_EXTENSION_ID];
  if (!isObject(settings) || settings.revision !== undefined) return null;
  return { upload: isObject(settings.upload) };
}

/** The caller's upload reached its destination. */
export type RelayDone = {
  agentId: string;
  principal: string;
  method: "PUT" | "POST";
  size: number;
  /** What the destination reported, for a built-in tool's retry. */
  receipt?: Record<string, unknown>;
};

export function missingCapabilityError(
  message: string,
  settings: Record<string, unknown>,
): FileCallRpcError {
  return {
    code: MISSING_REQUIRED_CLIENT_CAPABILITY_ERROR_CODE,
    message,
    data: {
      requiredCapabilities: {
        extensions: { [MCP_FILES_EXTENSION_ID]: settings },
      },
    },
  };
}

export function spentStateError(): FileCallRpcError {
  return {
    code: -32602,
    message: "Invalid requestState (already used or expired).",
  };
}

export function requestMismatchError(): FileCallRpcError {
  return { code: -32602, message: "Invalid requestState (request_mismatch)." };
}

/**
 * Answer a repeated upload of a file that already arrived. Nothing is sent
 * on, but the body is held to the file's size like the first one was.
 */
export async function acknowledgeRepeat(
  params: {
    contentLength: number | undefined;
    body: AsyncIterable<Uint8Array>;
  },
  size: number,
): Promise<{ status: number; message?: string }> {
  const wrongSize = (received: number) => ({
    status: 400,
    message: `The upload is ${received} bytes; the file was declared as ${size}.`,
  });
  if (params.contentLength !== undefined && params.contentLength !== size) {
    return wrongSize(params.contentLength);
  }
  let received = 0;
  for await (const chunk of params.body) {
    received += chunk.length;
    if (received > size) return wrongSize(received);
  }
  return received === size ? { status: 200 } : wrongSize(received);
}

export function newOpaqueId(): string {
  return randomBytes(32).toString("base64url");
}

export function sessionKey(id: string) {
  return `${CacheKey.McpFileUploadSession}-${id}` as const;
}

export function relayKey(id: string) {
  return `${CacheKey.McpFileUploadRelay}-${id}` as const;
}

export function relayDoneKey(id: string) {
  return `${CacheKey.McpFileUploadRelayDone}-${id}` as const;
}

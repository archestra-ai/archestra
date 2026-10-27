import { randomUUID } from "node:crypto";
import {
  type AuthExpiredMcpToolError,
  extractMcpToolError,
  TimeInMs,
} from "@archestra/shared";
import {
  type ElicitRequest,
  ElicitResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import logger from "@/logging";
import { McpServerModel } from "@/models";
import {
  clientSupportsInputRequest,
  type InputRequest,
  InputRequiredSignal,
  type InputResponses,
} from "./mrtr";

/**
 * Input-request key for the re-authentication prompt. Distinct from the key
 * upstream elicitations use, so the answer on a retry is never mistaken for
 * an answer to a question the upstream server asked.
 */
const REAUTH_INPUT_REQUEST_KEY = "gateway_reauthentication";

/**
 * Recover a tool call that failed because the caller's own connection to the
 * upstream server needs signing in again.
 *
 * A client that declares URL-mode elicitation is asked to open the
 * re-authentication page (MCP's "URL mode elicitation for OAuth flows"). Once
 * the person finishes there, the gateway runs the call again and returns its
 * real result, so the agent never sees the failure. Any other outcome — the
 * client only supports forms, the person declines, or re-authentication does
 * not land in time — returns the original result, whose text still carries
 * the link for the model to show.
 *
 * Under 2025-11-25 the prompt goes out mid-call and the gateway confirms with
 * `notifications/elicitation/complete`. Under 2026-07-28 it unwinds to an
 * InputRequiredResult, and the retry carrying the answer waits here instead.
 */
export async function recoverExpiredAuthWithUrlElicitation<
  T extends { isError?: boolean | null },
>(params: {
  result: T;
  clientCapabilities: unknown;
  mrtrEnabled: boolean;
  inputResponses?: InputResponses;
  extra: {
    sendRequest: (
      request: ElicitRequest,
      resultSchema: typeof ElicitResultSchema,
      options?: { timeout?: number },
    ) => Promise<unknown>;
    sendNotification: (notification: {
      method: "notifications/elicitation/complete";
      params: { elicitationId: string };
    }) => Promise<void>;
    signal?: AbortSignal;
  };
  rerun: () => Promise<T>;
  agentId: string;
  toolName: string;
}): Promise<T> {
  const {
    result,
    clientCapabilities,
    mrtrEnabled,
    inputResponses,
    extra,
    rerun,
    agentId,
    toolName,
  } = params;

  const expired = expiredOwnCredential(result);
  if (!expired) return result;

  const elicitationId = randomUUID();
  const request = reauthElicitation({ error: expired, elicitationId });
  if (
    !clientSupportsInputRequest({
      clientCapabilities,
      request: request as InputRequest,
    })
  ) {
    return result;
  }

  // Taken before the person can act, so any swap after this is theirs.
  const previousSecretId = await currentSecretId(expired.serverId);
  if (previousSecretId === undefined) return result;

  if (mrtrEnabled) {
    const supplied = inputResponses?.[REAUTH_INPUT_REQUEST_KEY];
    if (supplied === undefined) {
      throw new InputRequiredSignal({
        key: REAUTH_INPUT_REQUEST_KEY,
        request: request as InputRequest,
      });
    }
    if (!isAccepted(supplied)) return result;
  } else {
    let answer: unknown;
    try {
      answer = await extra.sendRequest(request, ElicitResultSchema, {
        timeout: REAUTH_ANSWER_TIMEOUT_MS,
      });
    } catch (error) {
      logger.warn(
        {
          agentId,
          toolName,
          error: error instanceof Error ? error.message : String(error),
        },
        "MCP re-authentication prompt was not completed by caller",
      );
      return result;
    }
    if (!isAccepted(answer)) return result;
  }

  const reauthenticated = await waitForReauthentication({
    serverId: expired.serverId,
    previousSecretId,
    signal: extra.signal,
  });
  if (!reauthenticated) {
    logger.info(
      { agentId, toolName, mcpServerId: expired.serverId },
      "MCP re-authentication did not complete before the gateway stopped waiting",
    );
    return result;
  }

  if (!mrtrEnabled) {
    try {
      await extra.sendNotification({
        method: "notifications/elicitation/complete",
        params: { elicitationId },
      });
    } catch (error) {
      // The client then waits for the person to dismiss its prompt; the call
      // itself still goes through.
      logger.warn(
        {
          agentId,
          toolName,
          error: error instanceof Error ? error.message : String(error),
        },
        "Could not confirm MCP re-authentication to the caller",
      );
    }
  }

  logger.info(
    { agentId, toolName, mcpServerId: expired.serverId },
    "MCP connection re-authenticated; retrying tool call",
  );
  return rerun();
}

// =============================================================================
// Internal helpers
// =============================================================================

/** How long the person has to answer the prompt itself. */
const REAUTH_ANSWER_TIMEOUT_MS = 10 * TimeInMs.Minute;

/** How long to wait, after the person agrees, for the new credential. */
const REAUTH_COMPLETION_TIMEOUT_MS = 10 * TimeInMs.Minute;

const REAUTH_POLL_INTERVAL_MS = 2 * TimeInMs.Second;

/**
 * Only the caller's own personal connection. The backend labels an expired
 * credential "personal" only when the caller owns it; a team or organization
 * credential may be one the caller is not allowed to re-authenticate, so it
 * keeps the plain link.
 */
function expiredOwnCredential(result: {
  isError?: boolean | null;
}): AuthExpiredMcpToolError | null {
  if (!result.isError) return null;
  const error = extractMcpToolError(result);
  if (
    error?.type !== "auth_expired" ||
    error.credentialScope !== "personal" ||
    !error.reauthUrl ||
    !error.serverId
  ) {
    return null;
  }
  return error;
}

function reauthElicitation(params: {
  error: AuthExpiredMcpToolError;
  elicitationId: string;
}): ElicitRequest {
  const { error, elicitationId } = params;
  return {
    method: "elicitation/create",
    params: {
      mode: "url",
      elicitationId,
      url: error.reauthUrl,
      message: `Your connection to "${error.catalogName}" needs you to sign in again. Open the link to re-authenticate; the tool call continues once you finish.`,
    },
  } as ElicitRequest;
}

function isAccepted(answer: unknown): boolean {
  const parsed = ElicitResultSchema.safeParse(answer);
  return parsed.success && parsed.data.action === "accept";
}

/**
 * Every successful re-authentication stores a new secret on the connection,
 * so a changed secret id is the signal that it landed.
 */
async function waitForReauthentication(params: {
  serverId: string;
  previousSecretId: string | null;
  signal?: AbortSignal;
}): Promise<boolean> {
  const { serverId, previousSecretId, signal } = params;
  const deadline = Date.now() + REAUTH_COMPLETION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    await sleep({ ms: REAUTH_POLL_INTERVAL_MS, signal });
    const secretId = await currentSecretId(serverId);
    if (secretId === undefined) return false;
    if (secretId !== previousSecretId) return true;
  }
  return false;
}

/** The connection's secret id, or undefined when the connection is gone. */
async function currentSecretId(
  serverId: string,
): Promise<string | null | undefined> {
  const [server] = await McpServerModel.findByIdsBasic([serverId]);
  return server ? server.secretId : undefined;
}

function sleep(params: { ms: number; signal?: AbortSignal }): Promise<void> {
  const { ms, signal } = params;
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}

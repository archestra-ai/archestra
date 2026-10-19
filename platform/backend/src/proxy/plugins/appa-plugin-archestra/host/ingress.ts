import {
  APPA_SESSION_HEADER,
  type InteractionSource,
  OPENCODE_AGENT_HEADER,
} from "@archestra/shared";
import { isOpenCodeFamilyClient } from "@archestra/shared/opencode-family";
import type { FastifyRequest } from "fastify";
import {
  type CollectedChildReturns,
  collectAndStripChildReturns,
} from "@/openappa/child-return";
import {
  type AppaChildTrajectoryReceipt,
  stripChildTrajectoryReceipts,
} from "@/openappa/child-trajectory-receipt";
import { unwrapCompactionCarriersFromRequest } from "@/openappa/compaction-carrier";
import {
  type AppaDelegationMarker,
  collectDelegationMarkers,
  stripDelegationMarkers,
} from "@/openappa/delegation";
import {
  isAppaChatSource,
  isWellFormedAppaId,
  openappaEnabled,
} from "@/openappa/service";
import type { TrajectoryStamp } from "@/openappa/trajectory-stamp";
import {
  type AppaWireFamily,
  appaWireFamily,
  providerWire,
  restoreTrajectoryStamps,
  restoreTrajectoryStampsInText,
  stripChildTrajectoryReceiptsFromRequest,
  stripSessionReceiptsFromRequest,
} from "@/openappa/wire";
import { parseJsonHeader } from "@/proxy/plugins/appa-plugin-archestra/adapters/trajectory";
import { APPA_CLIENT_ADAPTERS } from "@/proxy/plugins/appa-plugin-archestra/session-identity";
import { collectedDelegationMarkers } from "@/routes/proxy/utils/delegation-markers";
import { getHeaderValue } from "@/routes/proxy/utils/headers/meta-header";
import type { SessionInfo } from "@/routes/proxy/utils/headers/session-id";
import { ApiError } from "@/types";
import { asRecord } from "@/utils/as-record";

/**
 * Removes receipts and delegation markers before forwarding requests.
 * Markers must not reach providers or logs, even when OpenAPPA is off.
 * When active, OpenAPPA resolves extracted markers into lineage evidence.
 * A child return the proxy cannot read is withheld from a governed parent
 * only, and the proxy does not know yet whether OpenAPPA governs this
 * request. Until it does, the first refusal waits in `childReturnRefusal` and
 * that return stays as the client sent it.
 */
export function scrubOpenappaIngress(params: {
  request: FastifyRequest;
  body: unknown;
  interactionType: string;
}): OpenappaIngress {
  const { request, body, interactionType } = params;
  const headers = request.headers;
  const clientCompaction = isClientCompactionRequest({
    body,
    headers,
    url: request.url,
  });

  const requestWireFamily = appaWireFamily(interactionType);
  // A Model Router route that translated the client's wire to one OpenAPPA
  // does not read already scrubbed the client's own wire.
  const clientWire = requestWireFamily
    ? undefined
    : translatedClientWire(request);
  const scrubbed = requestWireFamily
    ? scrubFamilyWire({ request, family: requestWireFamily, body })
    : clientWire?.scrubbed;
  // Restores original provider call IDs before request processing, logging,
  // or plugin rulings: the trajectory stamps first, then any stamp a
  // client copied into text. Neither needs an OpenAPPA session, so no id the
  // proxy gave a client reaches a provider with Guardrails off either.
  const trajectoryStamps = restoreTrajectoryStamps({ interactionType, body });
  const wire = providerWire(interactionType);
  if (wire) restoreTrajectoryStampsInText({ wire, body });

  return {
    clientCompaction,
    strippedReceiptCodes: scrubbed?.strippedReceiptCodes ?? [],
    trajectoryStamps,
    ...(scrubbed?.childReturnRefusal
      ? { childReturnRefusal: scrubbed.childReturnRefusal }
      : {}),
    ...(scrubbed?.delegationMarkers
      ? { delegationMarkers: scrubbed.delegationMarkers }
      : {}),
    ...(scrubbed?.childReturns ? { childReturns: scrubbed.childReturns } : {}),
    ...(scrubbed && scrubbed.childTrajectoryReceipts.length > 0
      ? { childTrajectoryReceipts: scrubbed.childTrajectoryReceipts }
      : {}),
    ...(clientWire
      ? { clientWire: { family: clientWire.family, body: clientWire.body } }
      : {}),
  };
}

/**
 * Scrubs the request a client sent to a Model Router route, on the client's
 * own wire, before the route translates it to a provider wire that OpenAPPA
 * does not read (Gemini, Bedrock Converse, Cohere). Removes the same
 * receipts, markers and child returns that ingress removes from an OpenAPPA
 * wire, so the translation forwards none of them, and keeps what it collected
 * for ingress. `translatedCallId` maps a call id of the client's wire to the
 * id the translated body carries, where the two differ.
 */
export function scrubTranslatedClientWire(params: {
  request: FastifyRequest;
  family: Extract<
    AppaWireFamily,
    "openai:responses" | "openai:chatCompletions"
  >;
  body: unknown;
  translatedCallId?: (callId: string) => string;
}): void {
  const { family } = params;
  const scrubbed = scrubFamilyWire({
    request: params.request,
    family,
    body: params.body,
  });
  const { translatedCallId } = params;
  if (translatedCallId) {
    scrubbed.childReturns = {
      completions: scrubbed.childReturns.completions.map((completion) => ({
        ...completion,
        ...(completion.spawnCallId
          ? { spawnCallId: translatedCallId(completion.spawnCallId) }
          : {}),
        ...(completion.envelopeId
          ? { envelopeId: translatedCallId(completion.envelopeId) }
          : {}),
      })),
    };
  }
  (params.request as RequestWithClientWire).appaTranslatedClientWire = {
    family,
    body: params.body,
    scrubbed,
  };
}

/**
 * An external client's explicit OpenAPPA session names the runtime's root
 * for this request, under the credential's scope, and the proxy log follows
 * the id as the client sent it, so the two records join by that id under
 * the runtime's scope prefix. Chat's header is its conversation id, which the
 * ordinary path already records. Only while OpenAPPA is on: off, the header
 * names nothing. A malformed header is left to the OpenAPPA session check,
 * which refuses it.
 */
export function followAppaSessionHeader(params: {
  headers: Record<string, string | string[] | undefined>;
  source: InteractionSource;
  ordinarySession: SessionInfo;
}): SessionInfo {
  const { ordinarySession } = params;
  const appaSessionHeader =
    openappaEnabled() && !isAppaChatSource(params.source)
      ? params.headers[APPA_SESSION_HEADER.toLowerCase()]
      : undefined;
  // The platform's own requests carry the same id in both headers, and keep
  // their ordinary provenance; only a client that names its session in the
  // OpenAPPA header alone is followed there.
  return isWellFormedAppaId(appaSessionHeader) &&
    ordinarySession.sessionId !== appaSessionHeader
    ? { sessionId: appaSessionHeader, sessionSource: "appa_header" }
    : ordinarySession;
}

// ===

/**
 * Collects and removes the receipts, delegation markers and child returns a
 * request on an OpenAPPA wire carries.
 */
function scrubFamilyWire(params: {
  request: FastifyRequest;
  family: AppaWireFamily;
  body: unknown;
}): ScrubbedClientWire {
  const { request, family, body } = params;
  const headers = request.headers;
  let childReturnRefusal: ApiError | undefined;
  const strippedReceiptCodes = stripSessionReceiptsFromRequest({
    family,
    body,
  });
  const opaqueProofs =
    family === "openai:responses"
      ? unwrapCompactionCarriersFromRequest(body)
      : [];
  const childTrajectoryReceipts = stripChildTrajectoryReceiptsFromRequest({
    family,
    body,
  });
  childTrajectoryReceipts.push(
    ...opaqueProofs.flatMap(
      (proof) => stripChildTrajectoryReceipts(proof).receipts,
    ),
  );
  // A route that translated the wire first collected the markers from the
  // client's own wire; the translated text may no longer end with them.
  const delegationMarkers =
    collectedDelegationMarkers(request) ??
    collectDelegationMarkers({ family, body });
  stripDelegationMarkers({ family, body });
  const nativeClient = APPA_CLIENT_ADAPTERS.find((adapter) =>
    adapter.matches({ headers, requestBody: body }),
  );
  const childReturnOptions = {
    // Kilo Code frames its background tasks as OpenCode does.
    openCodeBackgroundReturns:
      !!nativeClient && isOpenCodeFamilyClient(nativeClient.id),
    codexMailboxReturns: nativeClient?.id === "codex",
    onRefusal: (refusal: ApiError) => {
      childReturnRefusal ??= refusal;
    },
  };
  let childReturns: CollectedChildReturns;
  try {
    childReturns = collectAndStripChildReturns(body, childReturnOptions);
  } catch (error) {
    if (!(error instanceof ApiError) || error.statusCode !== 400) throw error;
    childReturnRefusal = error;
    childReturns = { completions: [] };
  }
  return {
    strippedReceiptCodes,
    childTrajectoryReceipts,
    delegationMarkers,
    childReturns,
    ...(childReturnRefusal ? { childReturnRefusal } : {}),
  };
}

function translatedClientWire(
  request: FastifyRequest,
): TranslatedClientWire | undefined {
  return (request as RequestWithClientWire).appaTranslatedClientWire;
}

// ===

export type OpenappaIngress = {
  /** Read from the body as the client sent it, before any scrubbing. */
  clientCompaction: boolean;
  strippedReceiptCodes: string[];
  trajectoryStamps: TrajectoryStamp[];
  childReturnRefusal?: ApiError;
  delegationMarkers?: AppaDelegationMarker[];
  childReturns?: CollectedChildReturns;
  childTrajectoryReceipts?: AppaChildTrajectoryReceipt[];
  /**
   * The client's own wire, when a Model Router route translated it to a
   * provider wire OpenAPPA does not read. The client's session is read here.
   */
  clientWire?: { family: AppaWireFamily; body: unknown };
};

type ScrubbedClientWire = {
  strippedReceiptCodes: string[];
  childTrajectoryReceipts: AppaChildTrajectoryReceipt[];
  delegationMarkers: AppaDelegationMarker[];
  childReturns: CollectedChildReturns;
  childReturnRefusal?: ApiError;
};

type TranslatedClientWire = {
  family: AppaWireFamily;
  body: unknown;
  scrubbed: ScrubbedClientWire;
};

interface RequestWithClientWire extends FastifyRequest {
  appaTranslatedClientWire?: TranslatedClientWire;
}

/**
 * Detects Claude Code compaction summary requests. Claude Code puts the
 * instruction on a user turn (sometimes also in `system`); scan those text
 * sites only so a large tool result cannot trigger a false re-issue and so
 * the body is never serialized just to search it.
 */
function isClientCompactionRequest(params: {
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  url: string;
}): boolean {
  const { body, headers } = params;
  if (params.url.split("?")[0].endsWith("/responses/compact")) return true;
  const header = (name: string) => getHeaderValue(headers, name);
  if (
    header(OPENCODE_AGENT_HEADER) === "compaction" ||
    header("x-openai-subagent") === "compact"
  )
    return true;
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const request = body as Record<string, unknown>;
  const metadata =
    asRecord(request.client_metadata) ?? asRecord(request.metadata);
  const nestedTurn = metadata?.["x-codex-turn-metadata"];
  if (
    [
      metadata,
      asRecord(metadata?.turn_metadata),
      asRecord(metadata?.turn),
      typeof nestedTurn === "string"
        ? parseJsonHeader(
            { "x-codex-turn-metadata": nestedTurn },
            "x-codex-turn-metadata",
          )
        : asRecord(nestedTurn),
      parseJsonHeader(headers, "x-codex-turn-metadata"),
    ].some((turn) => turn?.request_kind === "compaction")
  )
    return true;
  if (containsCompactionInstruction(request.system)) return true;
  if (!Array.isArray(request.messages)) return false;
  for (let index = request.messages.length - 1; index >= 0; index--) {
    const message = request.messages[index];
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      continue;
    }
    const role = (message as Record<string, unknown>).role;
    if (role !== "user") continue;
    const content = (message as Record<string, unknown>).content;
    const texts =
      typeof content === "string"
        ? [content]
        : Array.isArray(content)
          ? content.flatMap((part) => {
              const text = asRecord(part)?.text;
              return typeof text === "string" ? [text] : [];
            })
          : [];
    // A model spawn prompt can request a summary.
    // The delegation marker distinguishes it from client compaction.
    if (texts.some((text) => text.includes("[appa] delegated trajectory ")))
      return false;
    return containsCompactionInstruction(content);
  }
  return false;
}

function containsCompactionInstruction(value: unknown): boolean {
  if (typeof value === "string") {
    const text = value.trimStart();
    return (
      text.startsWith(CLAUDE_COMPACTION_INSTRUCTION) ||
      text.startsWith(
        `CRITICAL: Respond with TEXT ONLY. ${CLAUDE_COMPACTION_INSTRUCTION}`,
      )
    );
  }
  if (!Array.isArray(value)) return false;
  for (const block of value) {
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    const text = (block as Record<string, unknown>).text;
    if (typeof text === "string" && containsCompactionInstruction(text)) {
      return true;
    }
  }
  return false;
}

const CLAUDE_COMPACTION_INSTRUCTION =
  "Your task is to create a detailed summary of the conversation so far";

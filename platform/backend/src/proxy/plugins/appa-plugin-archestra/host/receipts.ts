import logger from "@/logging";
import OpenAppaSessionModel from "@/models/openappa-session";
import { appendChildTrajectoryReceipt } from "@/openappa/child-trajectory-receipt";
import { wrapCompactionResponse } from "@/openappa/compaction-carrier";
import type { OpenAppaSession } from "@/openappa/service";
import { formatSessionReceipt } from "@/openappa/session-token";
import {
  type AppaWireFamily,
  appendChildTrajectoryReceiptToResponse,
  appendSessionReceiptToResponse,
  declaredToolEntries,
} from "@/openappa/wire";
import {
  APPA_CHILD_TRAJECTORY_RECEIPT,
  type AppaChildTrajectoryReceiptOutput,
} from "@/proxy/plugins/appa-plugin-archestra/types";
import type { LlmProxyRequestContext } from "@/proxy/plugins/registry";
import type { LLMStreamAdapter } from "@/types";
import { asRecord } from "@/utils/as-record";
import { trackBackgroundWork } from "@/utils/background-work";

/**
 * The receipts OpenAPPA attaches to this request's reply: the session receipt
 * a native client echoes back, and the trajectory receipt a governed child
 * returns to its parent.
 */
export class OpenappaReceipts {
  private readonly session: SessionReceipt | undefined;
  private readonly childTrajectory: ChildTrajectoryReceipt | undefined;
  private readonly compactionContext: string | undefined;
  private buffered = false;
  private sessionReceiptPrepared = false;

  private constructor(params: {
    session: SessionReceipt | undefined;
    childTrajectory: ChildTrajectoryReceipt | undefined;
    compactionContext: string | undefined;
  }) {
    this.session = params.session;
    this.childTrajectory = params.childTrajectory;
    this.compactionContext = params.compactionContext;
  }

  static async prepare(params: {
    context: LlmProxyRequestContext;
    body: unknown;
    session: OpenAppaSession | undefined;
    callerId: string | undefined;
    family: AppaWireFamily | undefined;
    hasNativeClientSession: boolean;
    isInternalChat: boolean;
    clientCompaction: boolean;
  }): Promise<OpenappaReceipts | undefined> {
    const { context, body, session, family, clientCompaction } = params;
    const issued = context.resources.get(APPA_CHILD_TRAJECTORY_RECEIPT) as
      | AppaChildTrajectoryReceiptOutput
      | undefined;
    let sessionReceipt: SessionReceipt | undefined;
    if (
      !issued &&
      session &&
      params.hasNativeClientSession &&
      !params.isInternalChat &&
      !hasStructuredOutputConstraint(body) &&
      // The agent loop declares its tools. A client's side calls (Claude
      // Code's auto-mode classifier, its quota check, its next-prompt
      // suggestion) are never shown as the session's reply, so the mark
      // would be lost there and would alter what the client parses.
      (clientCompaction ||
        (declaredToolEntries(body).length > 0 &&
          !isClientPromptSuggestion(body))) &&
      params.callerId &&
      family
    ) {
      const receipt = await OpenAppaSessionModel.ensureReceiptToken({
        organizationId: context.organizationId,
        sessionId: session.session_id,
      });
      if (receipt && (receipt.receiptIssuedAt == null || clientCompaction)) {
        sessionReceipt = {
          family,
          organizationId: context.organizationId,
          sessionId: session.session_id,
          code: receipt.token,
          footer: formatSessionReceipt(receipt.token),
        };
      }
    }
    if (!issued && !sessionReceipt) return undefined;
    return new OpenappaReceipts({
      session: sessionReceipt,
      childTrajectory:
        issued && family && (!issued.inHistory || clientCompaction)
          ? { family, footer: issued.footer }
          : undefined,
      compactionContext: issued?.footer,
    });
  }

  attachToStream(
    adapter: Pick<
      LLMStreamAdapter<unknown, unknown>,
      "setCompactionContext" | "setTextSuffix"
    >,
    options: { buffered: boolean },
  ): void {
    this.buffered = options.buffered;
    if (this.compactionContext) {
      adapter.setCompactionContext?.(this.compactionContext);
    }
    const { session, childTrajectory } = this;
    if (session || childTrajectory) {
      adapter.setTextSuffix?.((text) => {
        if (text.length === 0 && !childTrajectory) return "";
        const parts: string[] = [];
        if (childTrajectory) {
          parts.push(childTrajectory.footer);
        }
        if (session && text.length > 0) {
          this.sessionReceiptPrepared = true;
          if (!options.buffered) markSessionReceiptIssued(session);
          parts.push(session.footer);
        }
        return parts.join("\n");
      });
    }
  }

  prefixRefusal(contentMessage: string): string {
    return !this.buffered && this.childTrajectory
      ? `${this.childTrajectory.footer}\n\n${contentMessage}`
      : contentMessage;
  }

  appendToReplacement(responseText: string): string {
    return this.childTrajectory
      ? appendChildTrajectoryReceipt(responseText, this.childTrajectory.footer)
      : responseText;
  }

  markReleased(decision: "release" | "replace"): void {
    if (this.session && this.sessionReceiptPrepared && decision === "release") {
      markSessionReceiptIssued(this.session);
    }
  }

  decorateResponse<T>(response: T): T {
    let decorated = response;
    if (this.compactionContext) {
      decorated = wrapCompactionResponse(decorated, this.compactionContext);
      const record = asRecord(decorated);
      if (
        record?.object === "response.compaction" ||
        (Array.isArray(record?.output) &&
          record.output.length > 0 &&
          record.output.every((item) => asRecord(item)?.type === "compaction"))
      ) {
        // Opaque clients keep the compaction item itself, not synthetic messages.
        return decorated;
      }
    }
    if (!this.session && !this.childTrajectory) {
      return decorated;
    }
    const outbound = structuredClone(decorated);
    if (this.childTrajectory) {
      appendChildTrajectoryReceiptToResponse({
        family: this.childTrajectory.family,
        response: outbound,
        footer: this.childTrajectory.footer,
      });
    }
    if (this.session) {
      const appended = appendSessionReceiptToResponse({
        family: this.session.family,
        response: outbound,
        code: this.session.code,
      });
      if (appended) markSessionReceiptIssued(this.session);
    }
    return outbound;
  }
}

type SessionReceipt = {
  family: AppaWireFamily;
  organizationId: string;
  sessionId: string;
  code: string;
  footer: string;
};

type ChildTrajectoryReceipt = {
  family: AppaWireFamily;
  footer: string;
};

function markSessionReceiptIssued(receipt: SessionReceipt): void {
  trackBackgroundWork(
    OpenAppaSessionModel.markReceiptIssued({
      organizationId: receipt.organizationId,
      sessionId: receipt.sessionId,
    }).catch((error) => {
      logger.warn(
        { err: error, sessionId: receipt.sessionId },
        "OpenAPPA failed to record session receipt issuance",
      );
    }),
  );
}

/**
 * Claude Code's next-prompt suggestion: after an answer, it asks the model
 * what the user might type next, with the session's tools and history, and
 * shows the reply as a hint in the input box. Its last user message carries
 * this fixed instruction.
 */
function isClientPromptSuggestion(body: unknown): boolean {
  const messages = asRecord(body)?.messages;
  if (!Array.isArray(messages)) return false;
  const content = asRecord(messages.at(-1))?.content;
  const texts =
    typeof content === "string"
      ? [content]
      : Array.isArray(content)
        ? content.map((part) => asRecord(part)?.text)
        : [];
  return texts.some(
    (text) =>
      typeof text === "string" &&
      text.trimStart().startsWith(PROMPT_SUGGESTION_INSTRUCTION),
  );
}

const PROMPT_SUGGESTION_INSTRUCTION = "[SUGGESTION MODE:";

/** Returns true if the request requires JSON-only structured output. */
function hasStructuredOutputConstraint(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const request = body as Record<string, unknown>;
  const format =
    request.response_format ??
    (request.text && typeof request.text === "object"
      ? (request.text as Record<string, unknown>).format
      : undefined) ??
    (request.output_config && typeof request.output_config === "object"
      ? (request.output_config as Record<string, unknown>).format
      : undefined) ??
    request.output_format;
  if (!format || typeof format !== "object" || Array.isArray(format)) {
    return false;
  }
  const type = (format as Record<string, unknown>).type;
  return type === "json_schema" || type === "json_object";
}

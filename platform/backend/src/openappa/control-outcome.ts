import type { EncryptedChatAuditContext } from "@/content-encryption/encrypted-chat";
import type { EncryptedChatAuditDisposition } from "@/routes/proxy/utils/encrypted-chat-session";
import { ApiError } from "@/types";
import { AppaRewriteReplay, type ControlOutcomeClass } from "./rewrite-replay";
import type { OpenAppaSession } from "./service";

export { controlEchoMatches } from "./control-echo";

export type { ControlOutcomeClass };

/**
 * The key boundary for a control receipt.
 *
 * External MCP clients have neither flag: the server at-rest key is the same
 * one `AppaRewriteReplay.open` uses for `{ kind: "none" }`.
 *
 * An encrypted chat presents `encryptedChatAudit.dek`. That DEK is the write
 * key. `suppressContentLogging` without a DEK, or an audit object with an
 * empty DEK, is the redact path: this throws before any rewrite write. No
 * key is invented and nothing is stored under the server key.
 */
export function controlStorageDisposition(context: {
  encryptedChatAudit?: EncryptedChatAuditContext | null;
  suppressContentLogging?: boolean;
}): EncryptedChatAuditDisposition {
  const audit = context.encryptedChatAudit;
  if (audit?.dek && audit.dek.length > 0) {
    return { kind: "encrypt", audit };
  }
  if (context.suppressContentLogging || audit) {
    throw new ApiError(409, "OpenAPPA cannot retain this control result");
  }
  return { kind: "none" };
}

/**
 * Batch-reads receipts for this request. `replay` is the request's already
 * opened facade when the proxy has one. A missing or expired group yields
 * no bytes.
 */
export async function readControlReceipts(params: {
  session: OpenAppaSession;
  toolCallIds: readonly string[];
  replay?: AppaRewriteReplay;
  encryptedChat?: EncryptedChatAuditDisposition;
}): Promise<Map<string, ControlReceipt>> {
  return AppaRewriteReplay.readControlReceipts(params);
}

type ControlReceipt = {
  outcome: ControlOutcomeClass;
  bytes: string;
};

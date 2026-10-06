import { createHash } from "node:crypto";
import type { A2AAttachment } from "@/agents/a2a-executor";

export type AdmittedPart = {
  id: string;
  text: string;
  outputSource: "tool" | "runtime";
};

/** Decode only admitted bytes; runtime replacements never retain original files. */
export function applyAdmittedParts(params: {
  admitted: readonly AdmittedPart[];
  body: string;
  history: readonly string[];
  attachments: readonly A2AAttachment[];
}):
  | { ok: true; body: string; history: string[]; attachments: A2AAttachment[] }
  | { ok: false } {
  const byId = new Map(params.admitted.map((part) => [part.id, part]));
  const body = byId.get("");
  if (!body) return { ok: false };
  const notes: string[] = [];
  if (body.outputSource === "runtime") notes.push(body.text);
  const history: string[] = [];
  for (let index = 0; index < params.history.length; index++) {
    const part = byId.get(`history:${index}`);
    if (part) history.push(part.text);
  }
  const attachments: A2AAttachment[] = [];
  for (let index = 0; index < params.attachments.length; index++) {
    const part = byId.get(`attachment:${index}`);
    const original = params.attachments[index];
    if (!part || !original) continue;
    if (part.outputSource === "runtime") {
      if (part.text.trim()) notes.push(part.text);
      continue;
    }
    attachments.push({ ...original, contentBase64: part.text });
  }
  return {
    ok: true,
    body: [body.outputSource === "tool" ? body.text : "", ...notes]
      .filter((part) => part.trim().length > 0)
      .join("\n\n"),
    history,
    attachments,
  };
}

/** Reserved helper install. The bridge answers native consults for this id. */
export const NATIVE_HELPER_INSTALL_ID = "00000000-0000-4000-8000-0000000000aa";

export const NATIVE_INGRESS_TOOL = "native_ingress";
export const NATIVE_REPLY_TOOL = "native_reply";
export const NATIVE_INGRESS_CANONICAL = "host/archestra/native_ingress";
export const NATIVE_REPLY_CANONICAL = "host/archestra/native_reply";

export const NATIVE_PROVIDERS = [
  "slack",
  "ms-teams",
  "telegram",
  "outlook",
] as const;
export type NativeProvider = (typeof NATIVE_PROVIDERS)[number];
export type NativeTrust = "trusted" | "suspicious";

export interface NativeRoomRef {
  provider: NativeProvider;
  workspaceId: string;
  channelId: string;
  threadId: string;
}

export type NativeReaders =
  | { status: "resolved"; emails: string[] }
  | { status: "unresolved" };

export interface NativeRoomFacts {
  ref: NativeRoomRef;
  trust: NativeTrust;
  readers: NativeReaders;
}

export interface NativeSnapshot {
  roomId: string;
  organizationId: string;
  ref: NativeRoomRef;
  trust: NativeTrust;
  readers: NativeReaders;
}

/** sha256 of the exact bytes. Binds the operation; it is not a label. */
export function contentDigest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Immutable snapshot id. A membership or trust change is a different id.
 * The logical ref is not the id.
 */
export function nativeRoomId(params: {
  organizationId: string;
  facts: NativeRoomFacts;
}): string {
  const readers =
    params.facts.readers.status === "unresolved"
      ? "unresolved"
      : `resolved\n${normalizeEmails(params.facts.readers.emails).join("\n")}`;
  return createHash("sha256")
    .update(
      JSON.stringify([
        "v2",
        params.organizationId,
        params.facts.ref.provider,
        params.facts.ref.workspaceId,
        params.facts.ref.channelId,
        params.facts.ref.threadId,
        params.facts.trust,
        readers,
      ]),
      "utf8",
    )
    .digest("hex");
}

export function normalizeEmails(emails: readonly string[]): string[] {
  return [...new Set(emails.map((email) => email.trim().toLowerCase()))]
    .filter((email) => email.length > 0)
    .sort();
}

export function sameFacts(
  left: NativeRoomFacts,
  right: NativeRoomFacts,
): boolean {
  if (
    left.ref.provider !== right.ref.provider ||
    left.ref.workspaceId !== right.ref.workspaceId ||
    left.ref.channelId !== right.ref.channelId ||
    left.ref.threadId !== right.ref.threadId ||
    left.trust !== right.trust ||
    left.readers.status !== right.readers.status
  ) {
    return false;
  }
  if (left.readers.status === "unresolved") return true;
  const rightEmails =
    right.readers.status === "resolved" ? right.readers.emails : [];
  const a = normalizeEmails(left.readers.emails);
  const b = normalizeEmails(rightEmails);
  return a.length === b.length && a.every((email, index) => email === b[index]);
}

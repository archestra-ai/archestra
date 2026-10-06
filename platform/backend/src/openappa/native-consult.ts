import OpenAppaNativeRoomModel from "@/models/openappa-native-room";
import {
  NATIVE_HELPER_INSTALL_ID,
  NATIVE_INGRESS_CANONICAL,
  NATIVE_INGRESS_TOOL,
  NATIVE_REPLY_CANONICAL,
  NATIVE_REPLY_TOOL,
} from "@/openappa/native-contract";

export { NATIVE_HELPER_INSTALL_ID };

type ConsultOutcome =
  | { kind: "answered"; answer: { version: 1; answer: unknown } }
  | { kind: "failed" };

/** In-process answers for the host's native room consults. */
export async function answerNativeConsult(params: {
  externalName: string;
  request: string;
}): Promise<ConsultOutcome> {
  const body = parse(params.request);
  if (!body) return { kind: "failed" };
  switch (params.externalName) {
    case "native-room":
      return answerContext(body);
    case "native":
      return answerAudience(body);
    case "native.source-trust":
      return answerIngress(body);
    case "native.reply-check":
      return answerReply(body);
    default:
      return { kind: "failed" };
  }
}

async function answerContext(
  body: Record<string, unknown>,
): Promise<ConsultOutcome> {
  const artifact = objectOf(body.artifact);
  const tool = typeof artifact?.tool === "string" ? artifact.tool : "";
  if (!isNativeTool(tool)) return envelope(null);
  const roomId = roomIdOf(artifact?.arguments);
  if (!roomId) return envelope({ missing: true });
  const snapshot = await OpenAppaNativeRoomModel.findByRoomId(roomId);
  if (!snapshot) return envelope({ missing: true, room_id: roomId });
  return envelope({
    room_id: snapshot.roomId,
    trust: snapshot.trust,
    readers: snapshot.readers.status,
  });
}

async function answerAudience(
  body: Record<string, unknown>,
): Promise<ConsultOutcome> {
  const artifact = objectOf(body.artifact);
  const selector =
    typeof artifact?.selector === "string" ? artifact.selector : "";
  const roomId = selector.startsWith("room/")
    ? selector.slice("room/".length)
    : "";
  if (!roomId || roomId.includes("/") || artifact?.member) {
    return { kind: "failed" };
  }
  const snapshot = await OpenAppaNativeRoomModel.findByRoomId(roomId);
  if (!snapshot || snapshot.readers.status !== "resolved") {
    return { kind: "failed" };
  }
  return envelope({ members: snapshot.readers.emails });
}

async function answerIngress(
  body: Record<string, unknown>,
): Promise<ConsultOutcome> {
  const facts = await contextFacts(body);
  if (!facts?.room_id || facts.missing || !facts.readers) {
    return { kind: "failed" };
  }
  const delta: Record<string, unknown> = {
    audience: [`@native:room/${facts.room_id}`],
  };
  const lowRank = lowestDeclaredRank(body);
  if (facts.trust === "suspicious") {
    if (!lowRank) return { kind: "failed" };
    delta.trust = lowRank;
  }
  return envelope({
    delta,
    requires: { history: [], attention: [] },
    emits: ["native.admitted"],
  });
}

async function answerReply(
  body: Record<string, unknown>,
): Promise<ConsultOutcome> {
  const facts = await contextFacts(body);
  if (!facts?.room_id || facts.missing || !facts.readers) {
    return { kind: "failed" };
  }
  return envelope({
    delta: {},
    requires: {
      audience: { contains: [`@native:room/${facts.room_id}`] },
      history: [{ contains: "native.admitted" }],
      attention: [],
    },
    emits: ["native.reply"],
  });
}

async function contextFacts(body: Record<string, unknown>): Promise<{
  room_id?: string;
  trust?: string;
  readers?: string;
  missing?: boolean;
} | null> {
  const artifact = objectOf(body.artifact);
  const args = objectOf(artifact?.args);
  const context = objectOf(artifact?.context);
  const provider = objectOf(context?.["native-room"]);
  if (provider?.error) return null;
  const answer = objectOf(provider?.answer);
  if (!answer) return null;
  const argued = roomIdOf(args?.arguments);
  if (
    typeof answer.room_id === "string" &&
    argued &&
    answer.room_id !== argued
  ) {
    return null;
  }
  return {
    room_id: typeof answer.room_id === "string" ? answer.room_id : argued,
    trust: typeof answer.trust === "string" ? answer.trust : undefined,
    readers: typeof answer.readers === "string" ? answer.readers : undefined,
    missing: answer.missing === true,
  };
}

function lowestDeclaredRank(body: Record<string, unknown>): string | undefined {
  const declaration = objectOf(body.declaration);
  const ranks = declaration?.trust_ranks;
  if (!Array.isArray(ranks)) return undefined;
  const rank = ranks.find((entry) => typeof entry === "string");
  return typeof rank === "string" ? rank : undefined;
}

function isNativeTool(tool: string): boolean {
  return (
    tool === NATIVE_INGRESS_TOOL ||
    tool === NATIVE_REPLY_TOOL ||
    tool === NATIVE_INGRESS_CANONICAL ||
    tool === NATIVE_REPLY_CANONICAL
  );
}

function roomIdOf(value: unknown): string | undefined {
  const args = objectOf(value);
  return typeof args?.room_id === "string" && args.room_id.length > 0
    ? args.room_id
    : undefined;
}

function envelope(answer: unknown): ConsultOutcome {
  return { kind: "answered", answer: { version: 1, answer } };
}

function parse(request: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(request) as unknown;
    return objectOf(parsed);
  } catch {
    return null;
  }
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

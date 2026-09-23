import { ApiError } from "@/types";

export function unwrapCompactionCarriersFromRequest(body: unknown): string[] {
  if (!isRecord(body) || !Array.isArray(body.input)) return [];

  const proofs: string[] = [];
  let candidates = 0;
  for (const item of body.input) {
    if (!isCompactionItem(item)) continue;
    if (!item.encrypted_content.startsWith(CARRIER_PREFIX)) continue;
    candidates++;
    if (candidates > MAX_COMPACTION_ITEMS) {
      throw new ApiError(400, "Too many OpenAI compaction carriers");
    }
    const carrier = parseCarrier(item.encrypted_content);
    if (!carrier) continue;

    item.encrypted_content = carrier.encryptedContent;
    proofs.push(carrier.proof);
  }
  return proofs;
}

export function wrapCompactionItem<T>(item: T, proof: string): T {
  if (!isCompactionItem(item)) return item;
  validateProof(proof);

  // Terminal stream events and completed responses can share an item.
  // Applies context idempotently instead of nesting proxy envelopes.
  if (parseCarrier(item.encrypted_content)) return item;
  if (
    Buffer.byteLength(item.encrypted_content, "utf8") >
    MAX_ENCRYPTED_CONTENT_BYTES
  ) {
    throw new ApiError(502, "OpenAI compaction item exceeds the proxy limit");
  }

  const claims: CarrierClaims = [1, item.encrypted_content, proof];
  const canonical = JSON.stringify(claims);
  if (Buffer.byteLength(canonical, "utf8") > MAX_CLAIMS_BYTES) {
    throw new ApiError(
      502,
      "OpenAI compaction carrier exceeds the proxy limit",
    );
  }
  return {
    ...item,
    encrypted_content: `${CARRIER_PREFIX}${Buffer.from(canonical, "utf8").toString("base64url")}`,
  };
}

export function wrapCompactionResponse<T>(response: T, proof: string): T {
  if (!isRecord(response) || !Array.isArray(response.output)) return response;

  let changed = false;
  const output = response.output.map((item) => {
    const wrapped = wrapCompactionItem(item, proof);
    if (wrapped !== item) changed = true;
    return wrapped;
  });
  return changed ? ({ ...response, output } as T) : response;
}

// === Internal helpers ===

const CARRIER_PREFIX = "appac1-";
const MAX_COMPACTION_ITEMS = 64;
const MAX_ENCRYPTED_CONTENT_BYTES = 32 * 1024 * 1024;
const MAX_PROOF_BYTES = 64 * 1024;
const MAX_CLAIMS_BYTES = MAX_ENCRYPTED_CONTENT_BYTES + MAX_PROOF_BYTES + 64;

type CarrierClaims = readonly [1, string, string];

function parseCarrier(
  value: string,
): { encryptedContent: string; proof: string } | undefined {
  if (!value.startsWith(CARRIER_PREFIX)) return undefined;
  const payload = value.slice(CARRIER_PREFIX.length);
  if (
    payload.length === 0 ||
    payload.length > encodedLength(MAX_CLAIMS_BYTES)
  ) {
    return undefined;
  }

  try {
    const decoded = Buffer.from(payload, "base64url");
    if (
      decoded.byteLength > MAX_CLAIMS_BYTES ||
      decoded.toString("base64url") !== payload
    ) {
      return undefined;
    }
    const canonical = decoded.toString("utf8");
    if (!Buffer.from(canonical, "utf8").equals(decoded)) return undefined;
    const claims: unknown = JSON.parse(canonical);
    if (!isCarrierClaims(claims) || JSON.stringify(claims) !== canonical) {
      return undefined;
    }
    const [, encryptedContent, proof] = claims;
    if (
      Buffer.byteLength(encryptedContent, "utf8") >
        MAX_ENCRYPTED_CONTENT_BYTES ||
      Buffer.byteLength(proof, "utf8") > MAX_PROOF_BYTES
    ) {
      return undefined;
    }
    return { encryptedContent, proof };
  } catch {
    return undefined;
  }
}

function validateProof(proof: string): void {
  if (
    proof.length === 0 ||
    Buffer.byteLength(proof, "utf8") > MAX_PROOF_BYTES
  ) {
    throw new ApiError(500, "Invalid OpenAPPA compaction context");
  }
}

function isCarrierClaims(value: unknown): value is CarrierClaims {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value[0] === 1 &&
    typeof value[1] === "string" &&
    typeof value[2] === "string" &&
    value[2].length > 0
  );
}

function isCompactionItem(value: unknown): value is Record<string, unknown> & {
  type: "compaction";
  encrypted_content: string;
} {
  return (
    isRecord(value) &&
    value.type === "compaction" &&
    typeof value.encrypted_content === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function encodedLength(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

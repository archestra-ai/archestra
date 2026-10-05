import { createHmac, timingSafeEqual } from "node:crypto";
import { CONNECTION_SETUP_WINDOW_MS } from "@archestra/shared/connection-setup";

const PREFIX = "cs1_";
const SIGNING_DOMAIN = "archestra-connection-mcp-setup-v1:";

export const CONNECTION_SETUP_CONTEXT_PARAM = "archestra_setup_ctx";

interface SetupContext {
  aud: "connection-mcp-setup";
  userId: string;
  organizationId: string;
  gatewayId: string;
  setupId: string;
  issuedAt: number;
  expiresAt: number;
}

/** A short-lived policy context, never an MCP authentication credential. */
export function issueConnectionSetupContext(params: {
  userId: string;
  organizationId: string;
  gatewayId: string;
  setupId: string;
  secret: string;
}): string {
  if (!params.secret)
    throw new Error("Connection setup signing key is missing");
  const issuedAt = Date.now();
  const claims: SetupContext = {
    aud: "connection-mcp-setup",
    userId: params.userId,
    organizationId: params.organizationId,
    gatewayId: params.gatewayId,
    setupId: params.setupId,
    issuedAt,
    expiresAt: issuedAt + CONNECTION_SETUP_WINDOW_MS,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${PREFIX}${payload}.${signature(payload, params.secret).toString("base64url")}`;
}

/** Validate the approved install context only after normal gateway authentication. */
export function verifyConnectionSetupContext(params: {
  token: string;
  userId: string;
  organizationId: string;
  gatewayId: string;
  secret: string;
}): boolean {
  if (
    !params.secret ||
    !params.token.startsWith(PREFIX) ||
    params.token.length > 2048
  ) {
    return false;
  }
  const parts = params.token.slice(PREFIX.length).split(".");
  if (parts.length !== 2) return false;
  const [payload, encodedSignature] = parts;
  if (!payload || !encodedSignature) return false;
  const received = Buffer.from(encodedSignature, "base64url");
  const expected = signature(payload, params.secret);
  if (
    received.toString("base64url") !== encodedSignature ||
    received.length !== expected.length ||
    !timingSafeEqual(received, expected)
  ) {
    return false;
  }
  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Partial<SetupContext>;
    const now = Date.now();
    return (
      claims.aud === "connection-mcp-setup" &&
      claims.userId === params.userId &&
      claims.organizationId === params.organizationId &&
      claims.gatewayId === params.gatewayId &&
      typeof claims.setupId === "string" &&
      claims.setupId.length > 0 &&
      typeof claims.issuedAt === "number" &&
      typeof claims.expiresAt === "number" &&
      claims.issuedAt <= now &&
      claims.expiresAt > now &&
      claims.expiresAt - claims.issuedAt === CONNECTION_SETUP_WINDOW_MS
    );
  } catch {
    return false;
  }
}

function signature(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret)
    .update(SIGNING_DOMAIN)
    .update(payload)
    .digest();
}

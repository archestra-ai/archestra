import type { NextFunction, Request, Response } from "express";
import type { JWTPayload } from "jose";
import { createRemoteJWKSet, jwtVerify } from "jose";

export interface AuthContext {
  sub: string;
  email?: string;
  name?: string;
  preferredUsername?: string;
  demoTokenValue?: string;
  issuer?: string;
  audience?: string | string[];
  roles: string[];
  rawToken: string;
  authorizationHeader: string;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

const JWKS_URL = process.env.JWKS_URL;
const JWT_ISSUER = process.env.JWT_ISSUER;
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || "mcp-server";
const MCP_SERVER_URL = process.env.MCP_SERVER_URL || "http://localhost:3456";

export async function verifyToken(token: string): Promise<AuthContext> {
  if (!JWKS_URL) {
    throw new Error("JWKS_URL is not configured");
  }
  if (!JWT_ISSUER) {
    throw new Error("JWT_ISSUER is not configured");
  }

  const jwks = createRemoteJWKSet(new URL(JWKS_URL));
  const { payload } = await jwtVerify(token, jwks, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    clockTolerance: 30,
  });

  return buildAuthContext(payload, token);
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    res
      .status(401)
      .set(
        "WWW-Authenticate",
        `Bearer resource_metadata="${MCP_SERVER_URL}/.well-known/oauth-protected-resource"`,
      )
      .json({ error: "Missing or invalid Authorization header" });
    return;
  }

  const token = authHeader.slice(7);

  try {
    req.auth = await verifyToken(token);
    next();
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Token verification failed";
    res.status(401).json({ error: "Invalid token", details: message });
  }
}

export function buildAuthContext(
  payload: JWTPayload,
  token: string,
): AuthContext {
  if (!payload.sub) {
    throw new Error("JWT payload is missing required sub claim");
  }

  return {
    sub: payload.sub,
    email: payload.email as string | undefined,
    name: payload.name as string | undefined,
    preferredUsername: payload.preferred_username as string | undefined,
    demoTokenValue: payload.demo_token_value as string | undefined,
    issuer: payload.iss as string | undefined,
    audience: payload.aud as string | string[] | undefined,
    roles: (payload.realm_roles as string[]) || [],
    rawToken: token,
    authorizationHeader: `Bearer ${token}`,
  };
}

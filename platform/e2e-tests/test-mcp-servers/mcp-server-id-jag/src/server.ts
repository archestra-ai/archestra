// biome-ignore-all lint/suspicious/noConsole: test mcp server uses console for logging
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Express, type Request } from "express";
import {
  exportJWK,
  generateKeyPair,
  importJWK,
  type JWK,
  jwtVerify,
  SignJWT,
} from "jose";
import { z } from "zod";

const JWT_BEARER_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const ID_JAG_JWT_TYPE = "oauth-id-jag+jwt";
const ID_JAG_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id-jag";
const ACCESS_TOKEN_TTL_SECONDS = 60 * 10;
const DEFAULT_PORT = 3458;
const DEFAULT_BASE_URL = `http://localhost:${DEFAULT_PORT}`;
const DEFAULT_GATEWAY_AUDIENCE = "id-jag-gateway-client";
const DEFAULT_CLIENT_ID = "id-jag-resource-client";
const DEFAULT_CLIENT_SECRET = "id-jag-resource-secret";

type ServerConfig = {
  port: number;
  baseUrl: string;
  gatewayAudience: string;
  clientId: string;
  clientSecret: string;
};

type DemoIdJagClaims = {
  subject: string;
  email?: string;
  name?: string;
  audience: string[];
  clientId: string;
  resource: string;
  scope: string;
};

type MintedAccessToken = {
  bearerToken: string;
  clientId: string;
  subject: string;
  email?: string;
  name?: string;
  issuer: string;
  resource: string;
  scope: string;
  assertionJwtId: string;
  assertionType: typeof ID_JAG_JWT_TYPE;
  tokenKind: "mcp_server_access_token";
  obtainedVia: "id_jag_jwt_bearer";
  expiresAtEpochSeconds: number;
};

export async function createApp(
  config: Partial<ServerConfig> = {},
): Promise<Express> {
  const resolvedConfig = getServerConfig(config);
  const demoIdentityProvider = await DemoIdentityProvider.create({
    issuer: `${resolvedConfig.baseUrl}/demo-idp`,
  });
  const accessTokenStore = new AccessTokenStore();
  const app = express();

  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => {
    res.json({
      resource: `${resolvedConfig.baseUrl}/mcp`,
      authorization_servers: [resolvedConfig.baseUrl],
      bearer_methods_supported: ["header"],
      scopes_supported: ["whoami"],
    });
  });

  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      issuer: resolvedConfig.baseUrl,
      token_endpoint: `${resolvedConfig.baseUrl}/token`,
      jwks_uri: `${demoIdentityProvider.issuer}/jwks`,
      grant_types_supported: [JWT_BEARER_GRANT_TYPE],
      token_endpoint_auth_methods_supported: [
        "client_secret_basic",
        "client_secret_post",
      ],
      id_jag_token_type: ID_JAG_TOKEN_TYPE,
    });
  });

  app.get("/demo-idp/.well-known/openid-configuration", (_req, res) => {
    res.json({
      issuer: demoIdentityProvider.issuer,
      jwks_uri: `${demoIdentityProvider.issuer}/jwks`,
    });
  });

  app.get("/demo-idp/jwks", (_req, res) => {
    res.json({
      keys: [demoIdentityProvider.publicJwk],
    });
  });

  app.post("/demo-idp/mint", async (req, res) => {
    const body = MintIdJagRequestSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json(oauthError("invalid_request", body.error.message));
      return;
    }

    const assertion = await demoIdentityProvider.mintIdJag({
      subject: body.data.sub,
      email: body.data.email,
      name: body.data.name,
      audience: body.data.audience ?? [
        resolvedConfig.gatewayAudience,
        resolvedConfig.baseUrl,
        `${resolvedConfig.baseUrl}/mcp`,
      ],
      clientId: body.data.client_id ?? resolvedConfig.clientId,
      resource: body.data.resource ?? `${resolvedConfig.baseUrl}/mcp`,
      scope: body.data.scope ?? "whoami",
    });

    res.json({
      assertion,
      assertion_type: ID_JAG_TOKEN_TYPE,
      issuer: demoIdentityProvider.issuer,
      expires_in: 300,
    });
  });

  app.post("/token", async (req, res) => {
    const clientAuth = authenticateClient(req, resolvedConfig);
    if (!clientAuth) {
      res
        .status(401)
        .setHeader("WWW-Authenticate", 'Basic realm="mcp-server-id-jag"')
        .json(oauthError("invalid_client", "Client authentication failed"));
      return;
    }

    const body = TokenRequestSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json(oauthError("invalid_request", body.error.message));
      return;
    }

    if (body.data.grant_type !== JWT_BEARER_GRANT_TYPE) {
      res
        .status(400)
        .json(
          oauthError(
            "unsupported_grant_type",
            `Only ${JWT_BEARER_GRANT_TYPE} is supported`,
          ),
        );
      return;
    }

    try {
      const claims = await demoIdentityProvider.verifyIdJag({
        assertion: body.data.assertion,
        audience: resolvedConfig.baseUrl,
        clientId: resolvedConfig.clientId,
      });

      const mintedToken = accessTokenStore.issue({
        clientId: resolvedConfig.clientId,
        subject: claims.sub,
        email: claims.email,
        name: claims.name,
        issuer: claims.iss,
        resource: claims.resource,
        scope: claims.scope,
        assertionJwtId: claims.jti,
        assertionType: ID_JAG_JWT_TYPE,
        tokenKind: "mcp_server_access_token",
        obtainedVia: "id_jag_jwt_bearer",
      });

      res.json({
        access_token: mintedToken.bearerToken,
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        scope: mintedToken.scope,
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
      });
    } catch (error) {
      res
        .status(400)
        .json(
          oauthError(
            "invalid_grant",
            error instanceof Error
              ? error.message
              : "The supplied ID-JAG was rejected",
          ),
        );
    }
  });

  app.post("/mcp", async (req, res) => {
    const authorizationHeader = req.headers.authorization ?? "";
    const accessToken = accessTokenStore.read(extractBearerToken(req));
    if (!accessToken) {
      res
        .status(401)
        .setHeader(
          "WWW-Authenticate",
          `Bearer resource_metadata="${resolvedConfig.baseUrl}/.well-known/oauth-protected-resource/mcp"`,
        )
        .json(
          oauthError("invalid_token", "A minted MCP access token is required"),
        );
      return;
    }

    const server = new McpServer({
      name: "id-jag-demo-server",
      version: "1.0.0",
    });
    registerTools(server, {
      accessToken,
      authorizationHeader,
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    await server.close();
  });

  app.get("/mcp", (_req, res) => {
    res.status(405).json({ error: "Method not allowed" });
  });

  app.delete("/mcp", (_req, res) => {
    res.status(405).json({ error: "Method not allowed" });
  });

  return app;
}

export async function startServer(
  config: Partial<ServerConfig> = {},
): Promise<void> {
  const resolvedConfig = getServerConfig(config);
  const app = await createApp(resolvedConfig);

  await new Promise<void>((resolve, reject) => {
    const server = app.listen(resolvedConfig.port, "0.0.0.0", () => {
      console.log(`mcp-server-id-jag listening on ${resolvedConfig.baseUrl}`);
      resolve();
    });
    server.once("error", reject);
  });
}

const TokenRequestSchema = z.object({
  grant_type: z.string(),
  assertion: z.string().min(1),
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
});

const MintIdJagRequestSchema = z.object({
  sub: z.string().min(1),
  email: z.string().email().optional(),
  name: z.string().optional(),
  audience: z.array(z.string()).optional(),
  client_id: z.string().optional(),
  resource: z.string().url().optional(),
  scope: z.string().optional(),
});

const VerifiedIdJagClaimsSchema = z.object({
  iss: z.string().url(),
  sub: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  iat: z.number(),
  jti: z.string(),
  client_id: z.string(),
  resource: z.string().url(),
  scope: z.string(),
  email: z.string().email().optional(),
  name: z.string().optional(),
});

type VerifiedIdJagClaims = z.infer<typeof VerifiedIdJagClaimsSchema>;

class DemoIdentityProvider {
  public static async create(params: {
    issuer: string;
  }): Promise<DemoIdentityProvider> {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const publicJwk = await exportJWK(publicKey);
    const privateJwk = await exportJWK(privateKey);
    const keyId = crypto.randomUUID();

    return new DemoIdentityProvider({
      issuer: params.issuer,
      keyId,
      publicJwk: { ...publicJwk, kid: keyId, use: "sig", alg: "RS256" },
      privateJwk: { ...privateJwk, kid: keyId, use: "sig", alg: "RS256" },
    });
  }

  public readonly issuer: string;
  public readonly publicJwk: JWK;

  private readonly keyId: string;
  private readonly privateJwk: JWK;

  private constructor(params: {
    issuer: string;
    keyId: string;
    publicJwk: JWK;
    privateJwk: JWK;
  }) {
    this.issuer = params.issuer;
    this.keyId = params.keyId;
    this.publicJwk = params.publicJwk;
    this.privateJwk = params.privateJwk;
  }

  public async mintIdJag(claims: DemoIdJagClaims): Promise<string> {
    const privateKey = await importJWK(this.privateJwk, "RS256");

    return new SignJWT({
      client_id: claims.clientId,
      resource: claims.resource,
      scope: claims.scope,
      email: claims.email,
      name: claims.name,
    })
      .setProtectedHeader({
        alg: "RS256",
        kid: this.keyId,
        typ: ID_JAG_JWT_TYPE,
      })
      .setIssuer(this.issuer)
      .setSubject(claims.subject)
      .setAudience(claims.audience)
      .setJti(crypto.randomUUID())
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
  }

  public async verifyIdJag(params: {
    assertion: string;
    audience: string;
    clientId: string;
  }): Promise<VerifiedIdJagClaims> {
    const publicKey = await importJWK(this.publicJwk, "RS256");
    const verified = await jwtVerify(params.assertion, publicKey, {
      issuer: this.issuer,
      audience: params.audience,
    });

    if (verified.protectedHeader.typ !== ID_JAG_JWT_TYPE) {
      throw new Error(`JWT typ must be ${ID_JAG_JWT_TYPE}`);
    }

    const claims = VerifiedIdJagClaimsSchema.parse(verified.payload);
    if (claims.client_id !== params.clientId) {
      throw new Error("ID-JAG client_id does not match the resource client");
    }

    return claims;
  }
}

class AccessTokenStore {
  private readonly tokens = new Map<string, MintedAccessToken>();

  public issue(
    params: Omit<MintedAccessToken, "bearerToken" | "expiresAtEpochSeconds">,
  ): MintedAccessToken {
    const accessToken: MintedAccessToken = {
      ...params,
      bearerToken: `mcp-server-at-${crypto.randomBytes(24).toString("base64url")}`,
      expiresAtEpochSeconds:
        Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS,
    };

    this.tokens.set(accessToken.bearerToken, accessToken);
    return accessToken;
  }

  public read(token: string | null): MintedAccessToken | null {
    if (!token) {
      return null;
    }

    const accessToken = this.tokens.get(token);
    if (!accessToken) {
      return null;
    }

    if (accessToken.expiresAtEpochSeconds <= Math.floor(Date.now() / 1000)) {
      this.tokens.delete(token);
      return null;
    }

    return accessToken;
  }
}

function registerTools(
  server: McpServer,
  params: {
    accessToken: MintedAccessToken;
    authorizationHeader: string;
  },
): void {
  server.tool(
    "whoami",
    "Report the identity and downstream token used by this MCP server",
    {},
    async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              user: {
                sub: params.accessToken.subject,
                email: params.accessToken.email ?? null,
                name: params.accessToken.name ?? null,
              },
              authorizationHeader: params.authorizationHeader,
              bearerToken: params.accessToken.bearerToken,
              accessToken: {
                tokenKind: params.accessToken.tokenKind,
                obtainedVia: params.accessToken.obtainedVia,
                issuer: params.accessToken.issuer,
                clientId: params.accessToken.clientId,
                resource: params.accessToken.resource,
                scope: params.accessToken.scope,
                assertionType: params.accessToken.assertionType,
                assertionJwtId: params.accessToken.assertionJwtId,
                expiresAtEpochSeconds: params.accessToken.expiresAtEpochSeconds,
              },
            },
            null,
            2,
          ),
        },
      ],
    }),
  );
}

function getServerConfig(config: Partial<ServerConfig>): ServerConfig {
  const port = config.port ?? Number(process.env.PORT || DEFAULT_PORT);
  const baseUrl = config.baseUrl ?? process.env.BASE_URL ?? DEFAULT_BASE_URL;

  return {
    port,
    baseUrl,
    gatewayAudience:
      config.gatewayAudience ??
      process.env.GATEWAY_AUDIENCE ??
      DEFAULT_GATEWAY_AUDIENCE,
    clientId: config.clientId ?? process.env.CLIENT_ID ?? DEFAULT_CLIENT_ID,
    clientSecret:
      config.clientSecret ?? process.env.CLIENT_SECRET ?? DEFAULT_CLIENT_SECRET,
  };
}

function authenticateClient(
  req: Request,
  config: ServerConfig,
): { clientId: string } | null {
  const basicClient = authenticateBasicClient(req, config);
  if (basicClient) {
    return basicClient;
  }

  const body = req.body as { client_id?: unknown; client_secret?: unknown };
  if (
    body.client_id === config.clientId &&
    body.client_secret === config.clientSecret
  ) {
    return { clientId: config.clientId };
  }

  return null;
}

function authenticateBasicClient(
  req: Request,
  config: ServerConfig,
): { clientId: string } | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Basic ")) {
    return null;
  }

  const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString(
    "utf8",
  );
  const separatorIndex = decoded.indexOf(":");
  if (separatorIndex === -1) {
    return null;
  }

  if (
    decoded.slice(0, separatorIndex) !== config.clientId ||
    decoded.slice(separatorIndex + 1) !== config.clientSecret
  ) {
    return null;
  }

  return { clientId: config.clientId };
}

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return null;
  }

  return header.slice("Bearer ".length);
}

function oauthError(error: string, errorDescription: string) {
  return {
    error,
    error_description: errorDescription,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await startServer();
}

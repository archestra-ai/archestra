// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
/**
 * Contract under test — browser-key MCP credentials at the connect path:
 * - install with `browserKeyProtected: true` is gated: EE license + escrow
 *   key + key header + remote-static-personal-non-OAuth-non-BYOS only
 * - the happy path stores the sensitive bag values as envelopes (never
 *   plaintext at rest), sets the fingerprint bound to the final server id,
 *   and escrows the key recoverable with the operator's RSA private key
 * - connection validation and discovery still ran with the plaintext
 */
import {
  constants as cryptoConstants,
  generateKeyPairSync,
  privateDecrypt,
  randomBytes,
} from "node:crypto";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import { hasPermission, userHasPermission } from "@/auth/utils";
import config from "@/config";
import {
  credentialKeyFingerprint,
  decryptCredentialValue,
  isCredentialEnvelope,
  // biome-ignore lint/style/noRestrictedImports: dual-licensed code under test
} from "@/content-encryption/browser-credential.ee";
import db, { schema } from "@/database";
import { secretManager } from "@/secrets-manager";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

const { connectAndGetToolsMock } = vi.hoisted(() => ({
  connectAndGetToolsMock: vi.fn(),
}));

vi.mock("@/clients/mcp-client", () => ({
  McpServerNotReadyError: class extends Error {},
  McpServerConnectionTimeoutError: class extends Error {},
  default: {
    connectAndGetTools: connectAndGetToolsMock,
    invalidateConnectionsForServer: vi.fn(),
    inspectServer: vi.fn(),
  },
}));

vi.mock("@/auth/utils");

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const ESCROW_PEM = publicKey.export({ type: "spki", format: "pem" }) as string;

const KEY_HEADER = "x-archestra-credential-key";

describe("MCP server install — browser-key protection", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let key: Buffer;

  beforeEach(async ({ makeUser, makeOrganization, makeMember }) => {
    config.enterpriseFeatures.core = true;
    config.mcpBrowserCredentials.escrowPublicKey = ESCROW_PEM;
    key = randomBytes(32);

    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(user.id, organizationId);

    vi.mocked(hasPermission).mockResolvedValue({ success: true, error: null });
    vi.mocked(userHasPermission).mockResolvedValue(true);
    connectAndGetToolsMock.mockResolvedValue([
      {
        name: "noop",
        description: "noop",
        inputSchema: { type: "object", properties: {} },
      },
    ]);

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: mcpServerRoutes } = await import("./mcp-server");
    await app.register(mcpServerRoutes);
  });

  afterEach(async () => {
    connectAndGetToolsMock.mockReset();
    await app.close();
  });

  function keyHeader(k: Buffer = key) {
    return { [KEY_HEADER]: k.toString("base64url") };
  }

  async function makeRemoteCatalog(
    makeInternalMcpCatalog: (
      overrides: Record<string, unknown>,
    ) => Promise<{ id: string }>,
    overrides: Record<string, unknown> = {},
  ) {
    return makeInternalMcpCatalog({
      organizationId,
      name: `browser-cred-${randomBytes(4).toString("hex")}`,
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
      userConfig: {
        access_token: {
          type: "string",
          title: "Access Token",
          description: "Per-caller token",
          required: true,
          sensitive: true,
          headerName: "authorization",
          promptOnInstallation: true,
        },
        shared_static: {
          type: "string",
          title: "Shared",
          description: "Catalog-wide static header",
          headerName: "x-shared",
          promptOnInstallation: false,
          default: "static-value",
        },
      },
      ...overrides,
    });
  }

  function installPayload(catalogId: string) {
    return {
      name: "browser-cred-install",
      catalogId,
      userConfigValues: { access_token: "sk-plain-token" },
    };
  }

  describe("gating matrix", () => {
    test("rejects without an enterprise license", async ({
      makeInternalMcpCatalog,
    }) => {
      config.enterpriseFeatures.core = false;
      const catalog = await makeRemoteCatalog(makeInternalMcpCatalog);
      const response = await app.inject({
        method: "POST",
        url: "/api/mcp_server",
        headers: keyHeader(),
        payload: { ...installPayload(catalog.id), browserKeyProtected: true },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.message).toContain("enterprise");
    });

    test("rejects without a configured escrow key", async ({
      makeInternalMcpCatalog,
    }) => {
      config.mcpBrowserCredentials.escrowPublicKey = undefined;
      const catalog = await makeRemoteCatalog(makeInternalMcpCatalog);
      const response = await app.inject({
        method: "POST",
        url: "/api/mcp_server",
        headers: keyHeader(),
        payload: { ...installPayload(catalog.id), browserKeyProtected: true },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.message).toContain(
        "ARCHESTRA_MCP_CREDENTIAL_ESCROW_PUBLIC_KEY",
      );
    });

    test("rejects a missing or malformed key header", async ({
      makeInternalMcpCatalog,
    }) => {
      const catalog = await makeRemoteCatalog(makeInternalMcpCatalog);
      const missing = await app.inject({
        method: "POST",
        url: "/api/mcp_server",
        payload: { ...installPayload(catalog.id), browserKeyProtected: true },
      });
      expect(missing.statusCode).toBe(400);
      expect(missing.json().error.message).toContain(KEY_HEADER);

      const short = await app.inject({
        method: "POST",
        url: "/api/mcp_server",
        headers: { [KEY_HEADER]: randomBytes(8).toString("base64url") },
        payload: { ...installPayload(catalog.id), browserKeyProtected: true },
      });
      expect(short.statusCode).toBe(400);
      expect(short.json().error.message).toContain("32 bytes");
    });

    test("rejects a local (non-remote) server", async ({
      makeInternalMcpCatalog,
    }) => {
      const catalog = await makeInternalMcpCatalog({
        organizationId,
        name: "browser-cred-local",
        serverType: "local",
        localConfig: {
          command: "node",
          arguments: ["server.js"],
          environment: [],
        },
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/mcp_server",
        headers: keyHeader(),
        payload: {
          name: "browser-cred-local",
          catalogId: catalog.id,
          browserKeyProtected: true,
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toContain("remote");
    });

    test("rejects an OAuth-based catalog", async ({
      makeInternalMcpCatalog,
    }) => {
      const catalog = await makeRemoteCatalog(makeInternalMcpCatalog, {
        oauthConfig: {
          name: "example",
          server_url: "https://example.com/mcp",
          auth_server_url: "https://auth.example.com",
          client_id: "client",
          scopes: ["read"],
          default_scopes: ["read"],
          well_known_url: "https://example.com/.well-known",
          supports_resource_metadata: false,
        },
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/mcp_server",
        headers: keyHeader(),
        payload: { ...installPayload(catalog.id), browserKeyProtected: true },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toContain("OAuth");
    });

    test("rejects a non-personal scope", async ({ makeInternalMcpCatalog }) => {
      const catalog = await makeRemoteCatalog(makeInternalMcpCatalog);
      const response = await app.inject({
        method: "POST",
        url: "/api/mcp_server",
        headers: keyHeader(),
        payload: {
          ...installPayload(catalog.id),
          browserKeyProtected: true,
          scope: "org",
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toContain("personal");
    });
  });

  describe("happy path", () => {
    test("stores envelopes + fingerprint bound to the server id + recoverable escrow; plaintext absent at rest", async ({
      makeInternalMcpCatalog,
    }) => {
      const catalog = await makeRemoteCatalog(makeInternalMcpCatalog);
      const response = await app.inject({
        method: "POST",
        url: "/api/mcp_server",
        headers: keyHeader(),
        payload: { ...installPayload(catalog.id), browserKeyProtected: true },
      });
      expect(response.statusCode).toBe(200);
      const serverId = response.json().id as string;

      // Connection validation + discovery both ran with the PLAINTEXT.
      expect(connectAndGetToolsMock).toHaveBeenCalled();
      for (const call of connectAndGetToolsMock.mock.calls) {
        expect(call[0].secrets.access_token).toBe("sk-plain-token");
      }

      const [serverRow] = await db
        .select()
        .from(schema.mcpServersTable)
        .where(eq(schema.mcpServersTable.id, serverId));
      expect(serverRow.browserKeyProtected).toBe(true);
      // The fingerprint binds the key to THIS server id.
      expect(serverRow.browserKeyFingerprint).toBe(
        credentialKeyFingerprint(serverId, key),
      );
      // The escrow blob is independently recoverable — break-glass contract.
      expect(serverRow.browserKeyEscrow?.alg).toBe("RSA-OAEP-256");
      const recovered = privateDecrypt(
        {
          key: privateKey,
          padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
        },
        Buffer.from(serverRow.browserKeyEscrow?.wrappedDek ?? "", "base64"),
      );
      expect(recovered.equals(key)).toBe(true);

      // At rest: the raw secret row never carries the plaintext token.
      if (!serverRow.secretId) throw new Error("expected a secretId");
      const [secretRow] = await db
        .select()
        .from(schema.secretsTable)
        .where(eq(schema.secretsTable.id, serverRow.secretId));
      expect(JSON.stringify(secretRow)).not.toContain("sk-plain-token");

      // Beneath the server-side at-rest layer, the sensitive value is a
      // browser-key envelope only the browser key opens; the catalog-static
      // shared header stays a plain string.
      const stored = await secretManager().getSecret(serverRow.secretId);
      const bag = stored?.secret as Record<string, unknown>;
      expect(isCredentialEnvelope(bag.access_token)).toBe(true);
      expect(bag.shared_static).toBe("static-value");
      expect(JSON.stringify(bag)).not.toContain("sk-plain-token");
      expect(
        decryptCredentialValue(bag.access_token, {
          key,
          mcpServerId: serverId,
        }),
      ).toBe("sk-plain-token");
    });

    test("an unprotected install of the same catalog stays plaintext", async ({
      makeInternalMcpCatalog,
    }) => {
      const catalog = await makeRemoteCatalog(makeInternalMcpCatalog);
      const response = await app.inject({
        method: "POST",
        url: "/api/mcp_server",
        payload: installPayload(catalog.id),
      });
      expect(response.statusCode).toBe(200);

      const [serverRow] = await db
        .select()
        .from(schema.mcpServersTable)
        .where(eq(schema.mcpServersTable.id, response.json().id as string));
      expect(serverRow.browserKeyProtected).toBe(false);
      expect(serverRow.browserKeyFingerprint).toBeNull();
      if (!serverRow.secretId) throw new Error("expected a secretId");
      const stored = await secretManager().getSecret(serverRow.secretId);
      expect(stored?.secret.access_token).toBe("sk-plain-token");
    });
  });
});

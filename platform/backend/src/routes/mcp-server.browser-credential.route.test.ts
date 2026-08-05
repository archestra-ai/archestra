// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
/**
 * Contract under test — browser-key MCP credentials at the connect path:
 * - install with `browserKeyProtected: true` is gated: EE license + escrow
 *   key + key header + remote-static-personal-non-OAuth-non-BYOS only
 * - the happy path stores the sensitive bag values as envelopes — the
 *   plaintext is NEVER handed to secret persistence, not even transiently
 *   pre-seal — sets the fingerprint bound to the final server id, and
 *   escrows the key recoverable with the operator's RSA private key
 * - connection validation and discovery still ran with the plaintext
 *   (in-memory bag); a failed validation persists nothing at all
 * - reauthenticate with the flag validates EVERY protected replacement
 *   credential (PAT included), seals before any write, and deletes the old
 *   secret only after the row points at the new one
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
import { McpServerModel } from "@/models";
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
    test("stores envelopes + fingerprint bound to the server id + recoverable escrow; plaintext never persisted", async ({
      makeInternalMcpCatalog,
    }) => {
      const catalog = await makeRemoteCatalog(makeInternalMcpCatalog);
      const createSecretSpy = vi.spyOn(secretManager(), "createSecret");
      const updateSecretSpy = vi.spyOn(secretManager(), "updateSecret");

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

      // The plaintext was NEVER handed to secret persistence: exactly one
      // secret write happened and it was the already-sealed bag — no
      // plaintext-then-update window that could reach the DB or its WAL.
      expect(createSecretSpy).toHaveBeenCalledTimes(1);
      for (const call of createSecretSpy.mock.calls) {
        expect(JSON.stringify(call[0])).not.toContain("sk-plain-token");
      }
      expect(updateSecretSpy).not.toHaveBeenCalled();
      createSecretSpy.mockRestore();
      updateSecretSpy.mockRestore();

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

    test("a failed connection validation persists nothing — no secret write, no server row", async ({
      makeInternalMcpCatalog,
    }) => {
      const catalog = await makeRemoteCatalog(makeInternalMcpCatalog);
      connectAndGetToolsMock.mockRejectedValue(
        new Error("upstream rejected the credential"),
      );
      const createSecretSpy = vi.spyOn(secretManager(), "createSecret");
      const updateSecretSpy = vi.spyOn(secretManager(), "updateSecret");

      const response = await app.inject({
        method: "POST",
        url: "/api/mcp_server",
        headers: keyHeader(),
        payload: { ...installPayload(catalog.id), browserKeyProtected: true },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toContain(
        "upstream rejected the credential",
      );

      // Validation ran on the IN-MEMORY bag: nothing was written that could
      // need rollback — no secret (sealed or otherwise), no server row.
      expect(createSecretSpy).not.toHaveBeenCalled();
      expect(updateSecretSpy).not.toHaveBeenCalled();
      const serverRows = await db
        .select()
        .from(schema.mcpServersTable)
        .where(eq(schema.mcpServersTable.catalogId, catalog.id));
      expect(serverRows).toHaveLength(0);
      const secretRows = await db.select().from(schema.secretsTable);
      expect(JSON.stringify(secretRows)).not.toContain("sk-plain-token");
      createSecretSpy.mockRestore();
      updateSecretSpy.mockRestore();
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

  describe("reauthenticate — browser-key protection", () => {
    type MakeMcpServer = (
      overrides: Record<string, unknown>,
    ) => Promise<{ id: string; secretId: string | null }>;

    async function makeInstalledServer(
      makeInternalMcpCatalog: Parameters<typeof makeRemoteCatalog>[0],
      makeMcpServer: MakeMcpServer,
    ) {
      const catalog = await makeRemoteCatalog(makeInternalMcpCatalog);
      const oldSecret = await secretManager().createSecret(
        { access_token: "sk-old-plain-token" },
        "bk-reauth-old-secret",
      );
      const server = await makeMcpServer({
        catalogId: catalog.id,
        name: "browser-cred-reauth",
        serverType: "remote",
        scope: "personal",
        ownerId: user.id,
        secretId: oldSecret.id,
      });
      return { catalog, server, oldSecretId: oldSecret.id };
    }

    test("PAT reauth validates the replacement, seals before any write, swaps the row, then deletes the old secret", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
    }) => {
      const { server, oldSecretId } = await makeInstalledServer(
        makeInternalMcpCatalog,
        makeMcpServer as MakeMcpServer,
      );
      const createSecretSpy = vi.spyOn(secretManager(), "createSecret");
      const updateSecretSpy = vi.spyOn(secretManager(), "updateSecret");

      const response = await app.inject({
        method: "PATCH",
        url: `/api/mcp_server/${server.id}/reauthenticate`,
        headers: keyHeader(),
        payload: {
          accessToken: "sk-new-plain-token",
          browserKeyProtected: true,
        },
      });
      expect(response.statusCode).toBe(200);

      // The PAT branch is connection-validated too (it used to skip this),
      // and validation ran with the in-memory plaintext.
      expect(connectAndGetToolsMock).toHaveBeenCalled();
      for (const call of connectAndGetToolsMock.mock.calls) {
        expect(call[0].secrets.access_token).toBe("sk-new-plain-token");
      }

      // The replacement plaintext was never handed to persistence: one
      // already-sealed write, no post-hoc update.
      expect(createSecretSpy).toHaveBeenCalledTimes(1);
      for (const call of createSecretSpy.mock.calls) {
        expect(JSON.stringify(call[0])).not.toContain("sk-new-plain-token");
      }
      expect(updateSecretSpy).not.toHaveBeenCalled();
      createSecretSpy.mockRestore();
      updateSecretSpy.mockRestore();

      const [serverRow] = await db
        .select()
        .from(schema.mcpServersTable)
        .where(eq(schema.mcpServersTable.id, server.id));
      expect(serverRow.browserKeyProtected).toBe(true);
      expect(serverRow.browserKeyFingerprint).toBe(
        credentialKeyFingerprint(server.id, key),
      );
      expect(serverRow.browserKeyEscrow?.alg).toBe("RSA-OAEP-256");
      expect(serverRow.secretId).not.toBe(oldSecretId);
      if (!serverRow.secretId) throw new Error("expected a secretId");

      // At rest: envelope only the browser key opens; no plaintext anywhere.
      const stored = await secretManager().getSecret(serverRow.secretId);
      const bag = stored?.secret as Record<string, unknown>;
      expect(isCredentialEnvelope(bag.access_token)).toBe(true);
      expect(
        decryptCredentialValue(bag.access_token, {
          key,
          mcpServerId: server.id,
        }),
      ).toBe("sk-new-plain-token");

      // The old secret is cleaned up — but only after the swap (see the
      // stranding test below for the failure ordering).
      expect(await secretManager().getSecret(oldSecretId)).toBeNull();
    });

    test("a failed replacement validation persists nothing and keeps the old credential working", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
    }) => {
      const { server, oldSecretId } = await makeInstalledServer(
        makeInternalMcpCatalog,
        makeMcpServer as MakeMcpServer,
      );
      connectAndGetToolsMock.mockRejectedValue(
        new Error("upstream rejected the credential"),
      );
      const createSecretSpy = vi.spyOn(secretManager(), "createSecret");

      const response = await app.inject({
        method: "PATCH",
        url: `/api/mcp_server/${server.id}/reauthenticate`,
        headers: keyHeader(),
        payload: {
          accessToken: "sk-new-plain-token",
          browserKeyProtected: true,
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toContain(
        "upstream rejected the credential",
      );

      // Nothing was written and the install still points at its old,
      // working secret.
      expect(createSecretSpy).not.toHaveBeenCalled();
      createSecretSpy.mockRestore();
      const [serverRow] = await db
        .select()
        .from(schema.mcpServersTable)
        .where(eq(schema.mcpServersTable.id, server.id));
      expect(serverRow.secretId).toBe(oldSecretId);
      expect(serverRow.browserKeyProtected).toBe(false);
      const oldSecret = await secretManager().getSecret(oldSecretId);
      expect(oldSecret?.secret.access_token).toBe("sk-old-plain-token");
    });

    test("the old secret survives a failed row update — deletion runs last", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
    }) => {
      const { server, oldSecretId } = await makeInstalledServer(
        makeInternalMcpCatalog,
        makeMcpServer as MakeMcpServer,
      );
      const updateSpy = vi
        .spyOn(McpServerModel, "update")
        .mockRejectedValueOnce(new Error("row update failed"));

      const response = await app.inject({
        method: "PATCH",
        url: `/api/mcp_server/${server.id}/reauthenticate`,
        headers: keyHeader(),
        payload: {
          accessToken: "sk-new-plain-token",
          browserKeyProtected: true,
        },
      });
      updateSpy.mockRestore();
      expect(response.statusCode).toBe(500);

      // The row still references the old secret AND that secret still
      // exists — the server is never stranded on a deleted credential.
      const [serverRow] = await db
        .select()
        .from(schema.mcpServersTable)
        .where(eq(schema.mcpServersTable.id, server.id));
      expect(serverRow.secretId).toBe(oldSecretId);
      const oldSecret = await secretManager().getSecret(oldSecretId);
      expect(oldSecret?.secret.access_token).toBe("sk-old-plain-token");
    });
  });
});

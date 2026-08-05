// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
/**
 * Contract under test — browser-key MCP credentials on the use path:
 * - install resolution is TERMINAL on the caller's own protected personal
 *   install: pickInstallForCaller still selects it over a team install (no
 *   fall-through to another credential), and the central secrets gate turns
 *   a keyless/wrong-key call into the typed browser-locked refusal
 * - a valid key unwraps the bag transiently and the shared secrets cache is
 *   never populated with it
 * - the periodic tools refresher never picks a protected install
 */
import { randomBytes } from "node:crypto";
import { vi } from "vitest";
import type { LRUCacheManager } from "@/cache-manager";
import {
  credentialKeyFingerprint,
  encryptCredentialValue,
  // biome-ignore lint/style/noRestrictedImports: dual-licensed code under test
} from "@/content-encryption/browser-credential.ee";
import McpServerModel from "@/models/mcp-server";
import { secretManager } from "@/secrets-manager";
import { beforeEach, describe, expect, test } from "@/test";
import { agentOwner, type McpServer } from "@/types";
import mcpClient, { type TokenAuthContext } from "./mcp-client";

/** Reach the private members under test without widening the public API. */
const client = mcpClient as unknown as {
  pickInstallForCaller(
    allServers: McpServer[],
    tokenAuth: TokenAuthContext | undefined,
  ): Promise<McpServer | undefined>;
  getOrCreateClient(
    connectionKey: string,
    transport: unknown,
    targetMcpServerId: string,
    currentServerState: {
      secretId: string | null;
      credentialFingerprint: string | null;
    },
  ): Promise<unknown>;
  activeConnections: Map<string, unknown>;
  getSecretsForMcpServer(params: {
    targetMcpServerId: string;
    toolCall: { id: string; name: string; arguments: Record<string, unknown> };
    owner: ReturnType<typeof agentOwner>;
    credentialKey?: Buffer | null;
    catalog?: { id: string; name: string };
  }): Promise<
    | {
        secrets: Record<string, unknown>;
        browserKeyProtected: boolean;
      }
    | {
        error: {
          isError?: boolean;
          error?: string;
          structuredContent?: { archestraError?: unknown };
        };
      }
  >;
  secretsCache: LRUCacheManager<unknown>;
};

describe("browser-key MCP credentials — use path", () => {
  let key: Buffer;

  beforeEach(() => {
    key = randomBytes(32);
  });

  /** Flip an existing personal install into its browser-key-protected state. */
  async function protectInstall(server: { id: string }) {
    const secret = await secretManager().createSecret(
      {
        access_token: encryptCredentialValue("sk-unwrapped-token", {
          key,
          mcpServerId: server.id,
        }),
      },
      "bk-secret",
      true,
    );
    await McpServerModel.update(server.id, {
      secretId: secret.id,
      browserKeyProtected: true,
      browserKeyFingerprint: credentialKeyFingerprint(server.id, key),
    });
  }

  test("pickInstallForCaller stays terminal on the owner's protected personal install (team install NOT selected)", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const owner = await makeUser();
    const organization = await makeOrganization();
    const team = await makeTeam(organization.id, owner.id);
    const catalog = await makeInternalMcpCatalog({
      organizationId: organization.id,
      name: "bk-terminal-catalog",
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
    });
    const personal = await makeMcpServer({
      catalogId: catalog.id,
      name: "protected-personal",
      serverType: "remote",
      scope: "personal",
      ownerId: owner.id,
    });
    await protectInstall(personal);
    // A sibling TEAM install with its own credentials — the fall-through
    // temptation.
    await makeMcpServer({
      catalogId: catalog.id,
      name: "team-install",
      serverType: "remote",
      scope: "team",
      teamId: team.id,
    });

    const installs = await McpServerModel.findByCatalogId(catalog.id);
    expect(installs).toHaveLength(2);

    const picked = await client.pickInstallForCaller(installs, {
      tokenId: "t",
      teamId: null,
      isOrganizationToken: false,
      isUserToken: true,
      userId: owner.id,
    });
    // DISABLE-DON'T-LEAK: the protected personal install is selected (the
    // central gate then refuses keyless calls) — the team credential is
    // never silently substituted.
    expect(picked?.id).toBe(personal.id);
  });

  describe("central secrets gate", () => {
    test("keyless call → typed browser-locked refusal, wrong key → mismatch, valid key → transient plaintext; cache stays cold", async ({
      makeUser,
      makeOrganization,
      makeAgent,
      makeInternalMcpCatalog,
      makeMcpServer,
    }) => {
      const owner = await makeUser();
      const organization = await makeOrganization();
      const agent = await makeAgent({
        organizationId: organization.id,
        authorId: owner.id,
      });
      const catalog = await makeInternalMcpCatalog({
        organizationId: organization.id,
        name: "bk-gate-catalog",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
      });
      const server = await makeMcpServer({
        catalogId: catalog.id,
        name: "protected-personal",
        serverType: "remote",
        scope: "personal",
        ownerId: owner.id,
      });
      await protectInstall(server);

      const gateParams = (credentialKey: Buffer | null) => ({
        targetMcpServerId: server.id,
        toolCall: { id: "call-1", name: "some_tool", arguments: {} },
        owner: agentOwner(agent.id),
        credentialKey,
        catalog: { id: catalog.id, name: catalog.name },
      });

      // Keyless (background/token contexts): terminal typed refusal.
      const locked = await client.getSecretsForMcpServer(gateParams(null));
      if (!("error" in locked)) throw new Error("expected a refusal");
      expect(locked.error.isError).toBe(true);
      expect(locked.error.error).toContain("browser-held key");
      expect(locked.error.structuredContent?.archestraError).toMatchObject({
        type: "assigned_credential_unavailable",
        catalogId: catalog.id,
      });
      expect(client.secretsCache.get(server.id)).toBeUndefined();

      // Present-but-wrong key: distinct mismatch refusal.
      const mismatch = await client.getSecretsForMcpServer(
        gateParams(randomBytes(32)),
      );
      if (!("error" in mismatch)) throw new Error("expected a refusal");
      expect(mismatch.error.error).toContain("does not match");

      // Valid key: the bag unwraps transiently and is NEVER cached.
      const unlocked = await client.getSecretsForMcpServer(gateParams(key));
      if ("error" in unlocked) {
        throw new Error(`unexpected refusal: ${unlocked.error.error}`);
      }
      expect(unlocked.browserKeyProtected).toBe(true);
      expect(unlocked.secrets.access_token).toBe("sk-unwrapped-token");
      expect(client.secretsCache.get(server.id)).toBeUndefined();
    });
  });

  test("a client whose connect fails before registration is closed directly — nothing leaks for the ephemeral teardown to miss", async () => {
    // A per-call (nonce-keyed) browser-key connection relies on
    // teardownEphemeralConnection, which only closes clients registered in
    // activeConnections. A connect() failure happens BEFORE registration, so
    // the failure path itself must close the client (and thereby the
    // transport).
    const transportClose = vi.fn().mockResolvedValue(undefined);
    const transport = {
      start: vi.fn().mockRejectedValue(new Error("connect refused")),
      send: vi.fn(),
      close: transportClose,
    };
    const connectionKey = `catalog:server:browser-key:${randomBytes(4).toString("hex")}`;

    await expect(
      client.getOrCreateClient(connectionKey, transport, "server", {
        secretId: null,
        credentialFingerprint: null,
      }),
    ).rejects.toThrow("connect refused");

    // Closed in the failure path itself, and never registered.
    expect(transportClose).toHaveBeenCalled();
    expect(client.activeConnections.has(connectionKey)).toBe(false);
  });

  test("the periodic tools refresher never picks a browser-key-protected install", async ({
    makeUser,
    makeOrganization,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const owner = await makeUser();
    const organization = await makeOrganization();
    const protectedCatalog = await makeInternalMcpCatalog({
      organizationId: organization.id,
      name: "bk-protected-catalog",
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
    });
    const protectedServer = await makeMcpServer({
      catalogId: protectedCatalog.id,
      name: "protected-personal",
      serverType: "remote",
      scope: "personal",
      ownerId: owner.id,
    });
    await protectInstall(protectedServer);

    // A plain sibling catalog proves the refresher still runs for others.
    const plainCatalog = await makeInternalMcpCatalog({
      organizationId: organization.id,
      name: "bk-plain-catalog",
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
    });
    const plainServer = await makeMcpServer({
      catalogId: plainCatalog.id,
      name: "plain-install",
      serverType: "remote",
      scope: "personal",
      ownerId: owner.id,
    });

    const refreshTargets =
      await McpServerModel.findOnePerCatalogForToolsRefresh();
    const targetCatalogIds = refreshTargets.map((s) => s.catalogId);
    expect(targetCatalogIds).toContain(plainCatalog.id);
    expect(targetCatalogIds).not.toContain(protectedCatalog.id);
    expect(refreshTargets.map((s) => s.id)).toContain(plainServer.id);
  });
});

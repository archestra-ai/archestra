import { describe, expect, test } from "@/test";
import OAuthClientModel from "./oauth-client";

describe("OAuthClientModel", () => {
  describe("findByClientId", () => {
    test("should return the full client when it exists", async ({
      makeOAuthClient,
    }) => {
      const client = await makeOAuthClient({
        clientId: "findable-client",
        name: "Findable Client",
      });

      const found = await OAuthClientModel.findByClientId(client.clientId);

      expect(found).toBeDefined();
      expect(found?.id).toBe(client.id);
      expect(found?.clientId).toBe("findable-client");
      expect(found?.name).toBe("Findable Client");
      expect(found?.tokenEndpointAuthMethod).toBe("none");
    });

    test("should return null when the client does not exist", async () => {
      const found = await OAuthClientModel.findByClientId("missing-client");

      expect(found).toBeNull();
    });
  });

  describe("getNameByClientId", () => {
    test("should return client name when client exists", async ({
      makeOAuthClient,
    }) => {
      const client = await makeOAuthClient({
        clientId: "test-client-id",
        name: "My OAuth App",
      });

      const name = await OAuthClientModel.getNameByClientId(client.clientId);

      expect(name).toBe("My OAuth App");
    });

    test("should return null when client does not exist", async () => {
      const name = await OAuthClientModel.getNameByClientId("nonexistent-id");

      expect(name).toBeNull();
    });
  });

  describe("existsByClientId", () => {
    test("should return true when client exists", async ({
      makeOAuthClient,
    }) => {
      const client = await makeOAuthClient({ clientId: "existing-client" });
      const exists = await OAuthClientModel.existsByClientId(client.clientId);
      expect(exists).toBe(true);
    });

    test("should return false when client does not exist", async () => {
      const exists =
        await OAuthClientModel.existsByClientId("nonexistent-client");
      expect(exists).toBe(false);
    });
  });

  describe("upsertFromCimd", () => {
    test("should insert a new client", async () => {
      const clientId = `https://example.com/${crypto.randomUUID()}/client.json`;

      await OAuthClientModel.upsertFromCimd({
        id: crypto.randomUUID(),
        clientId,
        name: "CIMD Test Client",
        redirectUris: ["http://localhost:8005/callback"],
        grantTypes: ["authorization_code"],
        responseTypes: ["code"],
        tokenEndpointAuthMethod: "none",
        isPublic: true,
        metadata: { cimd: true },
      });

      const exists = await OAuthClientModel.existsByClientId(clientId);
      expect(exists).toBe(true);

      const name = await OAuthClientModel.getNameByClientId(clientId);
      expect(name).toBe("CIMD Test Client");
    });

    test("should update existing client on re-upsert", async () => {
      const clientId = `https://example.com/${crypto.randomUUID()}/client.json`;

      await OAuthClientModel.upsertFromCimd({
        id: crypto.randomUUID(),
        clientId,
        name: "Original Name",
        redirectUris: ["http://localhost:8005/callback"],
        grantTypes: ["authorization_code"],
        responseTypes: ["code"],
        tokenEndpointAuthMethod: "none",
        isPublic: true,
        metadata: { cimd: true },
      });

      await OAuthClientModel.upsertFromCimd({
        id: crypto.randomUUID(),
        clientId,
        name: "Updated Name",
        redirectUris: ["http://localhost:9000/callback"],
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"],
        tokenEndpointAuthMethod: "none",
        isPublic: true,
        metadata: { cimd: true, updated: true },
      });

      const name = await OAuthClientModel.getNameByClientId(clientId);
      expect(name).toBe("Updated Name");

      const found = await OAuthClientModel.findByClientId(clientId);
      expect(found?.redirectUris).toEqual(["http://localhost:9000/callback"]);
      expect(found?.grantTypes).toEqual([
        "authorization_code",
        "refresh_token",
      ]);
      expect(found?.metadata).toEqual({ cimd: true, updated: true });
    });

    test("should store optional fields", async () => {
      const clientId = `https://example.com/${crypto.randomUUID()}/client.json`;

      await OAuthClientModel.upsertFromCimd({
        id: crypto.randomUUID(),
        clientId,
        name: "Full Client",
        redirectUris: ["http://localhost:8005/callback"],
        grantTypes: ["authorization_code"],
        responseTypes: ["code"],
        tokenEndpointAuthMethod: "none",
        isPublic: true,
        metadata: { cimd: true },
        contacts: ["admin@example.com"],
        uri: "https://example.com",
        policy: "https://example.com/policy",
        tos: "https://example.com/tos",
        softwareId: "test-software",
        softwareVersion: "1.0.0",
      });

      const exists = await OAuthClientModel.existsByClientId(clientId);
      expect(exists).toBe(true);
    });

    test("should not create duplicates on upsert", async () => {
      const clientId = `https://example.com/${crypto.randomUUID()}/client.json`;

      await OAuthClientModel.upsertFromCimd({
        id: crypto.randomUUID(),
        clientId,
        name: "First",
        redirectUris: ["http://localhost/callback"],
        grantTypes: ["authorization_code"],
        responseTypes: ["code"],
        tokenEndpointAuthMethod: "none",
        isPublic: true,
        metadata: { cimd: true },
      });

      await OAuthClientModel.upsertFromCimd({
        id: crypto.randomUUID(),
        clientId,
        name: "Second",
        redirectUris: ["http://localhost/callback"],
        grantTypes: ["authorization_code"],
        responseTypes: ["code"],
        tokenEndpointAuthMethod: "none",
        isPublic: true,
        metadata: { cimd: true },
      });

      // Should still exist with updated name, not duplicated
      const exists = await OAuthClientModel.existsByClientId(clientId);
      expect(exists).toBe(true);
      const name = await OAuthClientModel.getNameByClientId(clientId);
      expect(name).toBe("Second");
    });
  });
});

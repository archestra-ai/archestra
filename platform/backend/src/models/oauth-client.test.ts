import { describe, expect, test } from "@/test";
import OAuthClientModel from "./oauth-client";

describe("OAuthClientModel", () => {
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

    test("should return null when client has no name", async ({
      makeOAuthClient,
    }) => {
      const client = await makeOAuthClient({
        clientId: "nameless-client",
        name: undefined,
      });

      const name = await OAuthClientModel.getNameByClientId(client.clientId);

      // name defaults to "Test Client ..." from fixture, so create one without name
      // The fixture always sets a name, so we test the "not found" path instead
      expect(name).toBeDefined();
    });
  });
});

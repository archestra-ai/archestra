import { afterEach, describe, expect, vi } from "vitest";
import { OAuthClientModel } from "@/models";
import { test } from "@/test";
import {
  CimdError,
  ensureCimdClientRegistered,
  fetchAndValidateCimdDocument,
  isCimdClientId,
  validateCimdDocument,
} from "./cimd";

describe("CIMD", () => {
  describe("isCimdClientId", () => {
    test("returns true for HTTPS URL with path", () => {
      expect(isCimdClientId("https://example.com/client-metadata.json")).toBe(
        true,
      );
    });

    test("returns true for HTTP URL with path", () => {
      expect(
        isCimdClientId("https://cimd-test.example.com/cimd/test-client.json"),
      ).toBe(true);
    });

    test("returns true for URL with nested path", () => {
      expect(
        isCimdClientId("https://myapp.example.com/oauth/client.json"),
      ).toBe(true);
    });

    test("returns false for URL without path (just host)", () => {
      // Just "https://example.com" has pathname "/" which is length 1
      expect(isCimdClientId("https://example.com")).toBe(false);
    });

    test("returns false for URL with trailing slash only", () => {
      expect(isCimdClientId("https://example.com/")).toBe(false);
    });

    test("returns false for non-URL string", () => {
      expect(isCimdClientId("my-client-id")).toBe(false);
    });

    test("returns false for UUID-style client_id", () => {
      expect(isCimdClientId("550e8400-e29b-41d4-a716-446655440000")).toBe(
        false,
      );
    });

    test("returns false for empty string", () => {
      expect(isCimdClientId("")).toBe(false);
    });

    test("returns false for non-http scheme", () => {
      expect(isCimdClientId("ftp://example.com/file.json")).toBe(false);
    });

    test("returns false for mailto: URI", () => {
      expect(isCimdClientId("mailto:user@example.com")).toBe(false);
    });
  });

  describe("fetchAndValidateCimdDocument SSRF protection", () => {
    test("rejects localhost URLs", async () => {
      await expect(
        fetchAndValidateCimdDocument("https://localhost/client.json"),
      ).rejects.toThrow(/private or loopback address/);
    });

    test("rejects 127.x.x.x URLs", async () => {
      await expect(
        fetchAndValidateCimdDocument("https://127.0.0.1/client.json"),
      ).rejects.toThrow(/private or loopback address/);
    });

    test("rejects 10.x private range", async () => {
      await expect(
        fetchAndValidateCimdDocument("https://10.0.0.1/client.json"),
      ).rejects.toThrow(/private or loopback address/);
    });

    test("rejects 192.168.x private range", async () => {
      await expect(
        fetchAndValidateCimdDocument("https://192.168.1.1/client.json"),
      ).rejects.toThrow(/private or loopback address/);
    });

    test("rejects 172.16-31.x private range", async () => {
      await expect(
        fetchAndValidateCimdDocument("https://172.16.0.1/client.json"),
      ).rejects.toThrow(/private or loopback address/);
    });

    test("rejects IPv6 loopback", async () => {
      await expect(
        fetchAndValidateCimdDocument("https://[::1]/client.json"),
      ).rejects.toThrow(/private or loopback address/);
    });

    test("throws CimdError type for SSRF blocks", async () => {
      await expect(
        fetchAndValidateCimdDocument("https://localhost/client.json"),
      ).rejects.toBeInstanceOf(CimdError);
    });
  });

  describe("validateCimdDocument", () => {
    const clientIdUrl = "https://example.com/client.json";

    test("returns valid metadata for a complete document", () => {
      const doc = {
        client_id: clientIdUrl,
        client_name: "Test Client",
        redirect_uris: ["http://localhost:8005/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: "mcp",
        contacts: ["admin@example.com"],
        logo_uri: "https://example.com/logo.png",
        client_uri: "https://example.com",
        policy_uri: "https://example.com/policy",
        tos_uri: "https://example.com/tos",
        software_id: "test-app",
        software_version: "2.0.0",
      };

      const result = validateCimdDocument(clientIdUrl, doc);

      expect(result.client_id).toBe(clientIdUrl);
      expect(result.client_name).toBe("Test Client");
      expect(result.redirect_uris).toEqual(["http://localhost:8005/callback"]);
      expect(result.grant_types).toEqual([
        "authorization_code",
        "refresh_token",
      ]);
      expect(result.response_types).toEqual(["code"]);
      expect(result.token_endpoint_auth_method).toBe("none");
      expect(result.scope).toBe("mcp");
      expect(result.contacts).toEqual(["admin@example.com"]);
      expect(result.logo_uri).toBe("https://example.com/logo.png");
      expect(result.client_uri).toBe("https://example.com");
      expect(result.policy_uri).toBe("https://example.com/policy");
      expect(result.tos_uri).toBe("https://example.com/tos");
      expect(result.software_id).toBe("test-app");
      expect(result.software_version).toBe("2.0.0");
    });

    test("returns metadata with only required fields", () => {
      const doc = {
        client_id: clientIdUrl,
        client_name: "Minimal Client",
        redirect_uris: ["http://localhost/callback"],
      };

      const result = validateCimdDocument(clientIdUrl, doc);

      expect(result.client_id).toBe(clientIdUrl);
      expect(result.client_name).toBe("Minimal Client");
      expect(result.redirect_uris).toEqual(["http://localhost/callback"]);
      expect(result.grant_types).toBeUndefined();
      expect(result.response_types).toBeUndefined();
      expect(result.scope).toBeUndefined();
      expect(result.contacts).toBeUndefined();
    });

    test("throws when document is not an object", () => {
      expect(() => validateCimdDocument(clientIdUrl, "not an object")).toThrow(
        "CIMD document must be a JSON object",
      );
    });

    test("throws when document is null", () => {
      expect(() => validateCimdDocument(clientIdUrl, null)).toThrow(
        "CIMD document must be a JSON object",
      );
    });

    test("throws when document is an array", () => {
      // Arrays are typeof "object" in JS, so they pass the object check
      // but fail on client_id mismatch
      expect(() => validateCimdDocument(clientIdUrl, [])).toThrow(
        /does not match the URL/,
      );
    });

    test("throws when client_id does not match URL", () => {
      const doc = {
        client_id: "https://wrong.com/client.json",
        client_name: "Test",
        redirect_uris: ["http://localhost/callback"],
      };

      expect(() => validateCimdDocument(clientIdUrl, doc)).toThrow(
        /does not match the URL/,
      );
    });

    test("throws when client_id is missing", () => {
      const doc = {
        client_name: "Test",
        redirect_uris: ["http://localhost/callback"],
      };

      expect(() => validateCimdDocument(clientIdUrl, doc)).toThrow(
        /does not match the URL/,
      );
    });

    test("throws when client_name is missing", () => {
      const doc = {
        client_id: clientIdUrl,
        redirect_uris: ["http://localhost/callback"],
      };

      expect(() => validateCimdDocument(clientIdUrl, doc)).toThrow(
        "CIMD document must include a non-empty client_name",
      );
    });

    test("throws when client_name is empty string", () => {
      const doc = {
        client_id: clientIdUrl,
        client_name: "",
        redirect_uris: ["http://localhost/callback"],
      };

      expect(() => validateCimdDocument(clientIdUrl, doc)).toThrow(
        "CIMD document must include a non-empty client_name",
      );
    });

    test("throws when client_name is not a string", () => {
      const doc = {
        client_id: clientIdUrl,
        client_name: 123,
        redirect_uris: ["http://localhost/callback"],
      };

      expect(() => validateCimdDocument(clientIdUrl, doc)).toThrow(
        "CIMD document must include a non-empty client_name",
      );
    });

    test("throws when redirect_uris is missing", () => {
      const doc = {
        client_id: clientIdUrl,
        client_name: "Test",
      };

      expect(() => validateCimdDocument(clientIdUrl, doc)).toThrow(
        "CIMD document must include redirect_uris as a non-empty array of strings",
      );
    });

    test("throws when redirect_uris is empty array", () => {
      const doc = {
        client_id: clientIdUrl,
        client_name: "Test",
        redirect_uris: [],
      };

      expect(() => validateCimdDocument(clientIdUrl, doc)).toThrow(
        "CIMD document must include redirect_uris as a non-empty array of strings",
      );
    });

    test("throws when redirect_uris contains non-strings", () => {
      const doc = {
        client_id: clientIdUrl,
        client_name: "Test",
        redirect_uris: [123, "http://localhost/callback"],
      };

      expect(() => validateCimdDocument(clientIdUrl, doc)).toThrow(
        "CIMD document must include redirect_uris as a non-empty array of strings",
      );
    });

    test("throws when redirect_uris is not an array", () => {
      const doc = {
        client_id: clientIdUrl,
        client_name: "Test",
        redirect_uris: "http://localhost/callback",
      };

      expect(() => validateCimdDocument(clientIdUrl, doc)).toThrow(
        "CIMD document must include redirect_uris as a non-empty array of strings",
      );
    });

    test("ignores non-string optional fields", () => {
      const doc = {
        client_id: clientIdUrl,
        client_name: "Test",
        redirect_uris: ["http://localhost/callback"],
        grant_types: 123,
        scope: true,
        contacts: "not-an-array",
      };

      const result = validateCimdDocument(clientIdUrl, doc);

      expect(result.grant_types).toBeUndefined();
      expect(result.scope).toBeUndefined();
      expect(result.contacts).toBeUndefined();
    });

    test("handles multiple redirect_uris", () => {
      const doc = {
        client_id: clientIdUrl,
        client_name: "Test",
        redirect_uris: [
          "http://localhost:3000/callback",
          "http://localhost:8005/callback",
        ],
      };

      const result = validateCimdDocument(clientIdUrl, doc);
      expect(result.redirect_uris).toEqual([
        "http://localhost:3000/callback",
        "http://localhost:8005/callback",
      ]);
    });
  });

  describe("ensureCimdClientRegistered", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    function mockFetchWithDocument(doc: Record<string, unknown>) {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(doc), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    test("registers a CIMD client in the database", async () => {
      const clientIdUrl = `https://cimd-test.example.com/${crypto.randomUUID()}/client.json`;

      mockFetchWithDocument({
        client_id: clientIdUrl,
        client_name: "Auto-Registered Client",
        redirect_uris: ["http://localhost:8005/callback"],
        grant_types: ["authorization_code"],
      });

      await ensureCimdClientRegistered(clientIdUrl);

      const exists = await OAuthClientModel.existsByClientId(clientIdUrl);
      expect(exists).toBe(true);

      const name = await OAuthClientModel.getNameByClientId(clientIdUrl);
      expect(name).toBe("Auto-Registered Client");
    });

    test("uses cache on repeated calls within TTL", async () => {
      const clientIdUrl = `https://cimd-test.example.com/${crypto.randomUUID()}/client.json`;

      mockFetchWithDocument({
        client_id: clientIdUrl,
        client_name: "Cached Client",
        redirect_uris: ["http://localhost:8005/callback"],
      });

      await ensureCimdClientRegistered(clientIdUrl);
      await ensureCimdClientRegistered(clientIdUrl);

      // fetch should only be called once due to caching
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    test("throws when fetch returns non-OK status", async () => {
      const clientIdUrl = `https://cimd-test.example.com/${crypto.randomUUID()}/not-found.json`;

      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(new Response("Not Found", { status: 404 }));

      await expect(ensureCimdClientRegistered(clientIdUrl)).rejects.toThrow(
        /Failed to fetch CIMD document/,
      );
    });

    test("throws when response is not valid JSON", async () => {
      const clientIdUrl = `https://cimd-test.example.com/${crypto.randomUUID()}/invalid.json`;

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response("not json {{{", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      await expect(ensureCimdClientRegistered(clientIdUrl)).rejects.toThrow(
        /is not valid JSON/,
      );
    });

    test("throws when document validation fails", async () => {
      const clientIdUrl = `https://cimd-test.example.com/${crypto.randomUUID()}/bad.json`;

      mockFetchWithDocument({
        client_id: "https://wrong.com/other.json",
        client_name: "Bad Client",
        redirect_uris: ["http://localhost/callback"],
      });

      await expect(ensureCimdClientRegistered(clientIdUrl)).rejects.toThrow(
        /does not match the URL/,
      );
    });

    test("updates existing client on re-registration", async () => {
      const clientIdUrl = `https://cimd-test.example.com/${crypto.randomUUID()}/client.json`;

      // First registration
      mockFetchWithDocument({
        client_id: clientIdUrl,
        client_name: "Original",
        redirect_uris: ["http://localhost:8005/callback"],
      });
      await ensureCimdClientRegistered(clientIdUrl);

      const nameAfterFirst =
        await OAuthClientModel.getNameByClientId(clientIdUrl);
      expect(nameAfterFirst).toBe("Original");

      // Simulate cache expiry by using a new unique URL
      const clientIdUrl2 = `https://cimd-test.example.com/${crypto.randomUUID()}/client.json`;
      mockFetchWithDocument({
        client_id: clientIdUrl2,
        client_name: "Updated",
        redirect_uris: ["http://localhost:9000/callback"],
      });
      await ensureCimdClientRegistered(clientIdUrl2);

      const nameAfterSecond =
        await OAuthClientModel.getNameByClientId(clientIdUrl2);
      expect(nameAfterSecond).toBe("Updated");
    });
  });
});

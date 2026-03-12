import { vi } from "vitest";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { ConnectorSyncBatch } from "@/types/knowledge-connector";
import { ServiceNowConnector, stripHtmlTags } from "./servicenow-connector";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("ServiceNowConnector", () => {
  let connector: ServiceNowConnector;

  const validConfig = {
    instanceUrl: "https://myinstance.service-now.com",
  };

  const credentials = {
    email: "admin",
    apiToken: "password123",
  };

  const bearerCredentials = {
    apiToken: "oauth-token-value",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    connector = new ServiceNowConnector();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("validateConfig", () => {
    test("returns valid for correct config", async () => {
      const result = await connector.validateConfig(validConfig);
      expect(result).toEqual({ valid: true });
    });

    test("returns invalid when instanceUrl is missing", async () => {
      const result = await connector.validateConfig({});
      expect(result.valid).toBe(false);
      expect(result.error).toContain("instanceUrl");
    });

    test("returns invalid when instanceUrl uses unsupported protocol", async () => {
      const result = await connector.validateConfig({
        instanceUrl: "ftp://myinstance.service-now.com",
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("valid HTTP(S) URL");
    });

    test("accepts URL without protocol by prepending https://", async () => {
      const result = await connector.validateConfig({
        instanceUrl: "myinstance.service-now.com",
      });
      expect(result).toEqual({ valid: true });
    });

    test("accepts config with optional fields", async () => {
      const result = await connector.validateConfig({
        instanceUrl: "https://myinstance.service-now.com",
        states: ["1", "2"],
        assignmentGroups: ["group1"],
        batchSize: 100,
      });
      expect(result).toEqual({ valid: true });
    });
  });

  describe("testConnection", () => {
    test("returns success when API responds OK", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ result: [] }), { status: 200 }),
      );

      const result = await connector.testConnection({
        config: validConfig,
        credentials,
      });

      expect(result).toEqual({ success: true });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("service-now.com");
      expect(url).toContain("incident");
    });

    test("returns error when API responds with error status", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response("Unauthorized", { status: 401 }),
      );

      const result = await connector.testConnection({
        config: validConfig,
        credentials,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("401");
    });

    test("returns error for invalid config", async () => {
      const result = await connector.testConnection({
        config: {},
        credentials,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid ServiceNow configuration");
    });

    test("uses basic auth when email is provided", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ result: [] }), { status: 200 }),
      );

      await connector.testConnection({
        config: validConfig,
        credentials,
      });

      const options = mockFetch.mock.calls[0][1] as RequestInit;
      const authHeader = (options.headers as Record<string, string>)
        .Authorization;
      expect(authHeader).toMatch(/^Basic /);
    });

    test("uses bearer token when email is not provided", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ result: [] }), { status: 200 }),
      );

      await connector.testConnection({
        config: validConfig,
        credentials: bearerCredentials,
      });

      const options = mockFetch.mock.calls[0][1] as RequestInit;
      const authHeader = (options.headers as Record<string, string>)
        .Authorization;
      expect(authHeader).toBe("Bearer oauth-token-value");
    });
  });

  describe("sync", () => {
    function makeIncident(
      sysId: string,
      title: string,
      description = "<p>Incident description</p>",
    ) {
      return {
        sys_id: { display_value: sysId, value: sysId },
        number: { display_value: `INC${sysId}`, value: `INC${sysId}` },
        short_description: { display_value: title, value: title },
        description: { display_value: description, value: description },
        state: { display_value: "New", value: "1" },
        priority: { display_value: "3 - Moderate", value: "3" },
        urgency: { display_value: "2 - Medium", value: "2" },
        impact: { display_value: "2 - Medium", value: "2" },
        category: { display_value: "Network", value: "network" },
        assignment_group: {
          display_value: "IT Support",
          value: "group-sys-id",
        },
        assigned_to: {
          display_value: "John Doe",
          value: "user-sys-id",
        },
        caller_id: {
          display_value: "Jane Smith",
          value: "caller-sys-id",
        },
        opened_at: {
          display_value: "2024-01-10 08:00:00",
          value: "2024-01-10 08:00:00",
        },
        resolved_at: { display_value: "", value: "" },
        closed_at: { display_value: "", value: "" },
        sys_updated_on: {
          display_value: "2024-01-15 10:00:00",
          value: "2024-01-15 10:00:00",
        },
        sys_created_on: {
          display_value: "2024-01-10 08:00:00",
          value: "2024-01-10 08:00:00",
        },
        active: { display_value: "true", value: "true" },
      };
    }

    test("yields batch of documents from API results", async () => {
      const incidents = [
        makeIncident("001", "Server Down"),
        makeIncident("002", "Network Issue"),
      ];

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ result: incidents }), { status: 200 }),
      );

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      expect(batches[0].documents).toHaveLength(2);
      expect(batches[0].documents[0].id).toBe("001");
      expect(batches[0].documents[0].title).toBe("Server Down");
      expect(batches[0].documents[1].id).toBe("002");
      expect(batches[0].hasMore).toBe(false);
    });

    test("paginates through multiple pages", async () => {
      const page1 = Array.from({ length: 50 }, (_, i) =>
        makeIncident(`${i + 1}`, `Incident ${i + 1}`),
      );
      const page2 = [makeIncident("51", "Incident 51")];

      mockFetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ result: page1 }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ result: page2 }), { status: 200 }),
        );

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(2);
      expect(batches[0].documents).toHaveLength(50);
      expect(batches[0].hasMore).toBe(true);
      expect(batches[1].documents).toHaveLength(1);
      expect(batches[1].hasMore).toBe(false);
    });

    test("incremental sync uses checkpoint lastSyncedAt", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ result: [] }), { status: 200 }),
      );

      const batches = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: { lastSyncedAt: "2024-01-10T00:00:00.000Z" },
      })) {
        batches.push(batch);
      }

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("sys_updated_on");
      expect(url).toContain("2024-01-10");
    });

    test("filters by state values", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ result: [] }), { status: 200 }),
      );

      const batches = [];
      for await (const batch of connector.sync({
        config: {
          ...validConfig,
          states: ["1", "2"],
        },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const url = decodeURIComponent(mockFetch.mock.calls[0][0] as string);
      expect(url).toContain("state=1");
      expect(url).toContain("state=2");
    });

    test("filters by assignment group sys_ids", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ result: [] }), { status: 200 }),
      );

      const batches = [];
      for await (const batch of connector.sync({
        config: {
          ...validConfig,
          assignmentGroups: ["group1"],
        },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const url = decodeURIComponent(mockFetch.mock.calls[0][0] as string);
      expect(url).toContain("assignment_group=group1");
    });

    test("syncs all incidents by default (no active filter)", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ result: [] }), { status: 200 }),
      );

      const batches = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const url = decodeURIComponent(mockFetch.mock.calls[0][0] as string);
      expect(url).not.toContain("active=true");
    });

    test("converts HTML description to plain text", async () => {
      const incidents = [
        makeIncident(
          "1",
          "HTML Incident",
          "<h1>Title</h1><p>Paragraph with <strong>bold</strong> text.</p>",
        ),
      ];

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ result: incidents }), { status: 200 }),
      );

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const content = batches[0].documents[0].content;
      expect(content).toContain("Paragraph with bold text.");
      expect(content).not.toContain("<strong>");
      expect(content).not.toContain("<p>");
    });

    test("builds source URL correctly", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ result: [makeIncident("123", "Test Incident")] }),
          { status: 200 },
        ),
      );

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents[0].sourceUrl).toBe(
        "https://myinstance.service-now.com/incident.do?sys_id=123",
      );
    });

    test("includes metadata in documents", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ result: [makeIncident("123", "Test Incident")] }),
          { status: 200 },
        ),
      );

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const metadata = batches[0].documents[0].metadata;
      expect(metadata.sysId).toBe("123");
      expect(metadata.number).toBe("INC123");
      expect(metadata.state).toBe("New");
      expect(metadata.priority).toBe("3 - Moderate");
      expect(metadata.urgency).toBe("2 - Medium");
      expect(metadata.impact).toBe("2 - Medium");
      expect(metadata.category).toBe("Network");
      expect(metadata.assignmentGroup).toBe("IT Support");
      expect(metadata.assignedTo).toBe("John Doe");
      expect(metadata.caller).toBe("Jane Smith");
      expect(metadata.active).toBe(true);
    });

    test("checkpoint stores lastSyncedAt from last incident", async () => {
      const incidents = [
        makeIncident("001", "First Incident"),
        {
          ...makeIncident("002", "Second Incident"),
          sys_updated_on: {
            display_value: "2024-06-20 11:30:00",
            value: "2024-06-20 11:30:00",
          },
        },
      ];

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ result: incidents }), { status: 200 }),
      );

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const checkpoint = batches[0].checkpoint as {
        lastSyncedAt?: string;
      };
      expect(checkpoint.lastSyncedAt).toBeDefined();
    });

    test("checkpoint preserves previous value when batch has no incidents", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ result: [] }), { status: 200 }),
      );

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: {
          type: "servicenow",
          lastSyncedAt: "2024-01-10T00:00:00.000Z",
        },
      })) {
        batches.push(batch);
      }

      const checkpoint = batches[0].checkpoint as {
        lastSyncedAt?: string;
      };
      expect(checkpoint.lastSyncedAt).toBe("2024-01-10T00:00:00.000Z");
    });

    test("throws on API error", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response("Bad Request", { status: 400 }),
      );

      const generator = connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      });

      await expect(generator.next()).rejects.toThrow();
    });

    test("respects custom batchSize", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ result: [] }), { status: 200 }),
      );

      const batches = [];
      for await (const batch of connector.sync({
        config: { ...validConfig, batchSize: 10 },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("sysparm_limit=10");
    });

    test("applies default 6-month initial sync window when no checkpoint", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ result: [] }), { status: 200 }),
      );

      const batches = [];
      for await (const batch of connector.sync({
        config: validConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const url = decodeURIComponent(mockFetch.mock.calls[0][0] as string);
      expect(url).toContain("sys_updated_on>");
      // Should contain a date roughly 6 months ago
      const match = url.match(/sys_updated_on>(\d{4}-\d{2}-\d{2})/);
      expect(match).toBeTruthy();
      const syncDate = new Date(match?.[1] as string);
      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
      // Allow 1 day tolerance
      expect(
        Math.abs(syncDate.getTime() - sixMonthsAgo.getTime()),
      ).toBeLessThan(86400000 * 2);
    });

    test("respects custom initialSyncMonths", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ result: [] }), { status: 200 }),
      );

      const batches = [];
      for await (const batch of connector.sync({
        config: { ...validConfig, initialSyncMonths: 3 },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const url = decodeURIComponent(mockFetch.mock.calls[0][0] as string);
      const match = url.match(/sys_updated_on>(\d{4}-\d{2}-\d{2})/);
      expect(match).toBeTruthy();
      const syncDate = new Date(match?.[1] as string);
      const threeMonthsAgo = new Date();
      threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
      expect(
        Math.abs(syncDate.getTime() - threeMonthsAgo.getTime()),
      ).toBeLessThan(86400000 * 2);
    });

    test("applies custom encoded query", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ result: [] }), { status: 200 }),
      );

      const batches = [];
      for await (const batch of connector.sync({
        config: {
          ...validConfig,
          query: "short_descriptionLIKEnetwork",
        },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const url = decodeURIComponent(mockFetch.mock.calls[0][0] as string);
      expect(url).toContain("short_descriptionLIKEnetwork");
    });
  });

  describe("stripHtmlTags", () => {
    test("strips simple HTML tags", () => {
      expect(stripHtmlTags("<p>Hello world</p>")).toBe("Hello world");
    });

    test("handles nested tags", () => {
      const html = "<p>Text with <strong>bold</strong> and <em>italic</em></p>";
      expect(stripHtmlTags(html)).toBe("Text with bold and italic");
    });

    test("replaces block elements with newlines", () => {
      const html = "<p>First</p><p>Second</p>";
      const result = stripHtmlTags(html);
      expect(result).toContain("First");
      expect(result).toContain("Second");
      expect(result).toContain("\n");
    });

    test("decodes HTML entities", () => {
      expect(stripHtmlTags("&amp; &lt; &gt; &quot; &#39;")).toBe("& < > \" '");
    });

    test("returns empty string for empty input", () => {
      expect(stripHtmlTags("")).toBe("");
    });
  });
});

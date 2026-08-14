import { vi } from "vitest";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { ConnectorSyncBatch, PermissionSyncParams } from "@/types";
import { ServiceNowConnector } from "./servicenow-connector";

// Mock global fetch. The config's `unstubGlobals` removes stubs after every
// test, so re-apply before each one; the top-level stub covers import time.
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);
beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

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

    test("accepts config with entity toggle flags", async () => {
      const result = await connector.validateConfig({
        instanceUrl: "https://myinstance.service-now.com",
        includeIncidents: true,
        includeChanges: true,
        includeChangeRequests: true,
        includeProblems: true,
        includeBusinessApps: true,
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
      expect(url).toContain("sys_created_on");
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
      expect(metadata.kind).toBe("incident");
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
      expect(url).toContain("sys_created_on>");
      // Should contain a date roughly 6 months ago
      const match = url.match(/sys_created_on>(\d{4}-\d{2}-\d{2})/);
      expect(match).toBeTruthy();
      const syncDate = new Date(match?.[1] as string);
      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
      // Allow 1 day tolerance
      expect(
        Math.abs(syncDate.getTime() - sixMonthsAgo.getTime()),
      ).toBeLessThan(86400000 * 2);
    });

    test("respects custom syncDataForLastMonths", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ result: [] }), { status: 200 }),
      );

      const batches = [];
      for await (const batch of connector.sync({
        config: { ...validConfig, syncDataForLastMonths: 3 },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const url = decodeURIComponent(mockFetch.mock.calls[0][0] as string);
      const match = url.match(/sys_created_on>(\d{4}-\d{2}-\d{2})/);
      expect(match).toBeTruthy();
      const syncDate = new Date(match?.[1] as string);
      const threeMonthsAgo = new Date();
      threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
      expect(
        Math.abs(syncDate.getTime() - threeMonthsAgo.getTime()),
      ).toBeLessThan(86400000 * 2);
    });
  });

  describe("sync - change requests", () => {
    function makeChangeRequest(sysId: string, title: string) {
      return {
        sys_id: { display_value: sysId, value: sysId },
        number: { display_value: `CHG${sysId}`, value: `CHG${sysId}` },
        short_description: { display_value: title, value: title },
        description: {
          display_value: "Change description",
          value: "Change description",
        },
        state: { display_value: "New", value: "1" },
        priority: { display_value: "3 - Moderate", value: "3" },
        urgency: { display_value: "2 - Medium", value: "2" },
        impact: { display_value: "2 - Medium", value: "2" },
        category: { display_value: "Software", value: "software" },
        assignment_group: {
          display_value: "Change Team",
          value: "chg-group-id",
        },
        assigned_to: { display_value: "Alice", value: "alice-id" },
        opened_at: {
          display_value: "2024-01-10 08:00:00",
          value: "2024-01-10 08:00:00",
        },
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
        risk: { display_value: "Moderate", value: "3" },
        type: { display_value: "Standard", value: "standard" },
        close_code: { display_value: "", value: "" },
        reason: { display_value: "Upgrade needed", value: "Upgrade needed" },
        start_date: {
          display_value: "2024-02-01 00:00:00",
          value: "2024-02-01 00:00:00",
        },
        end_date: {
          display_value: "2024-02-05 00:00:00",
          value: "2024-02-05 00:00:00",
        },
        requested_by: { display_value: "Bob", value: "bob-id" },
      };
    }

    test("syncs change requests when includeChanges is true", async () => {
      const changes = [makeChangeRequest("c01", "Deploy v2")];

      // First call: incidents (empty), Second call: change_requests
      mockFetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ result: [] }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ result: changes }), { status: 200 }),
        );

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { ...validConfig, includeChanges: true },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      // 2 batches: empty incidents + 1 change request
      expect(batches).toHaveLength(2);
      const changeBatch = batches[1];
      expect(changeBatch.documents).toHaveLength(1);
      expect(changeBatch.documents[0].id).toBe("c01");
      expect(changeBatch.documents[0].metadata.kind).toBe("change_request");
      expect(changeBatch.documents[0].metadata.risk).toBe("Moderate");
      expect(changeBatch.documents[0].metadata.requestedBy).toBe("Bob");
      expect(changeBatch.documents[0].sourceUrl).toContain("change_request.do");

      // Verify the API was called with change_request table
      const changeUrl = mockFetch.mock.calls[1][0] as string;
      expect(changeUrl).toContain("/api/now/table/change_request");
    });

    test("skips incidents when includeIncidents is false", async () => {
      const changes = [makeChangeRequest("c01", "Deploy v2")];

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ result: changes }), { status: 200 }),
      );

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          ...validConfig,
          includeIncidents: false,
          includeChanges: true,
        },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("/api/now/table/change_request");
    });
  });

  describe("sync - change tasks", () => {
    function makeChangeTask(sysId: string, title: string) {
      return {
        sys_id: { display_value: sysId, value: sysId },
        number: { display_value: `CTASK${sysId}`, value: `CTASK${sysId}` },
        short_description: { display_value: title, value: title },
        description: {
          display_value: "Task description",
          value: "Task description",
        },
        state: { display_value: "Open", value: "1" },
        priority: { display_value: "3 - Moderate", value: "3" },
        urgency: { display_value: "2 - Medium", value: "2" },
        impact: { display_value: "2 - Medium", value: "2" },
        category: { display_value: "Software", value: "software" },
        assignment_group: { display_value: "Dev Team", value: "dev-group-id" },
        assigned_to: { display_value: "Charlie", value: "charlie-id" },
        opened_at: {
          display_value: "2024-01-10 08:00:00",
          value: "2024-01-10 08:00:00",
        },
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
        change_request: { display_value: "CHG001", value: "chg-sys-id" },
        planned_start_date: {
          display_value: "2024-02-01 00:00:00",
          value: "2024-02-01 00:00:00",
        },
        planned_end_date: {
          display_value: "2024-02-03 00:00:00",
          value: "2024-02-03 00:00:00",
        },
      };
    }

    test("syncs change tasks when includeChangeRequests is true", async () => {
      const tasks = [makeChangeTask("ct01", "Update DB schema")];

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ result: tasks }), { status: 200 }),
      );

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          ...validConfig,
          includeIncidents: false,
          includeChangeRequests: true,
        },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      expect(batches[0].documents[0].metadata.kind).toBe("change_task");
      expect(batches[0].documents[0].metadata.changeRequest).toBe("CHG001");
      expect(batches[0].documents[0].metadata.plannedStartDate).toBe(
        "2024-02-01 00:00:00",
      );
      expect(batches[0].documents[0].sourceUrl).toContain("change_task.do");
    });
  });

  describe("sync - problems", () => {
    function makeProblem(sysId: string, title: string) {
      return {
        sys_id: { display_value: sysId, value: sysId },
        number: { display_value: `PRB${sysId}`, value: `PRB${sysId}` },
        short_description: { display_value: title, value: title },
        description: {
          display_value: "Problem description",
          value: "Problem description",
        },
        state: { display_value: "New", value: "1" },
        priority: { display_value: "2 - High", value: "2" },
        urgency: { display_value: "1 - High", value: "1" },
        impact: { display_value: "1 - High", value: "1" },
        category: { display_value: "Hardware", value: "hardware" },
        assignment_group: {
          display_value: "Infra Team",
          value: "infra-group-id",
        },
        assigned_to: { display_value: "Diana", value: "diana-id" },
        opened_at: {
          display_value: "2024-01-10 08:00:00",
          value: "2024-01-10 08:00:00",
        },
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
        known_error: { display_value: "true", value: "true" },
        first_reported_by_task: {
          display_value: "INC001",
          value: "inc-sys-id",
        },
        opened_by: { display_value: "Eve", value: "eve-id" },
      };
    }

    test("syncs problems when includeProblems is true", async () => {
      const problems = [makeProblem("p01", "Recurring outage")];

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ result: problems }), { status: 200 }),
      );

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          ...validConfig,
          includeIncidents: false,
          includeProblems: true,
        },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      expect(batches[0].documents[0].metadata.kind).toBe("problem");
      expect(batches[0].documents[0].metadata.knownError).toBe("true");
      expect(batches[0].documents[0].metadata.openedBy).toBe("Eve");
      expect(batches[0].documents[0].sourceUrl).toContain("problem.do");
    });
  });

  describe("sync - business apps", () => {
    function makeBusinessApp(sysId: string, name: string) {
      return {
        sys_id: { display_value: sysId, value: sysId },
        name: { display_value: name, value: name },
        short_description: {
          display_value: "A business app",
          value: "A business app",
        },
        version: { display_value: "2.1.0", value: "2.1.0" },
        vendor: { display_value: "Acme Corp", value: "Acme Corp" },
        operational_status: { display_value: "Operational", value: "1" },
        install_status: { display_value: "Installed", value: "1" },
        sys_updated_on: {
          display_value: "2024-01-15 10:00:00",
          value: "2024-01-15 10:00:00",
        },
        sys_created_on: {
          display_value: "2024-01-10 08:00:00",
          value: "2024-01-10 08:00:00",
        },
      };
    }

    test("syncs business apps when includeBusinessApps is true", async () => {
      const apps = [makeBusinessApp("ba01", "CRM System")];

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ result: apps }), { status: 200 }),
      );

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          ...validConfig,
          includeIncidents: false,
          includeBusinessApps: true,
        },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      const doc = batches[0].documents[0];
      expect(doc.title).toBe("CRM System");
      expect(doc.metadata.kind).toBe("cmdb_ci_business_app");
      expect(doc.metadata.vendor).toBe("Acme Corp");
      expect(doc.metadata.version).toBe("2.1.0");
      expect(doc.metadata.operationalStatus).toBe("Operational");
      expect(doc.sourceUrl).toContain("cmdb_ci_business_app.do");

      // Verify the API was called with cmdb_ci_business_app table
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("/api/now/table/cmdb_ci_business_app");
    });

    test("business apps do not include states or assignment group filters", async () => {
      const apps = [makeBusinessApp("ba01", "CRM System")];

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ result: apps }), { status: 200 }),
      );

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          ...validConfig,
          includeIncidents: false,
          includeBusinessApps: true,
          states: ["1", "2"],
          assignmentGroups: ["group1"],
        },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const url = decodeURIComponent(mockFetch.mock.calls[0][0] as string);
      expect(url).not.toContain("state=");
      expect(url).not.toContain("assignment_group=");
    });
  });

  describe("sync - multiple entities", () => {
    test("syncs multiple entity types sequentially", async () => {
      const incident = {
        sys_id: { display_value: "i01", value: "i01" },
        number: { display_value: "INC001", value: "INC001" },
        short_description: {
          display_value: "An incident",
          value: "An incident",
        },
        description: { display_value: "Desc", value: "Desc" },
        state: { display_value: "New", value: "1" },
        priority: { display_value: "3", value: "3" },
        urgency: { display_value: "2", value: "2" },
        impact: { display_value: "2", value: "2" },
        category: { display_value: "Net", value: "net" },
        assignment_group: { display_value: "IT", value: "it-id" },
        assigned_to: { display_value: "John", value: "john-id" },
        caller_id: { display_value: "Jane", value: "jane-id" },
        opened_at: { display_value: "2024-01-10", value: "2024-01-10" },
        resolved_at: { display_value: "", value: "" },
        closed_at: { display_value: "", value: "" },
        sys_updated_on: { display_value: "2024-01-15", value: "2024-01-15" },
        sys_created_on: { display_value: "2024-01-10", value: "2024-01-10" },
        active: { display_value: "true", value: "true" },
      };

      const problem = {
        ...incident,
        sys_id: { display_value: "p01", value: "p01" },
        number: { display_value: "PRB001", value: "PRB001" },
        short_description: { display_value: "A problem", value: "A problem" },
        known_error: { display_value: "false", value: "false" },
        first_reported_by_task: { display_value: "", value: "" },
        opened_by: { display_value: "Eve", value: "eve-id" },
      };

      // Incident fetch, then problem fetch
      mockFetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ result: [incident] }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ result: [problem] }), { status: 200 }),
        );

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { ...validConfig, includeProblems: true },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(2);
      expect(batches[0].documents[0].metadata.kind).toBe("incident");
      expect(batches[0].hasMore).toBe(true); // more entities to come
      expect(batches[1].documents[0].metadata.kind).toBe("problem");
      expect(batches[1].hasMore).toBe(false);

      // Verify correct tables were called
      const urls = mockFetch.mock.calls.map((c) => c[0] as string);
      expect(urls[0]).toContain("/api/now/table/incident");
      expect(urls[1]).toContain("/api/now/table/problem");
    });
  });

  describe("estimateTotalItems", () => {
    test("sums counts across enabled entities", async () => {
      // Incident count
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ result: [] }), {
          status: 200,
          headers: { "X-Total-Count": "10" },
        }),
      );
      // Problem count
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ result: [] }), {
          status: 200,
          headers: { "X-Total-Count": "5" },
        }),
      );

      const result = await connector.estimateTotalItems({
        config: { ...validConfig, includeProblems: true },
        credentials,
        checkpoint: null,
      });

      expect(result).toBe(15);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("permission sync", () => {
    const HOST = "myinstance.service-now.com";

    type SnRoute = (query: string) => unknown[] | { status: number };

    /** Route-table fetch stub: table name → rows (or an HTTP error). */
    function installPermissionFetch(routes: Record<string, SnRoute>) {
      mockFetch.mockImplementation(async (input: unknown) => {
        const url = new URL(String(input));
        const match = url.pathname.match(/\/api\/now\/table\/([^/?]+)/);
        const table = match?.[1] ?? "";
        const rawQuery = url.searchParams.get("sysparm_query") ?? "";
        const query = rawQuery.replace(/\^?ORDERBYsys_id$/, "");
        const route = routes[table];
        if (!route) {
          return {
            ok: false,
            status: 404,
            text: async () => `no route for table ${table}`,
          };
        }
        const result = route(query);
        if (!Array.isArray(result)) {
          return {
            ok: false,
            status: result.status,
            text: async () => "error",
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ result }),
          headers: new Headers(),
        };
      });
    }

    function makeReadback(
      docs: { sourceId: string; metadata: Record<string, unknown> }[],
    ) {
      return vi.fn(
        async (opts: {
          metadataFilter?: Record<string, string>;
          afterId?: string | null;
          limit: number;
        }) => ({
          documents: docs.filter((doc) =>
            Object.entries(opts.metadataFilter ?? {}).every(
              ([key, value]) => doc.metadata[key] === value,
            ),
          ),
          nextAfterId: null,
        }),
      );
    }

    function makeParams(overrides?: {
      config?: Record<string, unknown>;
      docs?: { sourceId: string; metadata: Record<string, unknown> }[];
      cursor?: string | null;
      resolveMappedEmail?: (accountId: string) => string | null;
    }) {
      return {
        config: { ...validConfig, ...overrides?.config },
        credentials,
        cursor: overrides?.cursor ?? null,
        readIngestedDocuments: makeReadback(overrides?.docs ?? []),
        resolveMappedEmail: overrides?.resolveMappedEmail,
      } as unknown as PermissionSyncParams;
    }

    async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
      const items: T[] = [];
      for await (const item of gen) items.push(item);
      return items;
    }

    const ref = (value: string) => ({ value, link: "https://x" });
    const userRow = (sysId: string, email: string, active = "true") => ({
      sys_id: sysId,
      email,
      name: `Name ${sysId}`,
      active,
    });

    const incidentDocs = [
      { sourceId: "I1", metadata: { kind: "incident", sysId: "I1" } },
      { sourceId: "I2", metadata: { kind: "incident", sysId: "I2" } },
    ];

    const incidentParticipantRoutes: Record<string, SnRoute> = {
      incident: () => [
        {
          sys_id: "I1",
          assignment_group: ref("G1"),
          assigned_to: ref("U2"),
          caller_id: ref("U1"),
          opened_by: "",
        },
        {
          sys_id: "I2",
          assignment_group: "",
          assigned_to: "",
          caller_id: "",
          opened_by: ref("U3"),
        },
      ],
      sys_user: () => [
        userRow("U1", "u1@example.com"),
        userRow("U2", "u2@example.com"),
        userRow("U3", "u3@example.com"),
      ],
    };

    test("assigns records to per-group containers with participant exception users", async () => {
      installPermissionFetch(incidentParticipantRoutes);

      const yields = await collect(
        connector.syncPermissionSnapshot(makeParams({ docs: incidentDocs })),
      );

      expect(yields).toEqual([
        {
          kind: "container",
          containerKey: "table:incident",
          permissions: { isPublic: false, users: [], groups: [] },
          audienceResolutionFailed: false,
          cursor: "table:incident",
        },
        {
          kind: "container",
          containerKey: "table:incident/groups:G1",
          permissions: {
            isPublic: false,
            users: [],
            groups: [`${HOST}/group/G1`],
          },
          audienceResolutionFailed: false,
          cursor: "table:incident",
        },
        {
          kind: "document",
          sourceId: "I1",
          containerKey: "table:incident/groups:G1",
          exceptionUsers: ["u1@example.com", "u2@example.com"],
          cursor: "table:incident",
        },
        {
          kind: "document",
          sourceId: "I2",
          containerKey: "table:incident",
          exceptionUsers: ["u3@example.com"],
          cursor: "table:incident",
        },
      ]);
    });

    test("declared role audiences join the table and group containers", async () => {
      installPermissionFetch(incidentParticipantRoutes);

      const yields = await collect(
        connector.syncPermissionSnapshot(
          makeParams({
            config: { roleAudiences: { incident: ["itil"] } },
            docs: incidentDocs,
          }),
        ),
      );

      const containers = yields.filter((y) => y.kind === "container");
      expect(containers[0].permissions.groups).toEqual([`${HOST}/role/itil`]);
      expect(containers[1].permissions.groups).toEqual([
        `${HOST}/group/G1`,
        `${HOST}/role/itil`,
      ]);
    });

    test("participants without a resolvable email are dropped fail-closed", async () => {
      installPermissionFetch({
        ...incidentParticipantRoutes,
        sys_user: () => [
          userRow("U1", ""),
          userRow("U2", "u2@example.com", "false"),
          userRow("U3", "u3@example.com"),
        ],
      });

      const yields = await collect(
        connector.syncPermissionSnapshot(makeParams({ docs: incidentDocs })),
      );

      const docs = yields.filter((y) => y.kind === "document");
      // U1 hides its email, U2 is inactive: neither may ride as an exception.
      expect(docs[0].exceptionUsers).toEqual([]);
      expect(docs[1].exceptionUsers).toEqual(["u3@example.com"]);
    });

    test("an empty corpus yields only the boundary container", async () => {
      installPermissionFetch(incidentParticipantRoutes);

      const yields = await collect(
        connector.syncPermissionSnapshot(makeParams({ docs: [] })),
      );

      expect(yields).toEqual([
        {
          kind: "container",
          containerKey: "table:incident",
          permissions: { isPublic: false, users: [], groups: [] },
          audienceResolutionFailed: false,
          cursor: "table:incident",
        },
      ]);
    });

    test("resumes after the cursor container (kb keys sort before table keys)", async () => {
      installPermissionFetch(incidentParticipantRoutes);

      const yields = await collect(
        connector.syncPermissionSnapshot(
          makeParams({
            config: { includeChanges: true },
            docs: incidentDocs,
            cursor: "table:incident",
          }),
        ),
      );

      // change_request < incident: strictly-below keys are skipped, the
      // cursor container re-enumerates.
      expect(
        yields.filter((y) => y.kind === "container").map((y) => y.containerKey),
      ).toEqual(["table:incident", "table:incident/groups:G1"]);
    });

    const kbConfig = {
      includeIncidents: false,
      includeKnowledgeArticles: true,
    };
    const articleDocs = [
      {
        sourceId: "A1",
        metadata: { kind: "kb_knowledge", sysId: "A1", knowledgeBaseId: "KB1" },
      },
      {
        sourceId: "A2",
        metadata: { kind: "kb_knowledge", sysId: "A2", knowledgeBaseId: "KB1" },
      },
    ];

    function kbRoutes(
      overrides?: Record<string, SnRoute>,
    ): Record<string, SnRoute> {
      return {
        sys_properties: () => [
          {
            name: "glide.knowman.apply_article_read_criteria",
            value: "true",
          },
          {
            name: "glide.knowman.block_access_with_no_user_criteria",
            value: "false",
          },
        ],
        kb_uc_can_read_mtom: (query) =>
          query.includes("KB1")
            ? [{ kb_knowledge_base: ref("KB1"), user_criteria: ref("C1") }]
            : [],
        kb_uc_cannot_read_mtom: () => [],
        user_criteria: () => [
          {
            sys_id: "C1",
            name: "KB readers",
            active: "true",
            advanced: "false",
            user: "U1,U2",
            group: "",
            role: "",
            company: "",
            department: "",
            location: "",
            match_all: "false",
          },
        ],
        sys_user: () => [
          userRow("U1", "u1@example.com"),
          userRow("U2", "u2@example.com"),
          userRow("U3", "u3@example.com"),
        ],
        ...overrides,
      };
    }

    test("knowledge bases audience through criteria groups", async () => {
      installPermissionFetch(kbRoutes());

      const yields = await collect(
        connector.syncPermissionSnapshot(
          makeParams({ config: kbConfig, docs: articleDocs }),
        ),
      );

      expect(yields).toEqual([
        {
          kind: "container",
          containerKey: "kb:KB1",
          permissions: {
            isPublic: false,
            users: [],
            groups: [`${HOST}/criteria/C1`],
          },
          audienceResolutionFailed: false,
          cursor: "kb:KB1",
        },
        {
          kind: "document",
          sourceId: "A1",
          containerKey: "kb:KB1",
          cursor: "kb:KB1",
        },
        {
          kind: "document",
          sourceId: "A2",
          containerKey: "kb:KB1",
          cursor: "kb:KB1",
        },
      ]);
    });

    test("deny criteria materialize the concrete allow-minus-deny user set", async () => {
      installPermissionFetch(
        kbRoutes({
          kb_uc_cannot_read_mtom: (query) =>
            query.includes("KB1")
              ? [{ kb_knowledge_base: ref("KB1"), user_criteria: ref("C2") }]
              : [],
          user_criteria: () => [
            {
              sys_id: "C1",
              name: "KB readers",
              active: "true",
              advanced: "false",
              user: "U1,U2",
              group: "",
              role: "",
              company: "",
              department: "",
              location: "",
              match_all: "false",
            },
            {
              sys_id: "C2",
              name: "KB denied",
              active: "true",
              advanced: "false",
              user: "U2",
              group: "",
              role: "",
              company: "",
              department: "",
              location: "",
              match_all: "false",
            },
          ],
        }),
      );

      const yields = await collect(
        connector.syncPermissionSnapshot(
          makeParams({ config: kbConfig, docs: articleDocs }),
        ),
      );

      expect(yields[0]).toMatchObject({
        kind: "container",
        containerKey: "kb:KB1",
        permissions: { isPublic: false, users: ["u1@example.com"], groups: [] },
        audienceResolutionFailed: false,
      });
    });

    test("a script-based deny criteria fails the container closed", async () => {
      installPermissionFetch(
        kbRoutes({
          kb_uc_cannot_read_mtom: (query) =>
            query.includes("KB1")
              ? [{ kb_knowledge_base: ref("KB1"), user_criteria: ref("C2") }]
              : [],
          user_criteria: () => [
            {
              sys_id: "C2",
              name: "Scripted deny",
              active: "true",
              advanced: "true",
              user: "",
              group: "",
              role: "",
              company: "",
              department: "",
              location: "",
              match_all: "false",
            },
          ],
        }),
      );

      const yields = await collect(
        connector.syncPermissionSnapshot(
          makeParams({ config: kbConfig, docs: articleDocs }),
        ),
      );

      expect(yields[0]).toMatchObject({
        kind: "container",
        containerKey: "kb:KB1",
        permissions: { isPublic: false, users: [], groups: [] },
        audienceResolutionFailed: true,
      });
    });

    test("a criteria-less knowledge base is org-public when the instance allows it", async () => {
      installPermissionFetch(kbRoutes({ kb_uc_can_read_mtom: () => [] }));

      const yields = await collect(
        connector.syncPermissionSnapshot(
          makeParams({ config: kbConfig, docs: articleDocs }),
        ),
      );

      expect(yields[0]).toMatchObject({
        kind: "container",
        containerKey: "kb:KB1",
        permissions: { isPublic: true },
        audienceResolutionFailed: false,
      });
    });

    test("a criteria-less knowledge base is hidden when the instance blocks it", async () => {
      installPermissionFetch(
        kbRoutes({
          kb_uc_can_read_mtom: () => [],
          sys_properties: () => [
            {
              name: "glide.knowman.block_access_with_no_user_criteria",
              value: "true",
            },
          ],
        }),
      );

      const yields = await collect(
        connector.syncPermissionSnapshot(
          makeParams({ config: kbConfig, docs: articleDocs }),
        ),
      );

      // Genuinely nobody — blocked upstream, not a resolution failure.
      expect(yields[0]).toMatchObject({
        permissions: { isPublic: false, users: [], groups: [] },
        audienceResolutionFailed: false,
      });
    });

    test("unreadable glide.knowman properties fail criteria-less KBs closed", async () => {
      installPermissionFetch(
        kbRoutes({
          kb_uc_can_read_mtom: () => [],
          sys_properties: () => ({ status: 403 }),
        }),
      );

      const yields = await collect(
        connector.syncPermissionSnapshot(
          makeParams({ config: kbConfig, docs: articleDocs }),
        ),
      );

      expect(yields[0]).toMatchObject({
        permissions: { isPublic: false, users: [], groups: [] },
        audienceResolutionFailed: true,
      });
    });

    test("article-level can-read criteria override the KB audience in a nested container", async () => {
      installPermissionFetch(
        kbRoutes({
          kb_uc_can_read_mtom: (query) => {
            if (query.includes("KB1")) {
              return [
                { kb_knowledge_base: ref("KB1"), user_criteria: ref("C1") },
              ];
            }
            if (query.includes("A1")) {
              return [
                { kb_knowledge_base: ref("A1"), user_criteria: ref("C3") },
              ];
            }
            return [];
          },
          user_criteria: (query) => {
            const rows = [
              {
                sys_id: "C1",
                name: "KB readers",
                active: "true",
                advanced: "false",
                user: "U1,U2",
                group: "",
                role: "",
                company: "",
                department: "",
                location: "",
                match_all: "false",
              },
              {
                sys_id: "C3",
                name: "Article readers",
                active: "true",
                advanced: "false",
                user: "U3",
                group: "",
                role: "",
                company: "",
                department: "",
                location: "",
                match_all: "false",
              },
            ];
            return rows.filter((row) => query.includes(row.sys_id));
          },
        }),
      );

      const yields = await collect(
        connector.syncPermissionSnapshot(
          makeParams({ config: kbConfig, docs: articleDocs }),
        ),
      );

      expect(yields).toEqual([
        {
          kind: "container",
          containerKey: "kb:KB1",
          permissions: {
            isPublic: false,
            users: [],
            groups: [`${HOST}/criteria/C1`],
          },
          audienceResolutionFailed: false,
          cursor: "kb:KB1",
        },
        {
          kind: "container",
          containerKey: "kb:KB1/article:A1",
          permissions: {
            isPublic: false,
            users: ["u3@example.com"],
            groups: [],
          },
          audienceResolutionFailed: false,
          cursor: "kb:KB1",
        },
        {
          kind: "document",
          sourceId: "A1",
          containerKey: "kb:KB1/article:A1",
          cursor: "kb:KB1",
        },
        {
          kind: "document",
          sourceId: "A2",
          containerKey: "kb:KB1",
          cursor: "kb:KB1",
        },
      ]);
    });

    test("an unreadable criteria surface fails the whole knowledge base closed", async () => {
      installPermissionFetch(
        kbRoutes({ kb_uc_can_read_mtom: () => ({ status: 403 }) }),
      );

      const yields = await collect(
        connector.syncPermissionSnapshot(
          makeParams({ config: kbConfig, docs: articleDocs }),
        ),
      );

      expect(yields[0]).toMatchObject({
        kind: "container",
        containerKey: "kb:KB1",
        permissions: { isPublic: false, users: [], groups: [] },
        audienceResolutionFailed: true,
      });
      expect(
        yields.filter((y) => y.kind === "document").map((y) => y.containerKey),
      ).toEqual(["kb:KB1", "kb:KB1"]);
    });

    test("syncGroups rosters record groups, role audiences, criteria, and direct grants", async () => {
      installPermissionFetch({
        ...incidentParticipantRoutes,
        sys_user_group: () => [{ sys_id: "G1", name: "Service Desk" }],
        sys_user_grmember: () => [{ user: ref("U1"), group: ref("G1") }],
        sys_user_has_role: () => [{ user: ref("U2") }],
      });

      const yields = await collect(
        connector.syncGroups(
          makeParams({
            config: { roleAudiences: { incident: ["itil"] } },
            docs: incidentDocs,
          }),
        ),
      );

      expect(yields).toEqual([
        {
          groupId: `${HOST}/group/G1`,
          name: "Service Desk",
          members: [
            {
              accountId: "U1",
              displayName: "Name U1",
              email: "u1@example.com",
            },
          ],
          membershipResolutionFailed: undefined,
          cursor: `${HOST}/group/G1`,
        },
        {
          groupId: `${HOST}/role/itil`,
          name: "Role: itil",
          members: [
            {
              accountId: "U2",
              displayName: "Name U2",
              email: "u2@example.com",
            },
          ],
          membershipResolutionFailed: undefined,
          cursor: `${HOST}/role/itil`,
        },
        {
          groupId: "direct-grants",
          members: [
            {
              accountId: "U1",
              displayName: "Name U1",
              email: "u1@example.com",
            },
            {
              accountId: "U2",
              displayName: "Name U2",
              email: "u2@example.com",
            },
            {
              accountId: "U3",
              displayName: "Name U3",
              email: "u3@example.com",
            },
          ],
        },
      ]);
    });

    test("a principal referenced by user_name resolves against user_name", async () => {
      // Some ServiceNow fields carry the account's user_name, not a sys_id.
      installPermissionFetch({
        incident: () => [
          {
            sys_id: "I1",
            assignment_group: "",
            assigned_to: "",
            caller_id: "glide.maint",
            opened_by: "",
          },
        ],
        sys_user: (query) =>
          query.startsWith("user_nameIN")
            ? [
                {
                  sys_id: "U_MAINT",
                  user_name: "glide.maint",
                  email: "maint@example.com",
                  name: "System Maintenance",
                  active: "true",
                },
              ]
            : [],
      });

      const yields = await collect(
        connector.syncPermissionSnapshot(
          makeParams({ docs: [incidentDocs[0]] }),
        ),
      );

      const doc = yields.find((y) => y.kind === "document");
      expect(doc?.exceptionUsers).toEqual(["maint@example.com"]);
    });

    test("an unresolvable principal keeps the display name its record carried", async () => {
      // sys_user is unreadable (row-level ACL), so the only label these
      // principals will ever have is the display value on the reference.
      const named = (value: string, display: string) => ({
        display_value: display,
        value,
        link: "https://x",
      });
      installPermissionFetch({
        incident: () => [
          {
            sys_id: named("I1", "INC0001"),
            assignment_group: named("G1", "Service Desk"),
            assigned_to: named("U2", "Bob Builder"),
            caller_id: named("U1", "Alice Adams"),
            opened_by: "",
          },
        ],
        sys_user: () => [],
        sys_user_group: () => [{ sys_id: "G1", name: "Service Desk" }],
        sys_user_grmember: () => [
          {
            user: named("U1", "Alice Adams"),
            group: named("G1", "Service Desk"),
          },
        ],
      });

      const yields = await collect(
        connector.syncGroups(makeParams({ docs: [incidentDocs[0]] })),
      );

      expect(yields[0].members).toEqual([
        { accountId: "U1", displayName: "Alice Adams", email: null },
      ]);
      const direct = yields.find((y) => y.groupId === "direct-grants");
      expect(direct?.members).toEqual([
        { accountId: "U1", displayName: "Alice Adams", email: null },
        { accountId: "U2", displayName: "Bob Builder", email: null },
      ]);
    });

    test("an unreadable criteria surface does not abort the other group rosters", async () => {
      installPermissionFetch({
        ...incidentParticipantRoutes,
        sys_user_group: () => [{ sys_id: "G1", name: "Service Desk" }],
        sys_user_grmember: () => [{ user: ref("U1"), group: ref("G1") }],
        sys_user_has_role: () => [{ user: ref("U2") }],
        sys_properties: () => [],
        kb_uc_can_read_mtom: () => ({ status: 403 }),
        kb_uc_cannot_read_mtom: () => ({ status: 403 }),
      });

      const yields = await collect(
        connector.syncGroups(
          makeParams({
            config: {
              includeKnowledgeArticles: true,
              roleAudiences: { incident: ["itil"] },
            },
            docs: [...incidentDocs, ...articleDocs],
          }),
        ),
      );

      // Criteria groups are lost (their KBs fail closed on the snapshot
      // side), but the record groups, role audiences, and direct grants
      // still roster.
      expect(yields.map((y) => y.groupId)).toEqual([
        `${HOST}/group/G1`,
        `${HOST}/role/itil`,
        "direct-grants",
      ]);
      expect(yields[0].members).toHaveLength(1);
      expect(yields[1].members).toHaveLength(1);
    });

    test("a match_all criteria group rosters the dimension intersection", async () => {
      installPermissionFetch(
        kbRoutes({
          user_criteria: () => [
            {
              sys_id: "C1",
              name: "Both",
              active: "true",
              advanced: "false",
              user: "U1,U2",
              group: "G9",
              role: "",
              company: "",
              department: "",
              location: "",
              match_all: "true",
            },
          ],
          sys_user_grmember: () => [
            { user: ref("U2"), group: ref("G9") },
            { user: ref("U3"), group: ref("G9") },
          ],
        }),
      );

      const yields = await collect(
        connector.syncGroups(
          makeParams({ config: kbConfig, docs: articleDocs }),
        ),
      );

      // U1 is only in the users list, U3 only in the group: match_all keeps U2.
      expect(yields).toEqual([
        {
          groupId: `${HOST}/criteria/C1`,
          name: "Both",
          members: [
            {
              accountId: "U2",
              displayName: "Name U2",
              email: "u2@example.com",
            },
          ],
          membershipResolutionFailed: undefined,
          cursor: `${HOST}/criteria/C1`,
        },
      ]);
    });

    test("scopeKeyForDocument maps metadata to its top-level container", () => {
      expect(
        connector.scopeKeyForDocument({ kind: "incident", sysId: "I1" }),
      ).toBe("table:incident");
      expect(
        connector.scopeKeyForDocument({
          kind: "kb_knowledge",
          knowledgeBaseId: "KB1",
        }),
      ).toBe("kb:KB1");
      expect(
        connector.scopeKeyForDocument({ kind: "kb_knowledge" }),
      ).toBeNull();
      expect(connector.scopeKeyForDocument({})).toBeNull();
    });
  });
});

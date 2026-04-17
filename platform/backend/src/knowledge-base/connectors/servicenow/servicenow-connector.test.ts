import { vi } from "vitest";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { ConnectorSyncBatch } from "@/types";
import { ServiceNowConnector } from "./servicenow-connector";

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
});

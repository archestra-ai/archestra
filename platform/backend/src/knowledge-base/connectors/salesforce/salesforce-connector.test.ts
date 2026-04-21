import { afterEach, describe, expect, test, vi } from "vitest";
import type { ConnectorSyncBatch } from "@/types";
import { SalesforceConnector } from "./salesforce-connector";

const fetchMock = vi.fn();

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

function mockFetchSequence(...responses: Array<Response | Promise<Response>>) {
  vi.stubGlobal("fetch", fetchMock);
  for (const response of responses) {
    fetchMock.mockResolvedValueOnce(response);
  }
}

function makeResponse(params: {
  status?: number;
  json?: unknown;
  text?: string;
}): Response {
  const status = params.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => params.json ?? {},
    text: async () => params.text ?? "",
  } as Response;
}

function makeSoapLoginSuccessResponse() {
  return makeResponse({
    status: 200,
    text: `<?xml version="1.0" encoding="UTF-8"?>
      <Envelope>
        <Body>
          <loginResponse>
            <result>
              <sessionId>session-token-123</sessionId>
              <serverUrl>https://acme.my.salesforce.com/services/Soap/u/v60.0/00Dxx0000000001</serverUrl>
            </result>
          </loginResponse>
        </Body>
      </Envelope>`,
  });
}

describe("SalesforceConnector", () => {
  test("exposes salesforce connector type", () => {
    expect(new SalesforceConnector().type).toBe("salesforce");
  });

  describe("validateConfig", () => {
    test("accepts minimal valid config", async () => {
      const connector = new SalesforceConnector();
      const result = await connector.validateConfig({});
      expect(result).toEqual({ valid: true });
    });

    test("rejects invalid advanced object JSON text", async () => {
      const connector = new SalesforceConnector();
      const result = await connector.validateConfig({
        advancedObjectConfigJson: "[1,2,3]",
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain("advancedObjectConfigJson");
    });
  });

  describe("testConnection", () => {
    test("returns success for valid credentials and lightweight query", async () => {
      const connector = new SalesforceConnector();

      mockFetchSequence(
        makeSoapLoginSuccessResponse(),
        makeResponse({
          status: 200,
          json: { done: true, totalSize: 1, records: [{ Id: "005123" }] },
        }),
      );

      const result = await connector.testConnection({
        config: {},
        credentials: { email: "test@example.com", apiToken: "token" },
      });

      expect(result.success).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(String(fetchMock.mock.calls[1]?.[0] ?? "")).toContain(
        "SELECT%20Id%20FROM%20User%20LIMIT%201",
      );
    });

    test("returns connection failure for SOAP login fault", async () => {
      const connector = new SalesforceConnector();
      mockFetchSequence(
        makeResponse({
          status: 500,
          text: `<Envelope><Body><Fault><faultstring>LOGIN_MUST_USE_SECURITY_TOKEN</faultstring></Fault></Body></Envelope>`,
        }),
      );

      const result = await connector.testConnection({
        config: {},
        credentials: { email: "test@example.com", apiToken: "bad-token" },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("LOGIN_MUST_USE_SECURITY_TOKEN");
    });
  });

  describe("sync", () => {
    test("syncs default Account object in simple mode", async () => {
      const connector = new SalesforceConnector();
      mockFetchSequence(
        makeSoapLoginSuccessResponse(),
        makeResponse({
          status: 200,
          json: {
            done: true,
            totalSize: 1,
            records: [
              {
                attributes: {
                  type: "Account",
                  url: "/services/data/v60.0/sobjects/Account/001A",
                },
                Id: "001A",
                Name: "Acme Corp",
                LastModifiedDate: "2026-04-19T10:00:00.000Z",
              },
            ],
          },
        }),
      );

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials: { email: "test@example.com", apiToken: "token" },
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].id).toBe("salesforce:Account:001A");
      expect(batches[0].documents[0].title).toBe("Acme Corp");
      expect(batches[0].checkpoint.type).toBe("salesforce");
      const cp = batches[0].checkpoint as {
        objectCursorMap?: Record<string, string>;
      };
      expect(cp.objectCursorMap?.Account).toBe("2026-04-19T10:00:00.000Z");
    });

    test("uses advanced object config fields and object list", async () => {
      const connector = new SalesforceConnector();
      mockFetchSequence(
        makeSoapLoginSuccessResponse(),
        makeResponse({
          status: 200,
          json: {
            done: true,
            totalSize: 1,
            records: [
              {
                attributes: {
                  type: "Lead",
                  url: "/services/data/v60.0/sobjects/Lead/00QA",
                },
                Id: "00QA",
                FirstName: "Ada",
                LastName: "Lovelace",
                LastModifiedDate: "2026-04-20T08:30:00.000Z",
              },
            ],
          },
        }),
      );

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          advancedObjectConfigJson: JSON.stringify({
            Lead: {
              fields: ["FirstName", "LastName"],
              associations: { Account: ["Name"] },
            },
          }),
        },
        credentials: { email: "test@example.com", apiToken: "token" },
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      const queryUrl = String(fetchMock.mock.calls[1]?.[0] ?? "");
      expect(queryUrl).toContain("FROM%20Lead");
      expect(queryUrl).toContain("FirstName");
      expect(queryUrl).toContain("LastName");
      expect(batches[0].documents[0].content).toContain("**FirstName:** Ada");
    });

    test("uses nextRecordsUrl pagination and emits multiple batches", async () => {
      const connector = new SalesforceConnector();
      mockFetchSequence(
        makeSoapLoginSuccessResponse(),
        makeResponse({
          status: 200,
          json: {
            done: false,
            totalSize: 2,
            nextRecordsUrl: "/services/data/v60.0/query/01gNEXT",
            records: [
              {
                attributes: {
                  type: "Account",
                  url: "/services/data/v60.0/sobjects/Account/001P1",
                },
                Id: "001P1",
                Name: "Page One",
                LastModifiedDate: "2026-04-20T01:00:00.000Z",
              },
            ],
          },
        }),
        makeResponse({
          status: 200,
          json: {
            done: true,
            totalSize: 2,
            records: [
              {
                attributes: {
                  type: "Account",
                  url: "/services/data/v60.0/sobjects/Account/001P2",
                },
                Id: "001P2",
                Name: "Page Two",
                LastModifiedDate: "2026-04-20T02:00:00.000Z",
              },
            ],
          },
        }),
      );

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {},
        credentials: { email: "test@example.com", apiToken: "token" },
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(2);
      expect(batches[0].hasMore).toBe(true);
      expect(batches[1].hasMore).toBe(false);
      expect(String(fetchMock.mock.calls[2]?.[0] ?? "")).toContain(
        "query/01gNEXT",
      );
    });

    test("applies incremental LastModifiedDate lower bound from checkpoint", async () => {
      const connector = new SalesforceConnector();
      mockFetchSequence(
        makeSoapLoginSuccessResponse(),
        makeResponse({
          status: 200,
          json: { done: true, totalSize: 0, records: [] },
        }),
      );

      for await (const _batch of connector.sync({
        config: { objects: ["Contact"] },
        credentials: { email: "test@example.com", apiToken: "token" },
        checkpoint: {
          type: "salesforce",
          objectCursorMap: {
            Contact: "2026-04-20T10:00:00.000Z",
          },
          lastSyncedAt: "2026-04-20T10:00:00.000Z",
        },
      })) {
        // noop
      }

      const queryUrl = String(fetchMock.mock.calls[1]?.[0] ?? "");
      expect(queryUrl).toContain("FROM%20Contact");
      expect(queryUrl).toContain("LastModifiedDate%20%3E%3D");
    });

    test("surfaces query failure with actionable message", async () => {
      const connector = new SalesforceConnector();
      mockFetchSequence(
        makeSoapLoginSuccessResponse(),
        makeResponse({
          status: 400,
          json: [{ message: "No such column 'Foo__c'" }],
        }),
      );

      const generator = connector.sync({
        config: {},
        credentials: { email: "test@example.com", apiToken: "token" },
        checkpoint: null,
      });
      await expect(generator.next()).rejects.toThrow("No such column");
    });
  });
});
